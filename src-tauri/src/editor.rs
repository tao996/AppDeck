//! VS Code 定位与打开。
//!
//! 关键点：**必须用 `Code.exe`，不能用 PATH 里的 `code`**。
//! Windows 上 `code` 是 `code.cmd`/无扩展名脚本（和 `npm`/`docker` 同一个坑），
//! 直接 `CreateProcessW("code")` 会失败，包一层 `cmd.exe` 又要处理引号转义。
//! `Code.exe --goto "文件:行:列"` 是官方支持的用法，且完全走 argv，无注入风险。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 探测 Code.exe：只看设置、常见安装路径、PATH（不扫全盘）
pub fn detect(code_setting: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = code_setting {
        let p = PathBuf::from(raw.trim());
        if p.is_file() {
            return Some(p);
        }
    }

    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = std::env::var_os(key) {
            let p = PathBuf::from(base)
                .join("Microsoft VS Code")
                .join("Code.exe");
            if p.is_file() {
                return Some(p);
            }
        }
    }

    // PATH 里通常是 ...\Microsoft VS Code\bin\code.cmd → 上两级就是 Code.exe
    if let Some(cmd) = crate::terminal::which("code") {
        let dir = cmd.parent()?.parent()?;
        let exe = dir.join("Code.exe");
        if exe.is_file() {
            return Some(exe);
        }
    }

    None
}

/// 用 VS Code 打开文件，可选跳到行列。
pub fn open(code: &Path, file: &Path, line: Option<u32>, col: Option<u32>) -> Result<(), String> {
    let mut cmd = Command::new(code);
    match line {
        // --goto 的格式就是 文件:行:列
        Some(l) => {
            cmd.arg("--goto")
                .arg(format!("{}:{}:{}", file.display(), l, col.unwrap_or(1)));
        }
        None => {
            // 普通文件：复用窗口，别每次开新的
            cmd.arg("--reuse-window").arg(file);
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动 VS Code 失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::detect;

    /// 本机装了 VS Code 的话，探测结果必须是 .exe（不能是 code.cmd）
    #[test]
    fn detects_real_code_exe_on_this_machine() {
        let Some(p) = detect(None) else {
            eprintln!("跳过：本机没装 VS Code");
            return;
        };
        let s = p.display().to_string();
        assert!(
            s.to_ascii_lowercase().ends_with("code.exe"),
            "必须解析到 Code.exe，实际: {s}"
        );
        assert!(p.is_file());
    }

    /// 设置了不存在的路径时，应该退回探测（而不是直接失败）
    #[test]
    fn invalid_setting_falls_back_to_detection() {
        let p = detect(Some(r"C:\definitely\not\here\Code.exe"));
        if let Some(p) = p {
            assert!(p.is_file());
        }
    }
}
