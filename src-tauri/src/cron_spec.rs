//! Linux crontab 风格的 **5 段** cron 解析与「下一次触发」计算。
//!
//! 语法：`分 时 日 月 周`（本地时间），最小粒度 1 分钟。
//! 支持 `*`、`a`、`a-b`、`*/n`、`a-b/n`、逗号列表，以及月份/星期的三字母英文名；
//! 另外支持 `@hourly` / `@daily` / `@weekly` / `@monthly` / `@yearly` 别名。
//!
//! 两条容易写错的语义（这里按 Vixie cron 实现）：
//! 1. **日与星期**：两者都受限时取「或」；任一以 `*` 开头时只看另一个。
//! 2. **星期 0 和 7 都是周日**。
//!
//! 只解析、不做 IO；测试全部是纯函数。

use chrono::{DateTime, Datelike, Days, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone};

const MONTH_NAMES: [(&str, u32); 12] = [
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];

const DOW_NAMES: [(&str, u32); 7] = [
    ("SUN", 0),
    ("MON", 1),
    ("TUE", 2),
    ("WED", 3),
    ("THU", 4),
    ("FRI", 5),
    ("SAT", 6),
];

/// 解析后的 cron。字段用 bitset 存，匹配时只看对应位。
#[derive(Debug, Clone)]
pub struct CronSpec {
    minutes: u64,
    hours: u64,
    days: u64,
    months: u64,
    weekdays: u64,
    /// 日字段是否以 `*` 开头（决定「日/星期」是或还是与）
    dom_star: bool,
    /// 星期字段是否以 `*` 开头
    dow_star: bool,
}

impl CronSpec {
    pub fn parse(expr: &str) -> Result<Self, String> {
        let raw = expr.trim();
        if raw.is_empty() {
            return Err("cron 表达式不能为空".to_string());
        }

        // 别名先展开，后面的解析只认 5 段
        if raw.starts_with('@') {
            let expanded = expand_alias(raw).ok_or_else(|| {
                format!(
                    "不支持的 cron 别名：{raw}（可用 @hourly / @daily / @weekly / @monthly / @yearly）"
                )
            })?;
            return Self::parse(expanded);
        }

        let parts: Vec<&str> = raw.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(format!(
                "cron 需要 5 段（分 时 日 月 周），当前是 {} 段：{raw}",
                parts.len()
            ));
        }

        let minutes = parse_field(parts[0], 0, 59, None, "分钟")?;
        let hours = parse_field(parts[1], 0, 23, None, "小时")?;
        let days = parse_field(parts[2], 1, 31, None, "日")?;
        let months = parse_field(parts[3], 1, 12, Some(&MONTH_NAMES), "月份")?;
        let mut weekdays = parse_field(parts[4], 0, 7, Some(&DOW_NAMES), "星期")?;

        // 7 也是周日：并到 0 上，避免匹配时两套判断
        if weekdays & (1u64 << 7) != 0 {
            weekdays = (weekdays & !(1u64 << 7)) | 1;
        }

        Ok(Self {
            minutes,
            hours,
            days,
            months,
            weekdays,
            dom_star: parts[2].starts_with('*'),
            dow_star: parts[4].starts_with('*'),
        })
    }

    /// 严格晚于 `now` 的下一次触发时刻；9 年内没有就返回 `None`。
    pub fn next_after(&self, now: DateTime<Local>) -> Option<DateTime<Local>> {
        let start = now.naive_local();
        let mut date = start.date();
        // 最长扫 9 年：覆盖 2 月 29 日的极端间隔（2096 → 2104 之间隔 8 年）
        let end = date.checked_add_days(Days::new(366 * 9))?;

        while date <= end {
            if self.day_matches(date) {
                for hour in 0..24u32 {
                    if self.hours & (1u64 << hour) == 0 {
                        continue;
                    }
                    for minute in 0..60u32 {
                        if self.minutes & (1u64 << minute) == 0 {
                            continue;
                        }
                        let Some(naive) = date.and_hms_opt(hour, minute, 0) else {
                            continue;
                        };
                        // 同一分钟不重复触发；now 的秒必须被排除
                        if naive <= start {
                            continue;
                        }
                        if let Some(dt) = resolve_local(naive, now) {
                            return Some(dt);
                        }
                    }
                }
            }
            date = date.succ_opt()?;
        }
        None
    }

    /// 接下来 `count` 次触发（最多 20 次），用于编辑器预览。
    pub fn next_n(&self, now: DateTime<Local>, count: usize) -> Vec<DateTime<Local>> {
        let mut out = Vec::new();
        let mut cursor = now;
        for _ in 0..count.clamp(1, 20) {
            match self.next_after(cursor) {
                Some(dt) => {
                    out.push(dt);
                    cursor = dt;
                }
                None => break,
            }
        }
        out
    }

    fn day_matches(&self, date: NaiveDate) -> bool {
        if self.months & (1u64 << date.month()) == 0 {
            return false;
        }

        let dom_ok = self.days & (1u64 << date.day()) != 0;
        let dow = date.weekday().num_days_from_sunday();
        let dow_ok = self.weekdays & (1u64 << dow) != 0;

        match (self.dom_star, self.dow_star) {
            // 两边都是 *：任何一天
            (true, true) => true,
            // 两边都受限：满足任意一个即可（Vixie cron 的「或」）
            (false, false) => dom_ok || dow_ok,
            // 只有一个受限：只看受限的那个
            (true, false) => dow_ok,
            (false, true) => dom_ok,
        }
    }
}

