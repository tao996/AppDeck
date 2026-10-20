//! `flutter doctor` 体检（规格 §14）。
//!
//! **符号陷阱（源码级确认）**：`flutter_tools/lib/src/base/logger.dart:733-741`
//! 在 `terminal.supportsEmoji == false` 时把符号替换掉：
//!
//! ```text
//! ✗ → X      ✓ → √      ⚠️ → !
//! ```
//!
//! 本机实测输出为 `[√]` / `[!]` / `[X]`。解析器必须**同时接受两套**，
//! 否则在中文/非 emoji 终端上永远匹配不到状态行。

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DOCTOR_TIMEOUT: Duration = Duration::from_secs(120);
const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    /// 稳定标识，便于前端与后续动作绑定
    pub key: String,
    pub name: String,
    pub summary: String,
    /// ok | warn | error
    pub status: String,
    pub details: Vec<String>,
    /// 修复建议（命令或动作描述）
    pub fix: Option<String>,
    /// 该建议能否由启动器直接在终端里执行
    pub can_run: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    pub issues: usize,
    /// doctor 自己给出的结尾汇总，如 "Doctor found issues in 1 category."
    pub summary: Option<String>,
    /// 原始输出，出错时原样呈现给用户
    pub raw: String,
    /// 整体失败原因（含原始 stderr）
    pub error: Option<String>,
    pub ran_at: u64,
}

#[derive(Default)]
pub struct Cache(pub Mutex<HashMap<String, (Instant, DoctorReport)>>);

/// 状态行形如 `[√] Flutter (Channel stable, ...)`
fn status_of(glyph: &str) -> Option<&'static str> {
    match glyph {
        "√" | "✓" => Some("ok"),
        "!" | "⚠" => Some("warn"),
        "X" | "x" | "✗" => Some("error"),
        _ => None,
    }
}

/// 已知问题的修复建议。命中即返回（needle, 建议, 能否直接执行）
const KNOWN_FIXES: &[(&str, &str, bool)] = &[
    (
        "Android licenses not accepted",
        "flutter doctor --android-licenses",
        true,
    ),
    (
        "cmdline-tools component is missing",
        "sdkmanager \"cmdline-tools;latest\"",
        false,
    ),
    (
        "Unable to find git in your PATH",
        "安装 Git，并确保 git.exe 在 PATH 中",
        false,
    ),
    (
        "PowerShell executable not found",
        "安装 PowerShell 7（pwsh）或确认 PowerShell.exe 在 PATH 中",
        false,
    ),
    (
        "not a clone of the GitHub project",
        "用 git clone 重新安装 Flutter（zip 安装缺少 .git）",
        false,
    ),
    (
        "Android SDK file not found",
        "flutter config --android-sdk <SDK 路径>",
        false,
    ),
    (
        "Android Studio not installed",
        "安装 Android Studio，或忽略该项（纯命令行构建不需要）",
        false,
    ),
    (
        "No devices available",
        "连接设备或在「📱 模拟器」菜单里启动一个模拟器",
        false,
    ),
];

fn extract_fix(detail: &str) -> Option<(String, bool)> {
    for (needle, fix, can_run) in KNOWN_FIXES {
        if detail.contains(needle) {
            return Some(((*fix).to_string(), *can_run));
        }
    }

    // "To resolve this, run: <命令>"
    if let Some(pos) = detail.find("run: ") {
        let cmd = detail[pos + 5..].trim();
        if !cmd.is_empty() {
            let can_run = cmd == "flutter doctor --android-licenses";
            return Some((cmd.to_string(), can_run));
        }
    }

    None
}

