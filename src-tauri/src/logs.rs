//! 会话恢复落盘（规格 §13.4 / D-10）。
//!
//! 只存「壳 + 历史输出」：tab 元数据 + xterm 序列化缓冲。
//! 重启后**不拉起进程**，用户点「重跑」才执行。
//!
//! 预算约束（规格硬性要求）：
//! - 单会话 ≤ 2 MB，超出时从**最早**内容截断
//! - 全局 ≤ 20 MB，超出时丢弃最旧的会话
//! - 最多保留 20 个会话

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const MAX_SESSION_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_SESSIONS: usize = 20;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionLog {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub command_id: Option<String>,
    pub template_id: Option<String>,
    pub device: String,
    pub mode: String,
    pub kind: String,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub status: String,
    pub artifacts: Vec<String>,
    /// 派生动作（平台菜单）的来源：没有 commandId / templateId 时靠它支持「重跑」
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    /// xterm 序列化缓冲（含 ANSI，按原始字节保存，不转纯文本）
    pub ansi: String,
    pub saved_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Store {
    sessions: Vec<SessionLog>,
}

pub fn path_of(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("sessions.json"))
}

/// 从尾部截断，并右移到 ANSI 序列边界，避免回放出半截转义
fn tail_ansi(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }

    let mut start = s.len() - max;

    // UTF-8 边界
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }

    // 尽量跳到下一个 ESC，丢掉可能被切断的控制序列
    if let Some(pos) = s[start..].find('\u{1b}') {
        if pos < 4096 {
            start += pos;
        }
    }

    s[start..].to_string()
}

pub fn load_from(path: &Path) -> Vec<SessionLog> {
    if !path.exists() {
        return Vec::new();
    }

    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<Store>(&raw) {
            Ok(s) => s.sessions,
            Err(_) => {
                // 规格：损坏时备份后重建，不静默丢弃
                let _ = fs::copy(path, path.with_file_name("sessions.corrupt.json"));
                Vec::new()
            }
        },
        Err(_) => Vec::new(),
    }
}

pub fn save_to(path: &Path, mut logs: Vec<SessionLog>) -> Result<(), String> {
    // 1) 单会话上限
    for l in logs.iter_mut() {
        if l.ansi.len() > MAX_SESSION_BYTES {
            l.ansi = tail_ansi(&l.ansi, MAX_SESSION_BYTES);
        }
    }

    // 2) 数量上限（保留最近的）
    if logs.len() > MAX_SESSIONS {
        logs = logs.split_off(logs.len() - MAX_SESSIONS);
    }

    // 3) 全局预算：从最旧的开始丢弃
    let mut total: usize = logs.iter().map(|l| l.ansi.len()).sum();
    while total > MAX_TOTAL_BYTES && logs.len() > 1 {
        let dropped = logs.remove(0);
        total -= dropped.ansi.len();
    }

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    // 临时文件名按目标派生：固定名字在多实例/并行测试下会互相覆盖
    let tmp = path.with_extension("tmp");
    let data = serde_json::to_string(&Store { sessions: logs })
        .map_err(|e| format!("序列化会话失败: {e}"))?;
    fs::write(&tmp, data).map_err(|e| format!("写入临时文件失败: {e}"))?;

    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("会话落盘失败: {e}"))?;
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, size: usize) -> SessionLog {
        SessionLog {
            id: id.to_string(),
            title: format!("s-{id}"),
            ansi: "x".repeat(size),
            saved_at: 1,
            ..Default::default()
        }
    }

    #[test]
    fn single_session_is_truncated_from_the_front() {
        let tmp = std::env::temp_dir().join("fla_logs_trunc.json");
        let _ = fs::remove_file(&tmp);

        let big = "A".repeat(1000) + &"B".repeat(1000);
        let mut log = sample("s1", 0);
        log.ansi = big;

        // 手工压低上限做断言（避免真的造 2MB）
        let cut = tail_ansi(&log.ansi, 1200);
        assert!(cut.len() <= 1200, "截断后不应超限");
        assert!(cut.ends_with('B'), "应保留尾部内容");

        save_to(&tmp, vec![log]).unwrap();
        let back = load_from(&tmp);
        assert_eq!(back.len(), 1);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn keeps_only_newest_sessions_within_budget() {
        let tmp = std::env::temp_dir().join("fla_logs_budget.json");
        let _ = fs::remove_file(&tmp);

        let many: Vec<SessionLog> = (0..(MAX_SESSIONS + 5))
            .map(|i| sample(&format!("s{i}"), 10))
            .collect();

        save_to(&tmp, many).unwrap();
        let back = load_from(&tmp);

        assert_eq!(back.len(), MAX_SESSIONS, "应只保留最近 20 个");
        assert_eq!(back.last().unwrap().id, format!("s{}", MAX_SESSIONS + 4));

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn corrupt_file_is_backed_up() {
        let tmp = std::env::temp_dir().join("fla_logs_corrupt.json");
        let bak = tmp.with_file_name("sessions.corrupt.json");
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(&bak);

        fs::write(&tmp, "{ not json").unwrap();
        let logs = load_from(&tmp);

        assert!(logs.is_empty());
        assert!(bak.exists(), "损坏文件应备份为 sessions.corrupt.json");

        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(&bak);
    }
}