fn expand_alias(raw: &str) -> Option<&'static str> {
    match raw.to_ascii_lowercase().as_str() {
        "@hourly" => Some("0 * * * *"),
        "@daily" | "@midnight" => Some("0 0 * * *"),
        "@weekly" => Some("0 0 * * 0"),
        "@monthly" => Some("0 0 1 * *"),
        "@yearly" | "@annually" => Some("0 0 1 1 *"),
        _ => None,
    }
}

fn parse_val(tok: &str, names: Option<&[(&str, u32)]>, label: &str) -> Result<u32, String> {
    if let Ok(v) = tok.parse::<u32>() {
        return Ok(v);
    }
    if let Some(names) = names {
        let up = tok.to_ascii_uppercase();
        if let Some((_, v)) = names.iter().find(|(name, _)| *name == up) {
            return Ok(*v);
        }
    }
    Err(format!("cron {label}字段无法识别：{tok}"))
}

/// 解析一个字段成 bitset。
///
/// `*/n` 与 `a-b/n` 都支持；`5/10` 这种「单值+步长」不合法（Linux crontab 也不认）。
fn parse_field(
    field: &str,
    min: u32,
    max: u32,
    names: Option<&[(&str, u32)]>,
    label: &str,
) -> Result<u64, String> {
    let mut bits = 0u64;
    let mut any = false;

    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(format!("cron {label}字段有空项：{field}"));
        }

        let (base, step) = match part.split_once('/') {
            Some((b, s)) => {
                let step: u32 = s
                    .parse()
                    .map_err(|_| format!("cron {label}字段步长无效：{part}"))?;
                if step == 0 {
                    return Err(format!("cron {label}字段步长不能为 0：{part}"));
                }
                (b, step)
            }
            None => (part, 1),
        };

        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((a, b)) = base.split_once('-') {
            let a = parse_val(a.trim(), names, label)?;
            let b = parse_val(b.trim(), names, label)?;
            if a > b {
                return Err(format!("cron {label}范围起点大于终点：{part}"));
            }
            (a, b)
        } else {
            let v = parse_val(base.trim(), names, label)?;
            if part.contains('/') {
                return Err(format!(
                    "cron {label}不支持「单值/步长」写法：{part}（请用 * 或 a-b/n）"
                ));
            }
            (v, v)
        };

        if start < min || end > max {
            return Err(format!("cron {label}超出范围（{min}–{max}）：{part}"));
        }

        let mut v = start;
        while v <= end {
            bits |= 1u64 << v;
            any = true;
            // 防止用户写出 `*/4294967295` 这类超大步长把 u32 加溢出
            let Some(next) = v.checked_add(step) else {
                break;
            };
            v = next;
        }
    }

    if !any {
        return Err(format!("cron {label}字段为空：{field}"));
    }
    Ok(bits)
}

