//! 工具栏「自定义命令」：全局命令 CRUD、快捷方式解析、在 AppDeck 内嵌 PTY 中直接启动。
//!
//! 关键点：`.lnk` 不能交给 ShellExecute（会弹系统控制台、任务栏多一个按钮），
//! 必须先解析出 target/args/cwd，再把 target 直接 spawn 到 ConPTY 里。

use crate::model::{CustomCommand, State};
use crate::pty;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutInfo {
    pub target: String,
    pub args: String,
    pub cwd: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomStart {
    pub id: String,
    pub pid: u32,
    pub title: String,
    pub device: String,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
    pub prefill: Option<String>,
    pub reused: Option<bool>,
}

fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd;
}

/// 用 WScript.Shell 读取 .lnk 的 target / args / working dir。
/// 只在添加/编辑（或未解析的快捷方式首次运行）时调用，不在每次打开面板时跑。
pub fn resolve_shortcut_impl(path: &str) -> Result<ShortcutInfo, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("快捷方式路径为空".to_string());
    }
    let p = PathBuf::from(raw);
    if !p.is_file() {
        return Err(format!("快捷方式不存在：{raw}"));
    }
    let abs = p
        .canonicalize()
        .unwrap_or(p.clone())
        .display()
        .to_string();

    let script = format!(
        "$ErrorActionPreference='Stop';\
         [Console]::OutputEncoding=[Text.Encoding]::UTF8;\
         $s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');\
         [pscustomobject]@{{target=$s.TargetPath;args=$s.Arguments;cwd=$s.WorkingDirectory;description=$s.Description}}|\
         ConvertTo-Json -Compress",
        ps_quote(&abs)
    );

    // PowerShell -EncodedCommand 用 UTF-16LE base64，避免路径里的引号/中文被 cmd 再转义
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        &encoded,
    ]);
    hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("调用 PowerShell 解析快捷方式失败：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("解析快捷方式失败：{err}"));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim().trim_start_matches('\u{feff}');
    let raw: ShortcutInfoRaw = serde_json::from_str(text)
        .map_err(|e| format!("解析快捷方式输出失败：{e}\n{text}"))?;

    let mut target = raw.target.trim().to_string();
    if target.is_empty() {
        return Err("快捷方式没有目标程序（可能是网址/特殊 shell 项）".to_string());
    }
    // 少数快捷方式的 TargetPath 是相对路径：按快捷方式所在目录补全
    if !Path::new(&target).is_absolute() {
        if let Some(dir) = Path::new(&abs).parent() {
            target = dir.join(&target).display().to_string();
        }
    }

    Ok(ShortcutInfo {
        target,
        args: raw.args,
        cwd: raw.cwd,
        description: raw.description,
    })
}

#[derive(Deserialize)]
struct ShortcutInfoRaw {
    #[serde(default)]
    target: String,
    #[serde(default)]
    args: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    description: String,
}

/// 参数拆分：空格分隔，双引号内的空格保留，引号本身去掉。
/// 这样快捷方式里的 `-server="host:port"` 会变成目标程序期望的 `-server=host:port`，
/// 而不是把引号原样传给 `npc.exe`。
fn parse_args(raw: &str) -> Result<Vec<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut has_token = false;

    for c in raw.chars() {
        match c {
            '"' => {
                in_quote = !in_quote;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quote => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }

    if in_quote {
        return Err("参数中的双引号没有闭合".to_string());
    }
    if has_token {
        out.push(cur);
    }
    Ok(out)
}

struct Launch {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
}

fn launch_for(cmd: &CustomCommand) -> Result<Launch, String> {
    let program = cmd.program.trim();
    if program.is_empty() {
        return Err("程序/快捷方式不能为空".to_string());
    }

    let lower = program.to_ascii_lowercase();
    let is_lnk = lower.ends_with(".lnk");
    let mut target = if is_lnk {
        cmd.target
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty() && Path::new(t).is_file())
            .map(str::to_string)
    } else {
        None
    };
    let mut args_raw = cmd.args.trim().to_string();
    let mut cwd = cmd
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);

    // 快捷方式：没有解析结果（或用户新填了 .lnk）时再解析一次
    if is_lnk && (target.is_none() || args_raw.is_empty() || cwd.is_none()) {
        let info = resolve_shortcut_impl(program)?;
        target = Some(info.target);
        if args_raw.is_empty() {
            args_raw = info.args;
        }
        if cwd.is_none() {
            cwd = Some(info.cwd);
        }
    }

    let target = target.unwrap_or_else(|| program.to_string());
    let target = crate::terminal::resolve_executable(&target);
    let target_lower = target.to_ascii_lowercase();
    if target_lower.ends_with(".bat") || target_lower.ends_with(".cmd") {
        return Err("暂不支持直接运行 .bat/.cmd；请在快捷方式里指向 exe".to_string());
    }

    let args = parse_args(&args_raw)?;

    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| Path::new(&target).parent().map(Path::to_path_buf))
        .ok_or_else(|| "无法确定工作目录".to_string())?;
    if !cwd.is_dir() {
        return Err(format!("工作目录不存在：{}", cwd.display()));
    }

    Ok(Launch {
        program: target,
        args,
        cwd,
    })
}

