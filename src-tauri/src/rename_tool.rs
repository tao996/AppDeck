//! Flutter `rename` CLI 集成：检查安装/PATH、读取与修改包名/应用名称。
//!
//! `rename` 由 `flutter pub global activate rename` 安装，Windows 上是
//! `<PUB_CACHE>\bin\rename.bat`。这里统一用绝对路径调用（即使没进 PATH 也能用），
//! 并解析 CLI 的 `=>` 输出供面板显示当前值。

use crate::model::State;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, State as TauriState};

/// `rename --targets` 支持的平台，顺序也用于复选框/命令预览。
const PLATFORMS: [&str; 6] = ["android", "ios", "macos", "linux", "web", "windows"];

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameStatus {
    /// `flutter pub global list` 里是否有 rename
    pub installed: bool,
    pub version: Option<String>,
    /// `rename` 是否在 PATH 中（没在 PATH 也能用绝对路径，但终端里敲不了）
    pub on_path: bool,
    /// 实际调用的 rename 可执行文件（PATH 或 PUB_CACHE\bin\rename.bat）
    pub exe: Option<String>,
    /// pub 的全局 bin 目录，提示用户加到 PATH
    pub pub_bin: String,
    pub flutter: Option<String>,
    pub flutter_source: String,
    /// 检查过程中的错误（没装 flutter / pub global list 失败等）
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProjectInfo {
    pub project_name: String,
    pub project_path: String,
    /// 项目里实际存在的平台目录
    pub platforms: Vec<String>,
    pub bundle_ids: BTreeMap<String, String>,
    pub app_names: BTreeMap<String, String>,
    pub log: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameApply {
    pub ok: bool,
    pub command: String,
    pub log: String,
    /// 本次目标平台更新后的值（重新 get 得到）
    pub values: BTreeMap<String, String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameActivation {
    pub status: RenameStatus,
    pub log: String,
}

/// 进程内缓存：首次打开面板/设置时检查一次，之后直接复用。
/// 「重新检查」按钮会绕过缓存；安装/更新成功后也会刷新缓存。
#[derive(Default)]
pub struct RenameCache(Mutex<Option<RenameStatus>>);

fn flutter_for(state: &State) -> (Option<PathBuf>, String) {
    // 全局检查不绑定具体项目：自定义路径 > PATH；空路径不会命中 .fvm
    crate::flutter::resolve(
        Path::new(""),
        state.settings.flutter_tool.custom_path.as_deref(),
    )
}

fn pub_bin_dir() -> PathBuf {
    if let Some(cache) = std::env::var_os("PUB_CACHE") {
        return PathBuf::from(cache).join("bin");
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local)
            .join("Pub")
            .join("Cache")
            .join("bin");
    }
    PathBuf::from("%PUB_CACHE%").join("bin")
}

fn rename_exe() -> Option<PathBuf> {
    if let Some(p) = crate::terminal::which("rename") {
        return Some(p);
    }
    // 没进 PATH：pub 的 bin 下也能找到；用它绝对路径调用
    let p = pub_bin_dir().join(if cfg!(windows) {
        "rename.bat"
    } else {
        "rename"
    });
    p.is_file().then_some(p)
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // CSI：跳过直到字母结束符（m / K / H …）
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// rename 的 box 表格 / 堆栈对用户没意义，只留下 `=>`、Targets 和真正的报错。
fn tidy_log(text: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in text.lines() {
        let t = line
            .trim()
            .trim_start_matches(|c: char| {
                matches!(c, '│' | '┌' | '└' | '├' | '┄' | '─' | ' ')
            })
            .trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("#0") || t.starts_with("#1") || t.contains("asynchronous suspension") {
            continue;
        }
        if t.chars()
            .all(|c| matches!(c, '┌' | '└' | '├' | '┄' | '─' | '│' | ' '))
        {
            continue;
        }
        out.push(t);
    }
    out.join("\n")
}

/// 跑一个外部命令并合并 stdout/stderr；`build_command` 负责 Windows .bat 包装。
fn run_tool(
    exe: &Path,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<(bool, String), String> {
    let mut cmd: Command = crate::flutter::build_command(exe, args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let out = cmd
        .output()
        .map_err(|e| format!("执行 {} 失败：{e}", exe.display()))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    Ok((out.status.success(), tidy_log(&strip_ansi(&text))))
}

fn parse_global_list(log: &str) -> Option<String> {
    for line in log.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("rename ") {
            let v = rest.split_whitespace().next().unwrap_or("").trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn build_status(state: &State) -> RenameStatus {
    let (flutter, source) = flutter_for(state);
    let pub_bin = pub_bin_dir().display().to_string();
    let which = crate::terminal::which("rename");
    let exe = rename_exe();
    let mut status = RenameStatus {
        installed: false,
        version: None,
        on_path: which.is_some(),
        exe: exe.map(|p| p.display().to_string()),
        pub_bin,
        flutter: flutter.as_ref().map(|p| p.display().to_string()),
        flutter_source: source,
        error: None,
    };

    let Some(flutter_exe) = flutter else {
        status.error = Some(
            "没有找到 flutter。请先在设置 → Flutter 指定路径，或把 flutter 加入 PATH。"
                .to_string(),
        );
        return status;
    };

    match run_tool(&flutter_exe, &["pub", "global", "list"], None) {
        Ok((ok, log)) => {
            status.version = parse_global_list(&log);
            status.installed = status.version.is_some();
            if !ok && !status.installed {
                status.error = Some(format!(
                    "flutter pub global list 执行失败；请检查 Flutter 安装。\n{log}"
                ));
            }
        }
        Err(e) => status.error = Some(e),
    }

    status
}

fn clean_targets(raw: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for p in PLATFORMS {
        if raw.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            out.push(p.to_string());
        }
    }
    if out.is_empty() {
        return Err("请至少选择一个平台".to_string());
    }
    Ok(out)
}

fn read_values(
    project: &Path,
    command: &str,
    targets: &[String],
) -> Result<(bool, BTreeMap<String, String>, String), String> {
    let targets_csv = targets.join(",");
    let exe = rename_exe()
        .ok_or_else(|| "找不到 rename 命令：请先执行 flutter pub global activate rename".to_string())?;
    let (ok, log) = run_tool(
        &exe,
        &[command, "--targets", &targets_csv],
        Some(project),
    )?;
    Ok((ok, parse_values(&log, command), log))
}

fn parse_values(log: &str, command: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let want = command.to_ascii_lowercase();
    for line in log.lines() {
        let Some((left, right)) = line.split_once("=>") else {
            continue;
        };
        // 同一份 log 里可能同时有 getBundleId / getAppName；只认目标命令
        if !left.to_ascii_lowercase().contains(&want) {
            continue;
        }
        let platform = left.split_whitespace().find_map(|w| {
            let w = w.to_ascii_lowercase();
            PLATFORMS.contains(&w.as_str()).then_some(w)
        });
        let Some(platform) = platform else { continue };

        let value = right
            .trim()
            .trim_end_matches(';')
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim_end_matches(';')
            .trim();
        if !value.is_empty() {
            map.insert(platform, value.to_string());
        }
    }
    map
}

fn cached_status(
    app: &AppHandle,
    cache: &RenameCache,
    force: bool,
) -> Result<RenameStatus, String> {
    if !force {
        let guard = cache
            .0
            .lock()
            .map_err(|_| "rename 缓存锁定失败".to_string())?;
        if let Some(status) = guard.as_ref() {
            return Ok(status.clone());
        }
    }

    let state = store_state(app)?;
    let status = build_status(&state);
    let mut guard = cache
        .0
        .lock()
        .map_err(|_| "rename 缓存锁定失败".to_string())?;
    *guard = Some(status.clone());
    Ok(status)
}

#[tauri::command]
pub fn rename_status(
    app: AppHandle,
    cache: TauriState<'_, RenameCache>,
) -> Result<RenameStatus, String> {
    cached_status(&app, &cache, false)
}

/// 设置里的「重新检查」：绕过缓存重新跑 `flutter pub global list`。
#[tauri::command]
pub fn rename_refresh(
    app: AppHandle,
    cache: TauriState<'_, RenameCache>,
) -> Result<RenameStatus, String> {
    cached_status(&app, &cache, true)
}

#[tauri::command]
pub fn rename_activate(
    app: AppHandle,
    cache: TauriState<'_, RenameCache>,
) -> Result<RenameActivation, String> {
    let state = store_state(&app)?;
    let (flutter, _) = flutter_for(&state);
    let Some(flutter_exe) = flutter else {
        return Err(
            "没有找到 flutter，无法执行 flutter pub global activate rename".to_string(),
        );
    };

    let (ok, log) =
        run_tool(&flutter_exe, &["pub", "global", "activate", "rename"], None)?;
    if !ok {
        return Err(format!(
            "flutter pub global activate rename 失败：\n{log}"
        ));
    }
    let status = build_status(&state);
    if let Ok(mut guard) = cache.0.lock() {
        *guard = Some(status.clone());
    }
    Ok(RenameActivation { status, log })
}

#[tauri::command]
pub fn rename_project_info(app: AppHandle, project_id: String) -> Result<RenameProjectInfo, String> {
    let state = store_state(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    if !root.is_dir() {
        return Err(format!("项目目录不存在：{}", project.path));
    }

    let mut platforms: Vec<String> = Vec::new();
    for p in PLATFORMS {
        if root.join(p).is_dir() {
            platforms.push(p.to_string());
        }
    }
    if platforms.is_empty() {
        return Err(
            "项目里没有 android / ios / macos / linux / web / windows 平台目录，无法使用 rename"
                .to_string(),
        );
    }

    let (bundle_res, name_res) = std::thread::scope(|scope| {
        let bundle = scope.spawn(|| read_values(&root, "getBundleId", &platforms));
        let name = scope.spawn(|| read_values(&root, "getAppName", &platforms));
        (bundle.join().unwrap(), name.join().unwrap())
    });
    let (ok_bundle, bundle_ids, log_bundle) = bundle_res?;
    let (ok_name, app_names, log_name) = name_res?;

    if bundle_ids.is_empty() && app_names.is_empty() {
        return Err(format!(
            "rename 读取失败（getBundleId={ok_bundle}, getAppName={ok_name}）：\n{log_bundle}\n{log_name}"
        ));
    }

    let mut log = String::new();
    if !log_bundle.trim().is_empty() {
        log.push_str(&log_bundle);
    }
    if !log_name.trim().is_empty() {
        if !log.is_empty() {
            log.push_str("\n\n");
        }
        log.push_str(&log_name);
    }

    Ok(RenameProjectInfo {
        project_name: project.name.clone(),
        project_path: project.path.clone(),
        platforms,
        bundle_ids,
        app_names,
        log,
    })
}

#[tauri::command]
pub fn rename_apply(
    app: AppHandle,
    project_id: String,
    action: String,
    targets: Vec<String>,
    value: String,
) -> Result<RenameApply, String> {
    let state = store_state(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    if !root.is_dir() {
        return Err(format!("项目目录不存在：{}", project.path));
    }

    let targets = clean_targets(&targets)?;
    let value = value.trim();
    if value.is_empty() {
        return Err("值不能为空".to_string());
    }
    if value.chars().count() > 200 {
        return Err("值最多 200 个字符".to_string());
    }
    if value.chars().any(char::is_control) {
        return Err("值不能包含换行、制表符等控制字符".to_string());
    }

    let (command, getter) = match action.as_str() {
        "bundle" => ("setBundleId", "getBundleId"),
        "name" => ("setAppName", "getAppName"),
        _ => return Err("未知操作：只支持 bundle / name".to_string()),
    };

    if command == "setBundleId" && value.chars().any(char::is_whitespace) {
        return Err("包名不能包含空格".to_string());
    }

    let exe = rename_exe()
        .ok_or_else(|| "找不到 rename 命令：请先执行 flutter pub global activate rename".to_string())?;
    let targets_csv = targets.join(",");
    let (ok, log) = run_tool(
        &exe,
        &[command, "--targets", &targets_csv, "--value", value],
        Some(&root),
    )?;
    if !ok {
        return Err(format!("rename {command} 失败：\n{log}"));
    }

    // 成功后重新读一遍目标平台的实际值，面板据此刷新
    let (_, values, get_log) = read_values(&root, getter, &targets)?;
    let mut all_log = log;
    if !get_log.trim().is_empty() {
        if !all_log.is_empty() {
            all_log.push_str("\n\n");
        }
        all_log.push_str(&get_log);
    }

    Ok(RenameApply {
        ok: true,
        command: format!(
            "rename {command} --targets {targets_csv} --value \"{value}\""
        ),
        log: all_log,
        values,
    })
}

fn store_state(app: &AppHandle) -> Result<State, String> {
    crate::store::load(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_get_output_with_quotes_and_semicolons() {
        let log = "Targets: [android, ios]\n\
             │ 💡 ANDROID getBundleId => \"com.example.today\"\n\
             │ 💡 IOS getBundleId => com.example.today;\n";
        let m = parse_values(log, "getBundleId");
        assert_eq!(m.get("android").map(String::as_str), Some("com.example.today"));
        assert_eq!(m.get("ios").map(String::as_str), Some("com.example.today"));
        assert_eq!(m.get("android"), m.get("ios"));
    }

    #[test]
    fn parses_app_name_with_spaces() {
        let log = "│ 💡 IOS getAppName => My Today App;\n";
        let m = parse_values(log, "getAppName");
        assert_eq!(m.get("ios").map(String::as_str), Some("My Today App"));
    }

    #[test]
    fn parses_only_requested_command() {
        let log = "│ 💡 ANDROID getBundleId => com.example.a\n\
                   │ 💡 ANDROID getAppName => A;\n";
        assert_eq!(
            parse_values(log, "getBundleId")
                .get("android")
                .map(String::as_str),
            Some("com.example.a")
        );
        assert_eq!(
            parse_values(log, "getAppName")
                .get("android")
                .map(String::as_str),
            Some("A")
        );
    }

    #[test]
    fn clean_targets_keeps_known_platforms_and_order() {
        let got = clean_targets(&[
            "ios".to_string(),
            "android".to_string(),
            "android".to_string(),
            "bogus".to_string(),
        ])
        .unwrap();
        assert_eq!(got, vec!["android", "ios"]);
        assert!(clean_targets(&["bogus".to_string()]).is_err());
    }

    #[test]
    fn strips_ansi_colors() {
        let raw = "\x1b[38;5;12m│ 💡 ANDROID => x\x1b[0m";
        assert_eq!(strip_ansi(raw), "│ 💡 ANDROID => x");
    }

    #[test]
    fn tidies_box_art_and_stack_frames() {
        let raw = "Targets: [android, ios]\r\n\
                   ┌────────────────────────\r\n\
                   │ #0   Rename._handleCommand (package:rename/rename.dart:153:16)\r\n\
                   │ #1   <asynchronous suspension>\r\n\
                   ├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\r\n\
                   │ 💡 ANDROID getBundleId => \"com.example.today\"\r\n\
                   │ ⛔ CustomException: bad path\r\n\
                   └────────────────────────\r\n";
        let got = tidy_log(raw);
        assert_eq!(
            got,
            "Targets: [android, ios]\n💡 ANDROID getBundleId => \"com.example.today\"\n⛔ CustomException: bad path"
        );
    }

    #[test]
    fn parses_pub_global_list() {
        let log = "No dependencies would change in `D:\\pub\\global_packages\\rename`.\nrename 3.1.0\n";
        assert_eq!(parse_global_list(log).as_deref(), Some("3.1.0"));
    }
}
