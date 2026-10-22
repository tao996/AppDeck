//! 打开文件：源码交给 VS Code 跳行列，其他交给系统默认程序。
//!
//! 两个坑，都是本机实测出来的：
//!
//! 1. **不能直接 `CreateProcessW("code")`**——PATH 里是 `code.cmd` 脚本。
//! 2. **新版 VS Code 是"Electron 二进制 + 版本子目录"布局**：根目录的 `Code.exe`
//!    直接带 `--goto` 会以 exit 9 退出（找不到 app payload）。正确姿势是模拟
//!    `bin/code.cmd` 做的事：`ELECTRON_RUN_AS_NODE=1 Code.exe <版本目录>\resources\app\out\cli.js --goto …`
//!
//! 走 argv、不经过 cmd.exe，所以路径里有空格/引号也不会出问题。

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

/// 找 cli.js：
/// - 经典布局：`<install>\resources\app\out\cli.js`
/// - 版本子目录布局：`<install>\<hash>\resources\app\out\cli.js`
fn find_cli(code_exe: &Path) -> Option<PathBuf> {
    let dir = code_exe.parent()?;

    let classic = dir.join("resources").join("app").join("out").join("cli.js");
    if classic.is_file() {
        return Some(classic);
    }

    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let cand = entry
            .path()
            .join("resources")
            .join("app")
            .join("out")
            .join("cli.js");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// 用 VS Code 打开文件，可选跳到行列。
pub fn open(code: &Path, file: &Path, line: Option<u32>, col: Option<u32>) -> Result<(), String> {
    let mut cmd = Command::new(code);

    // 有 cli.js 就先把它当入口（新版布局必需；老版本也有，一样能用）
    if let Some(cli) = find_cli(code) {
        cmd.env("ELECTRON_RUN_AS_NODE", "1");
        cmd.arg(cli);
    }

    match line {
        Some(l) => {
            cmd.arg("--goto")
                .arg(format!("{}:{}:{}", file.display(), l, col.unwrap_or(1)));
        }
        None => {
            cmd.arg("--reuse-window").arg(file);
        }
    }

    hide_console(&mut cmd);

    // 启动失败（返回值非 0 / 立刻退出）要让用户看到，不能假装成功
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 VS Code 失败: {e}"))?;

    // cli 很快会退出（把请求转发给 GUI 后），给它一点时间看退出码
    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                return Err(format!(
                    "VS Code 启动失败（退出码 {}）。这个安装可能是“Electron + 版本子目录”布局，\
                     请在设置里指定 Code.exe 的完整路径，或用 bin\\code.cmd 所在目录。",
                    status.code().unwrap_or(-1)
                ));
            }
            Ok(Some(_)) => return Ok(()),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => return Ok(()),
        }
    }
    Ok(())
}

/// 用系统默认程序打开（图片、日志、pdf…）
#[cfg(windows)]
pub fn open_with_default_app(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    let op = wide(std::ffi::OsStr::new("open"));
    let file = wide(path.as_os_str());

    let ret = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW 返回 > 32 才算成功
    if ret as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "系统无法打开该文件（ShellExecute 返回 {}）：{}",
            ret as isize,
            path.display()
        ))
    }
}

#[cfg(not(windows))]
pub fn open_with_default_app(path: &Path) -> Result<(), String> {
    Err(format!("暂不支持在当前系统上打开: {}", path.display()))
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
    use super::{detect, find_cli};

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

    /// 本机 VS Code 是"版本子目录"布局，必须能找到 cli.js
    #[test]
    fn finds_cli_js_for_this_install() {
        let Some(exe) = detect(None) else {
            eprintln!("跳过：本机没装 VS Code");
            return;
        };
        let Some(cli) = find_cli(&exe) else {
            eprintln!("跳过：这个安装没有 cli.js（老版本 VS Code）");
            return;
        };
        assert!(cli.is_file(), "cli.js 应存在: {}", cli.display());
        assert!(cli.to_string_lossy().ends_with("cli.js"));
    }
}