fn slug(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// 把 `Flutter (Channel stable, 3.47.1, ...)` 拆成名称与摘要
fn split_head(after: &str) -> (String, String) {
    let (head, paren) = match after.find('(') {
        Some(i) => (
            after[..i].trim(),
            after[i + 1..].trim_end_matches(')').trim(),
        ),
        None => (after.trim(), ""),
    };

    // "Android toolchain - develop for Android devices" → 名称取前半
    let mut parts = head.splitn(2, " - ");
    let name = parts.next().unwrap_or(head).trim().to_string();
    let descriptor = parts.next().unwrap_or("").trim();

    let summary = match (descriptor.is_empty(), paren.is_empty()) {
        (true, true) => String::new(),
        (true, false) => paren.to_string(),
        (false, true) => descriptor.to_string(),
        (false, false) => format!("{descriptor} · {paren}"),
    };

    (name, summary)
}

/// 解析 doctor 输出。明细行必须**有缩进**，否则会把
/// 结尾的 `! Doctor found issues in 1 category.` 误当成上一条的细节。
pub fn parse(output: &str) -> (Vec<DoctorCheck>, Option<String>) {
    let mut checks: Vec<DoctorCheck> = Vec::new();
    let mut current: Option<DoctorCheck> = None;
    let mut summary: Option<String> = None;

    for line in output.lines() {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }

        // 状态行：[√] Name (summary)
        if !indented && trimmed.starts_with('[') {
            if let Some(close) = trimmed.find(']') {
                let glyph = &trimmed[1..close];
                if let Some(status) = status_of(glyph.trim()) {
                    if let Some(prev) = current.take() {
                        checks.push(prev);
                    }
                    let (name, sum) = split_head(trimmed[close + 1..].trim());
                    current = Some(DoctorCheck {
                        key: slug(&name),
                        name,
                        summary: sum,
                        status: status.to_string(),
                        details: Vec::new(),
                        fix: None,
                        can_run: false,
                    });
                    continue;
                }
            }
        }

        if indented {
            if let Some(cur) = current.as_mut() {
                let detail = trimmed
                    .trim_start_matches(['!', '•', '·', '-', '✗', '√'])
                    .trim()
                    .to_string();
                if detail.is_empty() {
                    continue;
                }
                if cur.fix.is_none() {
                    if let Some((fix, can_run)) = extract_fix(&detail) {
                        cur.fix = Some(fix);
                        cur.can_run = can_run;
                    }
                }
                cur.details.push(detail);
            }
            continue;
        }

        // 顶层非状态行：doctor 的结尾汇总。
        // 行首可能带 `!`（Windows 上由 ⚠️ 替换而来），必须先剥掉再匹配。
        // 注意此时上一条检查可能还没收尾（如 "Network resources"），必须先 push 再记汇总。
        let plain = trimmed.trim_start_matches(['!', '⚠', '•']).trim();
        if plain.starts_with("Doctor found issues") || plain.starts_with("No issues found") {
            if let Some(prev) = current.take() {
                checks.push(prev);
            }
            summary = Some(plain.to_string());
        }
    }

    if let Some(prev) = current.take() {
        checks.push(prev);
    }

    (checks, summary)
}

fn run_doctor(exe: &Path, env: &[(String, String)]) -> Result<String, String> {
    let mut cmd = crate::flutter::build_command(exe, &["--suppress-analytics", "doctor"]);
    // 鸿蒙工程要带上 DEVECO_SDK_HOME 等，否则 doctor 结果不准
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::flutter::hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 flutter doctor 失败: {e}"))?;

    let mut stdout = child.stdout.take().ok_or("无法获取 doctor stdout")?;
    let mut stderr = child.stderr.take().ok_or("无法获取 doctor stderr")?;

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut so = String::new();
        let _ = stdout.read_to_string(&mut so);
        let mut se = String::new();
        let _ = stderr.read_to_string(&mut se);
        let _ = tx.send(format!("{so}\n{se}"));
    });

    match rx.recv_timeout(DOCTOR_TIMEOUT) {
        Ok(text) => {
            let _ = child.wait();
            Ok(text)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "flutter doctor 超时（{}s），已终止",
                DOCTOR_TIMEOUT.as_secs()
            ))
        }
    }
}

pub fn report(exe: &Path, env: &[(String, String)]) -> DoctorReport {
    match run_doctor(exe, env) {
        Ok(raw) => {
            let (checks, summary) = parse(&raw);
            let issues = checks.iter().filter(|c| c.status != "ok").count();
            DoctorReport {
                checks,
                issues,
                summary,
                raw,
                error: None,
                ran_at: crate::logs::now_ms(),
            }
        }
        Err(e) => DoctorReport {
            checks: Vec::new(),
            issues: 0,
            summary: None,
            raw: String::new(),
            error: Some(e),
            ran_at: crate::logs::now_ms(),
        },
    }
}