/// 把「本地墙上时间」解析成真实时间点。
///
/// - 夏令时前跳（`None`）：跳过这一分钟；
/// - 夏令时回拨（`Ambiguous`）：优先取晚于 `after` 的那个，避免重复触发同一墙上分钟。
fn resolve_local(naive: NaiveDateTime, after: DateTime<Local>) -> Option<DateTime<Local>> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => (dt > after).then_some(dt),
        LocalResult::Ambiguous(a, b) => {
            let (early, late) = if a <= b { (a, b) } else { (b, a) };
            if early > after {
                Some(early)
            } else if late > after {
                Some(late)
            } else {
                None
            }
        }
        LocalResult::None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .earliest()
            .expect("构造本地时间失败")
    }

    fn stamp(dt: DateTime<Local>) -> String {
        dt.format("%Y-%m-%d %H:%M").to_string()
    }

    fn next(expr: &str, from: DateTime<Local>) -> String {
        stamp(CronSpec::parse(expr).unwrap().next_after(from).unwrap())
    }

    #[test]
    fn every_minute() {
        assert_eq!(
            next("* * * * *", at(2026, 11, 12, 21, 30)),
            "2026-11-12 21:31"
        );
    }

    #[test]
    fn strict_after_skips_the_same_minute() {
        assert_eq!(
            next("0 3 * * *", at(2026, 11, 13, 3, 0)),
            "2026-11-14 03:00"
        );
    }

    #[test]
    fn daily_at_three() {
        assert_eq!(
            next("0 3 * * *", at(2026, 11, 12, 21, 30)),
            "2026-11-13 03:00"
        );
    }

    #[test]
    fn step_minutes() {
        assert_eq!(
            next("*/15 * * * *", at(2026, 11, 12, 21, 31)),
            "2026-11-12 21:45"
        );
    }

    #[test]
    fn list_and_range() {
        assert_eq!(
            next("0 9,18 * * *", at(2026, 11, 12, 10, 0)),
            "2026-11-12 18:00"
        );
        assert_eq!(
            next("0 9-17 * * *", at(2026, 11, 12, 18, 1)),
            "2026-11-13 09:00"
        );
    }

    #[test]
    fn month_and_weekday_names() {
        assert_eq!(
            next("0 0 1 JAN *", at(2026, 11, 12, 9, 0)),
            "2027-01-01 00:00"
        );
        assert_eq!(
            next("0 0 * * MON", at(2026, 11, 12, 9, 0)),
            "2026-11-16 00:00"
        );
    }

    #[test]
    fn sunday_is_both_zero_and_seven() {
        assert_eq!(
            next("0 0 * * 0", at(2026, 11, 12, 9, 0)),
            "2026-11-15 00:00"
        );
        assert_eq!(
            next("0 0 * * 7", at(2026, 11, 12, 9, 0)),
            "2026-11-15 00:00"
        );
    }

    #[test]
    fn leap_day_and_impossible_date() {
        assert_eq!(
            next("0 0 29 2 *", at(2026, 11, 12, 21, 30)),
            "2028-02-29 00:00"
        );
        assert!(
            CronSpec::parse("0 0 31 4 *")
                .unwrap()
                .next_after(at(2026, 11, 12, 21, 30))
                .is_none(),
            "4 月 31 日永远不该触发"
        );
    }

    /// 日与星期都受限时取「或」：13 号或周五，先到哪个算哪个。
    #[test]
    fn dom_and_dow_are_ored_when_both_restricted() {
        // 2026-11-14 是周六；下一个周五是 11-20，下一个 13 号是 12-13
        assert_eq!(
            next("0 0 13 * 5", at(2026, 11, 14, 9, 0)),
            "2026-11-20 00:00"
        );
    }

    /// 日字段是 * 时只看星期：不能因为「每天都匹配」而变成每天都触发。
    #[test]
    fn dom_star_uses_only_dow() {
        assert_eq!(
            next("0 0 * * 5", at(2026, 11, 14, 9, 0)),
            "2026-11-20 00:00"
        );
    }

    #[test]
    fn aliases_expand() {
        assert_eq!(next("@daily", at(2026, 11, 12, 21, 30)), "2026-11-13 00:00");
        assert_eq!(
            next("@hourly", at(2026, 11, 12, 21, 30)),
            "2026-11-12 22:00"
        );
        assert_eq!(
            next("@weekly", at(2026, 11, 12, 21, 30)),
            "2026-11-15 00:00"
        );
    }

    #[test]
    fn next_n_is_increasing() {
        let list = CronSpec::parse("*/10 * * * *")
            .unwrap()
            .next_n(at(2026, 11, 12, 21, 31), 3);
        let got: Vec<String> = list.iter().map(|d| stamp(*d)).collect();
        assert_eq!(
            got,
            vec!["2026-11-12 21:40", "2026-11-12 21:50", "2026-11-12 22:00"]
        );
    }

    #[test]
    fn rejects_bad_expressions() {
        for expr in [
            "",
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 32 * *",
            "* * * 13 *",
            "*/0 * * * *",
            "5/10 * * * *",
            "0 0 32 * *",
            "@reboot",
            "MON * * * *",
        ] {
            assert!(CronSpec::parse(expr).is_err(), "应拒绝非法表达式：{expr:?}");
        }
    }

    #[test]
    fn seconds_are_truncated_from_now() {
        let now = Local
            .with_ymd_and_hms(2026, 11, 12, 21, 30, 45)
            .earliest()
            .unwrap();
        assert_eq!(next("* * * * *", now), "2026-11-12 21:31");
    }
}
