//! 默认终端：从系统探测，或由用户指定可执行文件。
//!
//! 「在终端中打开」的意义在于**注入项目环境**——鸿蒙工程需要
//! FLUTTER_STORAGE_BASE_URL / DEVECO_SDK_HOME 等变量，以及指向鸿蒙分支的
//! PATH shim。这些在普通 CMD/PowerShell 里是没有的。

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCandidate {
    pub name: String,
    pub path: String,
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in ["", ".exe", ".bat", ".cmd"] {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn system32(name: &str) -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot")?;
    let p = PathBuf::from(root).join("System32").join(name);
    p.is_file().then_some(p)
}

/// 常见终端，按"体验更好"排序：pwsh > Windows Terminal > powershell > cmd > bash
pub fn detect() -> Vec<TerminalCandidate> {
    let mut out: Vec<TerminalCandidate> = Vec::new();

    let mut push = |name: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            let s = p.display().to_string();
            if !out.iter().any(|c| c.path.eq_ignore_ascii_case(&s)) {
                out.push(TerminalCandidate {
                    name: name.to_string(),
                    path: s,
                });
            }
        }
    };

    push("PowerShell 7 (pwsh)", which("pwsh"));
    push("Windows Terminal", which("wt"));
    push("Windows PowerShell", which("powershell").or_else(|| system32("WindowsPowerShell\\v1.0\\powershell.exe")));
    push("命令提示符 (cmd)", which("cmd").or_else(|| system32("cmd.exe")));
    push("Git Bash", which("bash"));

    out
}

/// 解析出该用的终端：设置优先，其次自动探测，最后退回 cmd.exe
pub fn resolve(configured: Option<&str>) -> PathBuf {
    if let Some(c) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(c);
        if p.is_file() {
            return p;
        }
    }

    if let Some(first) = detect().into_iter().next() {
        return PathBuf::from(first.path);
    }

    PathBuf::from("cmd.exe")
}

/// 终端的启动参数：PowerShell 需要 `-NoLogo` 之类才能干净地进入交互
pub fn args_for(exe: &Path) -> Vec<String> {
    let name = exe
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    match name.as_str() {
        // -NoLogo 少一行横幅；-NoExit 保证交互窗口不立即退出
        "pwsh" | "powershell" => vec!["-NoLogo".to_string()],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_at_least_one_terminal() {
        let list = detect();
        assert!(!list.is_empty(), "Windows 上至少应有 cmd.exe");
        assert!(
            list.iter().any(|c| c.path.to_ascii_lowercase().ends_with("cmd.exe")),
            "cmd.exe 应被探测到：{list:?}"
        );
    }

    #[test]
    fn resolve_prefers_configured_file_then_falls_back() {
        // 配置了不存在的路径 → 忽略，走自动探测
        let p = resolve(Some(r"D:\nope\terminal.exe"));
        assert!(p.is_file() || p.display().to_string().eq_ignore_ascii_case("cmd.exe"));

        // 配置了真实文件 → 直接用
        let real = std::env::var_os("SystemRoot")
            .map(|r| PathBuf::from(r).join("System32").join("cmd.exe"));
        if let Some(real) = real.filter(|p| p.is_file()) {
            let got = resolve(Some(&real.display().to_string()));
            assert_eq!(got, real);
        }
    }

    #[test]
    fn powershell_gets_nologo() {
        assert_eq!(args_for(Path::new("C:\\ps\\pwsh.exe")), vec!["-NoLogo"]);
        assert!(args_for(Path::new("C:\\Windows\\System32\\cmd.exe")).is_empty());
    }
}