pub fn cached(cache: &Cache, key: &str, force: bool) -> Option<DoctorReport> {
    let map = cache.0.lock().ok()?;
    let (at, rep) = map.get(key)?;
    if force || at.elapsed() > CACHE_TTL {
        return None;
    }
    Some(rep.clone())
}

pub fn store(cache: &Cache, key: &str, rep: &DoctorReport) {
    if let Ok(mut map) = cache.0.lock() {
        map.insert(key.to_string(), (Instant::now(), rep.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机真实输出（flutter 3.47.1 / Windows 10 / cp936），原样保留
    const REAL: &str = "\
Doctor summary (to see all details, run flutter doctor -v):
[\u{221a}] Flutter (Channel stable, 3.47.1, on Microsoft Windows [\u{7248}\u{672c} 10.0.19045.3803], locale zh-CN)
[\u{221a}] Windows Version (10 \u{4e13}\u{4e1a}\u{7248} 64 \u{4f4d}, 22H2, 2009)
[!] Android toolchain - develop for Android devices (Android SDK version 37.0.0)
    ! Some Android licenses not accepted. To resolve this, run: flutter doctor --android-licenses
[\u{221a}] Chrome - develop for the web
[\u{221a}] Visual Studio - develop Windows apps (Visual Studio Community 2026 18.9.2)
[\u{221a}] Connected device (3 available)
[\u{221a}] Network resources

! Doctor found issues in 1 category.
";

    #[test]
    fn parses_windows_substituted_glyphs() {
        let (checks, summary) = parse(REAL);

        assert_eq!(checks.len(), 7, "应解析出 7 个检查项：{checks:#?}");

        let android = checks
            .iter()
            .find(|c| c.name == "Android toolchain")
            .expect("应找到 Android toolchain");

        assert_eq!(android.status, "warn");
        assert!(
            android.summary.contains("develop for Android devices"),
            "摘要应保留描述：{}",
            android.summary
        );
        assert!(
            android
                .fix
                .as_deref()
                .is_some_and(|f| f.contains("--android-licenses")),
            "应提取出许可证修复命令：{:?}",
            android.fix
        );
        assert!(android.can_run, "许可证修复应可直接在终端执行");

        // 结尾汇总不能被当成细节
        let last = checks.last().unwrap();
        assert_eq!(last.name, "Network resources");
        assert!(
            !last.details.iter().any(|d| d.contains("Doctor found issues")),
            "结尾汇总被误并入 Network resources：{:?}",
            last.details
        );
        assert!(summary.is_some_and(|s| s.contains("1 category")));

        let issues = checks.iter().filter(|c| c.status != "ok").count();
        assert_eq!(issues, 1);
    }

    #[test]
    fn accepts_plain_glyphs_too() {
        // 走 PTY（supportsEmoji=true）时 flutter 输出的是原始符号
        let out = "\
[\u{2713}] Flutter (Channel stable, 3.47.1)
[\u{2717}] Chrome - develop for the web (Cannot find Chrome executable)
[\u{26a0}] Android toolchain (licenses)
";
        let (checks, _) = parse(out);
        assert_eq!(checks.len(), 3);
        assert_eq!(checks[0].status, "ok");
        assert_eq!(checks[1].status, "error");
        assert_eq!(checks[2].status, "warn");
    }

    #[test]
    fn extracts_fix_from_run_prefix() {
        let out = "\
[!] Something broken
    ! Foo is missing. To resolve this, run: flutter doctor --android-licenses
";
        let (checks, _) = parse(out);
        assert_eq!(
            checks[0].fix.as_deref(),
            Some("flutter doctor --android-licenses")
        );
        assert!(checks[0].can_run);
    }

    #[test]
    fn empty_output_yields_nothing() {
        let (checks, summary) = parse("");
        assert!(checks.is_empty());
        assert!(summary.is_none());
    }
}
