//! 打开文件/目录：按编辑器类型选择正确的跳行列参数。
//!
//! 支持 VS Code（及 Cursor / VSCodium 等分支）、Zed、Sublime Text、Notepad++，
//! 以及任何用户手动指定的可执行文件（只传路径，不猜参数）。
//!
//! VS Code 有两个坑，都是本机实测出来的：
//!
//! 1. **不能直接 `CreateProcessW("code")`**——PATH 里是 `code.cmd` 脚本。
//! 2. **新版 VS Code 是"Electron 二进制 + 版本子目录"布局**：根目录的 `Code.exe`
//!    直接带 `--goto` 会以 exit 9 退出（找不到 app payload）。正确姿势是模拟
//!    `bin/code.cmd` 做的事：`ELECTRON_RUN_AS_NODE=1 Code.exe <版本目录>\resources\app\out\cli.js --goto …`
//!
//! 走 argv、不经过 cmd.exe，所以路径里有空格/引号也不会出问题。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 打开方式：不同编辑器的跳行列参数不一样
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Style {
    /// VS Code 及分支：`--goto 文件:行:列` / `--new-window 路径`
    VSCode,
    /// Zed / Sublime Text：`文件:行:列`（目录直接给路径）
    ColonLine,
    /// Notepad++：`-n行 文件`
    NotepadPlus,
    /// 其它程序：只把路径传过去（能否跳行由它自己决定）
    Generic,
}

fn stem(exe: &Path) -> String {
    exe.file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 探测 VS Code：只看设置、常见安装路径、PATH（不扫全盘）
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

/// 探测默认编辑器：设置里的路径 > VS Code > 其它常见编辑器。
///
/// 用户手填的路径只要文件存在就直接用（不限于 VS Code），打开方式按 exe 名分派。
pub fn detect_any(setting: Option<&str>) -> Option<PathBuf> {
    detect(setting).or_else(detect_other)
}

/// 其它常见编辑器（VS Code 装不上时的兜底）：Zed / Sublime Text / Cursor / Notepad++
fn detect_other() -> Option<PathBuf> {
    let roots: Vec<PathBuf> = ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|k| std::env::var_os(*k).map(PathBuf::from))
        .collect();

    for root in roots {
        // Zed 默认在 %LOCALAPPDATA%\Programs\Zed；也兼容直接解压到 Program Files
        let cands: [&[&str]; 8] = [
            &["Programs", "Zed", "Zed.exe"],
            &["Zed", "Zed.exe"],
            &["Programs", "Sublime Text", "sublime_text.exe"],
            &["Sublime Text", "sublime_text.exe"],
            &["Sublime Text 3", "sublime_text.exe"],
            &["Sublime Text 4", "sublime_text.exe"],
            &["Programs", "cursor", "Cursor.exe"],
            &["Notepad++", "notepad++.exe"],
        ];
        for sub in cands {
            let p = sub
                .iter()
                .fold(root.clone(), |acc, seg| acc.join(*seg));
            if p.is_file() {
                return Some(p);
            }
        }
    }

    // 最后看 PATH：只要真正的 exe，跳过 code.cmd / subl.bat 这类包装脚本
    for name in ["zed", "sublime_text", "notepad++"] {
        if let Some(p) = crate::terminal::which(name) {
            if p.is_file()
                && p.extension()
                    .map(|e| e.eq_ignore_ascii_case("exe"))
                    .unwrap_or(false)
            {
                return Some(p);
            }
        }
    }

    None
}

/// 给 UI 用的可读名字（自动检测提示、启动失败信息）
pub fn display_name(exe: &Path) -> &'static str {
    let name = stem(exe);
    match name.as_str() {
        "code" => "VS Code",
        "code-insiders" => "VS Code Insiders",
        "codium" => "VSCodium",
        "cursor" => "Cursor",
        "windsurf" => "Windsurf",
        "trae" => "Trae",
        "zed" => "Zed",
        "notepad++" => "Notepad++",
        s if s.starts_with("sublime_text") => "Sublime Text",
        _ => "编辑器",
    }
}