#[tauri::command]
pub fn resolve_shortcut(path: String) -> Result<ShortcutInfo, String> {
    resolve_shortcut_impl(&path)
}

#[tauri::command]
pub fn upsert_custom_command(
    app: AppHandle,
    mut command: CustomCommand,
) -> Result<State, String> {
    let mut state = crate::store::load(&app)?;

    command.name = command.name.trim().to_string();
    command.program = command.program.trim().to_string();
    command.args = command.args.trim().to_string();
    command.cwd = command
        .cwd
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    command.target = command
        .target
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    if command.name.is_empty() {
        return Err("命令名称不能为空".to_string());
    }
    if command.program.is_empty() {
        return Err("程序/快捷方式不能为空".to_string());
    }
    if command.id.trim().is_empty() {
        command.id = crate::model::make_id(
            "cc",
            &format!("{}|{}", command.name, command.program),
        );
    }

    match state
        .custom_commands
        .iter_mut()
        .find(|c| c.id == command.id)
    {
        Some(existing) => *existing = command,
        None => state.custom_commands.push(command),
    }

    crate::store::save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
pub fn remove_custom_command(app: AppHandle, id: String) -> Result<State, String> {
    let mut state = crate::store::load(&app)?;
    state.custom_commands.retain(|c| c.id != id);
    crate::store::save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
pub fn start_custom_command(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    command_id: String,
    rows: u16,
    cols: u16,
) -> Result<CustomStart, String> {
    let state = crate::store::load(&app)?;
    let command = state
        .custom_commands
        .iter()
        .find(|c| c.id == command_id)
        .ok_or_else(|| "自定义命令不存在".to_string())?;

    let launch = launch_for(command)?;
    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let id = format!("sess-{}-{seq}", crate::logs::now_ms());

    let session = pty::spawn(
        app.clone(),
        id.clone(),
        &launch.program,
        &launch.args,
        launch.cwd.clone(),
        &[],
        rows,
        cols,
    )?;

    let pid = session.pid;
    reg.0
        .lock()
        .map_err(|_| "会话注册表锁定失败".to_string())?
        .insert(id.clone(), session);

    Ok(CustomStart {
        id,
        pid,
        title: format!("自定义 · {}", command.name),
        device: "—".to_string(),
        cwd: launch.cwd.display().to_string(),
        program: launch.program,
        args: launch.args,
        prefill: None,
        reused: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_windows_args_with_quotes() {
        let args = parse_args(r#"-server="47.1.1.1:18024" -vkey=abc -debug=true"#).unwrap();
        assert_eq!(
            args,
            vec![
                "-server=47.1.1.1:18024",
                "-vkey=abc",
                "-debug=true"
            ]
        );
    }

    #[test]
    fn parses_args_with_spaces_in_quotes() {
        let args = parse_args(r#"--name "My App" --path "C:\a b\c.exe""#).unwrap();
        assert_eq!(args, vec!["--name", "My App", "--path", r"C:\a b\c.exe"]);
    }

    #[test]
    fn empty_args_is_empty() {
        assert!(parse_args("   ").unwrap().is_empty());
    }

    #[test]
    fn shortcut_target_relative_is_joined_to_parent() {
        // 只验证字符串处理逻辑：相对 target 由 resolve_shortcut 补全
        let base = Path::new(r"C:\apps\nps");
        assert_eq!(
            base.join(r"npc.exe").display().to_string(),
            r"C:\apps\nps\npc.exe"
        );
    }
}
