//! Git 桌面客户端（GitHub Desktop 等）：用项目目录打开。
//!
//! 参数形态按可执行文件名区分——用户只需要在设置里填一个 exe 路径：
//!
//! - **GitHub Desktop**：不认裸路径。它的 CLI 入口是 `--cli-open <path>`
//!   （见 desktop/desktop 的 `app/src/main-process/main.ts` → `handleCommandLineArguments`），
//!   官方安装的 `github` 命令（bin\github.cmd）也是转发到这个开关。
//! - **其它客户端**（SourceTree / GitKraken / Git Extensions…）：`<exe> <path>`。
//!
//! 启动失败必须让用户看到，不能静默——和 `editor::open` 一样返回 Result。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 探测已安装的 GitHub Desktop。
///
/// 只看常见位置（Squirrel 的 `%LOCALAPPDATA%\GitHubDesktop` 里既有 stub 也有
/// `app-<版本>` 子目录），不扫全盘。
pub fn detect() -> Option<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();

    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = std::env::var_os(key) {
            let base = PathBuf::from(base);
            bases.push(base.join("GitHub Desktop"));
            bases.push(base.join("GitHubDesktop"));
        }
    }

    // 1) 经典安装位置 / Squirrel 的 stub
    for dir in &bases {
        let exe = dir.join("GitHubDesktop.exe");
        if exe.is_file() {
            return Some(exe);
        }
    }

    // 2) Squirrel 的版本子目录：%LOCALAPPDATA%\GitHubDesktop\app-3.4.3\GitHubDesktop.exe
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local).join("GitHubDesktop");
        if let Ok(entries) = std::fs::read_dir(&root) {
            let mut best: Option<(String, PathBuf)> = None;
            for entry in entries.flatten() {
                let exe = entry.path().join("GitHubDesktop.exe");
                if !exe.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                // app-3.10.0 要比 app-3.9.0 大，按字符串比会把 10 排到 9 前面，这里只求能命中
                if best.as_ref().is_none_or(|(n, _)| name > *n) {
                    best = Some((name, exe));
                }
            }
            if let Some((_, exe)) = best {
                return Some(exe);
            }
        }
    }

    // 3) 用户装了 GitHub Desktop 的命令行工具：github.cmd / github.exe
    if let Some(shim) = crate::terminal::which("github") {
        return Some(shim);
    }

    None
}

/// GitHub Desktop 需要 `--cli-open`；`github` 命令行 shim 自己会转发，直接给路径。
fn needs_cli_open(exe: &Path) -> bool {
    let stem = exe
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let compact: String = stem.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    compact == "githubdesktop"
}

/// 用 Git 桌面客户端打开某个目录（项目根目录）。
pub fn open(exe: &Path, dir: &Path) -> Result<(), String> {
    if !exe.is_file() {
        return Err(format!(
            "Git Desktop 程序不存在：{}（请到「设置 → Git」重新指定）",
            exe.display()
        ));
    }
    if !dir.is_dir() {
        return Err(format!("不是目录：{}", dir.display()));
    }

    let dir = dir.display().to_string();
    let mut args: Vec<&str> = Vec::new();
    if needs_cli_open(exe) {
        args.push("--cli-open");
    }
    args.push(&dir);

    // 允许指向 .cmd/.bat（github 命令常是脚本）：交给 build_command 包 cmd.exe
    let mut cmd = crate::flutter::build_command(exe, &args);
    hide_console(&mut cmd);

    // GitHub Desktop 是单实例的：新进程把参数转给已运行的窗口后马上退出，
    // 所以这里不看退出码，只要进程起得来就算成功。
    cmd.spawn()
        .map_err(|e| format!("启动 Git Desktop 失败: {e}"))?;
    Ok(())
}

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::{detect, needs_cli_open};
    use std::path::Path;

    #[test]
    fn github_desktop_gets_cli_open() {
        assert!(needs_cli_open(Path::new("C:/x/GitHubDesktop.exe")));
        assert!(needs_cli_open(Path::new("C:/x/github-desktop.exe")));
    }

    #[test]
    fn other_clients_get_plain_path() {
        assert!(!needs_cli_open(Path::new("C:/x/github.exe")));
        assert!(!needs_cli_open(Path::new("C:/x/SourceTree.exe")));
        assert!(!needs_cli_open(Path::new("C:/x/GitKraken.exe")));
    }

    /// 本机装了 GitHub Desktop 的话，探测结果必须是可执行文件
    #[test]
    fn detected_path_is_a_file() {
        if let Some(p) = detect() {
            assert!(p.is_file(), "探测到的 Git Desktop 应存在: {}", p.display());
        } else {
            eprintln!("跳过：本机没装 GitHub Desktop");
        }
    }
}