/// 按 exe 名判断打开方式。
///
/// `has_cli` 优先：只要旁边能找到 VS Code 的 `cli.js`，就按 VS Code 分支处理，
/// 这样 Cursor / VSCodium 等改名分支也能正确走 `ELECTRON_RUN_AS_NODE`。
fn style_of(exe: &Path, has_cli: bool) -> Style {
    if has_cli {
        return Style::VSCode;
    }

    match stem(exe).as_str() {
        "code" | "code-insiders" | "codium" | "cursor" | "windsurf" | "trae" => Style::VSCode,
        "zed" => Style::ColonLine,
        "subl" | "sublime_text" => Style::ColonLine,
        "notepad++" => Style::NotepadPlus,
        _ => Style::Generic,
    }
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

/// 用编辑器打开文件/目录，可选跳到行列。
///
/// 打开目录时 VS Code 用 `--new-window`：`--reuse-window` 会把当前窗口里已经打开的工程
/// 直接替换掉，用户想的是"再开一个窗口"，不是"切走当前项目"。
pub fn open(exe: &Path, file: &Path, line: Option<u32>, col: Option<u32>) -> Result<(), String> {
    let cli = find_cli(exe);
    let style = style_of(exe, cli.is_some());
    let name = display_name(exe);

    let mut cmd = Command::new(exe);

    match style {
        Style::VSCode => {
            // 有 cli.js 就先把它当入口（新版布局必需；老版本也有，一样能用）
            if let Some(cli) = cli {
                cmd.env("ELECTRON_RUN_AS_NODE", "1");
                cmd.arg(cli);
            }

            match line {
                Some(l) => {
                    // 跳行列沿用"就地在已打开窗口里定位"，避免每点一次报错就多一个窗口
                    cmd.arg("--goto")
                        .arg(format!("{}:{}:{}", file.display(), l, col.unwrap_or(1)));
                }
                None => {
                    cmd.arg("--new-window").arg(file);
                }
            }
        }

        Style::ColonLine => match line {
            Some(l) => {
                cmd.arg(format!("{}:{}:{}", file.display(), l, col.unwrap_or(1)));
            }
            None => {
                cmd.arg(file);
            }
        },

        Style::NotepadPlus => {
            if let Some(l) = line {
                cmd.arg(format!("-n{l}"));
            }
            cmd.arg(file);
        }

        // 未知程序：只认"路径"这一个参数，别自作聪明拼 :行:列
        Style::Generic => {
            cmd.arg(file);
        }
    }

    hide_console(&mut cmd);

    // 启动失败（返回值非 0 / 立刻退出）要让用户看到，不能假装成功
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动{name}失败：{e}"))?;

    // cli 很快会退出（把请求转发给 GUI 后），给它一点时间看退出码
    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                // 只有 VS Code 有"Electron + 版本子目录"这个坑，别把提示套到 Zed 上
                let extra = if style == Style::VSCode {
                    "若用的是 VS Code，可能是“Electron + 版本子目录”布局，请在设置里指定 Code.exe 的完整路径。"
                } else {
                    "请确认设置里的程序路径正确，且该程序支持从命令行打开文件。"
                };
                return Err(format!(
                    "{name}启动失败（退出码 {}）。{extra}",
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
    use super::{detect, detect_any, find_cli, style_of, Style};
    use std::path::Path;

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

    /// 不同编辑器用不同的跳行参数：不能在 Zed / Sublime 后面硬塞 --goto
    #[test]
    fn dispatches_style_by_executable_name() {
        let cases: [(&str, Style); 7] = [
            (r"C:\x\Code.exe", Style::VSCode),
            (r"C:\x\Cursor.exe", Style::VSCode),
            (r"C:\x\zed.exe", Style::ColonLine),
            (r"C:\x\sublime_text.exe", Style::ColonLine),
            (r"C:\x\subl.exe", Style::ColonLine),
            (r"C:\x\notepad++.exe", Style::NotepadPlus),
            (r"C:\x\other.exe", Style::Generic),
        ];
        for (path, want) in cases {
            assert_eq!(style_of(Path::new(path), false), want, "{path}");
        }
        // 只要旁边有 cli.js，一律按 VS Code 分支处理
        assert_eq!(style_of(Path::new(r"C:\x\Cursor.exe"), true), Style::VSCode);
    }

    /// 自动探测放宽到"任意已知编辑器"后，返回的仍必须是真实可执行文件
    #[test]
    fn detect_any_returns_existing_file() {
        let Some(p) = detect_any(None) else {
            eprintln!("跳过：本机没有 VS Code / Zed / Sublime Text / Notepad++");
            return;
        };
        assert!(p.is_file(), "探测结果应存在: {}", p.display());
    }
}
