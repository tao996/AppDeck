mod daemon;
mod detect;
mod flutter;
mod harmony;
mod logs;
mod jsonc;
mod launch;
mod model;
mod ops;
mod pty;
mod store;

use model::State;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

static SEQ: AtomicU64 = AtomicU64::new(0);

/* ---------------- 状态 ---------------- */

#[tauri::command]
fn load_state(app: AppHandle) -> Result<State, String> {
    store::load(&app)
}

#[tauri::command]
fn state_location(app: AppHandle) -> String {
    store::location(&app)
}

#[tauri::command]
fn add_project(app: AppHandle, path: String) -> Result<State, String> {
    let mut state = store::load(&app)?;
    ops::add_project_to(&mut state, &path)?;
    store::save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
fn remove_project(app: AppHandle, id: String) -> Result<State, String> {
    let mut state = store::load(&app)?;
    state.projects.retain(|p| p.id != id);
    store::save(&app, &state)?;
    Ok(state)
}

#[derive(serde::Serialize)]
struct ImportResponse {
    state: State,
    total: usize,
    imported: usize,
    skipped: usize,
    warnings: Vec<String>,
}

#[tauri::command]
fn import_launch(app: AppHandle, project_id: String) -> Result<ImportResponse, String> {
    let mut state = store::load(&app)?;
    let outcome = ops::import_into(&mut state, &project_id)?;
    store::save(&app, &state)?;

    Ok(ImportResponse {
        state,
        total: outcome.total,
        imported: outcome.imported,
        skipped: outcome.skipped,
        warnings: outcome.warnings,
    })
}

#[tauri::command]
fn detect_flutter(app: AppHandle, project_id: String) -> Result<flutter::FlutterInfo, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|x| x.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let custom = state
        .settings
        .flutter_tool
        .custom_path
        .clone()
        .or_else(|| {
            project
                .flutter_tool
                .as_ref()
                .and_then(|f| f.custom_path.clone())
        });

    Ok(flutter::detect(
        PathBuf::from(&project.path).as_path(),
        custom.as_deref(),
    ))
}

/* ---------------- 会话 ---------------- */

#[derive(serde::Serialize)]
struct StartResponse {
    id: String,
    pid: u32,
    title: String,
    device: String,
    cwd: String,
    program: String,
    args: Vec<String>,
}

fn session_of(
    reg: &pty::Registry,
    id: &str,
) -> Result<Arc<pty::Session>, String> {
    let map = reg
        .0
        .lock()
        .map_err(|_| "会话注册表锁定失败".to_string())?;
    map.get(id)
        .cloned()
        .ok_or_else(|| "会话不存在或已结束".to_string())
}

#[tauri::command]
fn start_session(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    project_id: String,
    command_id: String,
    device_id: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<StartResponse, String> {
    let state = store::load(&app)?;
    let plan = ops::build_plan(&state, &project_id, &command_id, device_id.as_deref())?;

    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let id = format!("sess-{seq}");

    let session = pty::spawn(
        app.clone(),
        id.clone(),
        &plan.program,
        &plan.args,
        plan.cwd.clone(),
        &plan.env,
        rows,
        cols,
    )?;

    let pid = session.pid;
    reg.0
        .lock()
        .map_err(|_| "会话注册表锁定失败".to_string())?
        .insert(id.clone(), session);

    Ok(StartResponse {
        id,
        pid,
        title: plan.title,
        device: plan.device,
        cwd: plan.cwd.display().to_string(),
        program: plan.program,
        args: plan.args,
    })
}

/// 全局模板直接执行：不写入项目命令列表
#[tauri::command]
fn start_template_session(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    project_id: String,
    template_id: String,
    device_id: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<StartResponse, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let template = state
        .command_templates
        .iter()
        .find(|t| t.id == template_id)
        .ok_or_else(|| "模板不存在".to_string())?;

    let plan = ops::build_plan_for(&state, project, template, device_id.as_deref())?;

    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let id = format!("sess-{seq}");

    let session = pty::spawn(
        app.clone(),
        id.clone(),
        &plan.program,
        &plan.args,
        plan.cwd.clone(),
        &plan.env,
        rows,
        cols,
    )?;

    let pid = session.pid;
    reg.0
        .lock()
        .map_err(|_| "会话注册表锁定失败".to_string())?
        .insert(id.clone(), session);

    Ok(StartResponse {
        id,
        pid,
        title: plan.title,
        device: plan.device,
        cwd: plan.cwd.display().to_string(),
        program: plan.program,
        args: plan.args,
    })
}

#[tauri::command]
fn write_session(
    reg: tauri::State<'_, pty::Registry>,
    id: String,
    data: String,
) -> Result<(), String> {
    session_of(&reg, &id)?.write(&data)
}

#[tauri::command]
fn resize_session(
    reg: tauri::State<'_, pty::Registry>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    session_of(&reg, &id)?.resize(rows, cols)
}

#[tauri::command]
fn kill_session(app: AppHandle, reg: tauri::State<'_, pty::Registry>, id: String) -> bool {
    let killed = pty::kill(&reg, &id);
    let _ = app.emit(
        "pty://exit",
        pty::ExitPayload {
            id,
            code: None,
        },
    );
    killed
}

/* ---------------- 设备与模拟器 ---------------- */

fn flutter_exe_for(state: &State, project_id: &str) -> Result<PathBuf, String> {
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let custom = project
        .flutter_tool
        .as_ref()
        .and_then(|f| f.custom_path.clone())
        .or_else(|| state.settings.flutter_tool.custom_path.clone());

    let root = PathBuf::from(&project.path);
    let (exe, _) = flutter::resolve(&root, custom.as_deref());
    exe.ok_or_else(|| "未找到 flutter 可执行文件".to_string())
}

fn device_sink(app: &AppHandle) -> daemon::EventSink {
    let app = app.clone();
    std::sync::Arc::new(move |p: daemon::DevicesPayload| {
        let _ = app.emit("devices://changed", p);
    })
}

#[tauri::command]
fn list_devices(
    app: AppHandle,
    reg: tauri::State<'_, daemon::Daemons>,
    project_id: String,
) -> Result<daemon::DevicesPayload, String> {
    let state = store::load(&app)?;
    let exe = flutter_exe_for(&state, &project_id)?;
    let d = daemon::get_or_start(&reg, &exe, device_sink(&app))?;

    match d.request("device.getDevices", None) {
        Ok(v) => match serde_json::from_value::<Vec<daemon::DeviceInfo>>(v) {
            Ok(list) => d.set_devices(list),
            Err(e) => return Err(format!("解析设备列表失败: {e}")),
        },
        Err(e) => return Err(e),
    }

    // 模拟器不可用（如未装 Android SDK）不算致命
    if let Ok(v) = d.request("emulator.getEmulators", None) {
        if let Ok(list) = serde_json::from_value::<Vec<daemon::EmulatorInfo>>(v) {
            d.set_emulators(list);
        }
    }

    Ok(d.snapshot())
}

#[tauri::command]
fn launch_emulator(
    app: AppHandle,
    reg: tauri::State<'_, daemon::Daemons>,
    project_id: String,
    emulator_id: String,
) -> Result<(), String> {
    let state = store::load(&app)?;
    let exe = flutter_exe_for(&state, &project_id)?;
    let d = daemon::get_or_start(&reg, &exe, device_sink(&app))?;
    d.request(
        "emulator.launch",
        Some(serde_json::json!({ "emulatorId": emulator_id })),
    )?;
    Ok(())
}

/* ---------------- 发布构建 ---------------- */

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildTarget {
    name: String,
    description: String,
    supports_flavor: bool,
}

#[derive(Default)]
struct TargetCache(std::sync::Mutex<std::collections::HashMap<String, Vec<BuildTarget>>>);

fn run_flutter(exe: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = flutter::build_command(exe, args);
    flutter::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("执行 flutter 失败: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(text)
}

/// 解析 `flutter build --help` 的子命令列表，并逐目标探测 `--flavor` 支持。
/// 实测：apk / appbundle / windows 支持，web 不支持，且 Windows 宿主没有 ipa / macos。
fn detect_targets(exe: &std::path::Path) -> Result<Vec<BuildTarget>, String> {
    let help = run_flutter(exe, &["build", "--help"])?;
    let mut targets: Vec<BuildTarget> = Vec::new();
    let mut in_list = false;

    for line in help.lines() {
        if line.contains("Available subcommands:") {
            in_list = true;
            continue;
        }
        if !in_list {
            continue;
        }

        let s = line.trim_end().trim_start();
        if s.is_empty() {
            continue;
        }

        let mut it = s.splitn(2, char::is_whitespace);
        let Some(name) = it.next() else { continue };
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            in_list = false;
            continue;
        }

        targets.push(BuildTarget {
            name: name.to_string(),
            description: it.next().unwrap_or("").trim().to_string(),
            supports_flavor: false,
        });
    }

    if targets.is_empty() {
        return Err("未能解析 flutter build 的子命令列表".to_string());
    }

    let names: Vec<String> = targets.iter().map(|t| t.name.clone()).collect();
    let flags: Vec<(String, bool)> = std::thread::scope(|scope| {
        let handles: Vec<_> = names
            .iter()
            .map(|n| {
                let n = n.clone();
                let exe = exe.to_path_buf();
                scope.spawn(move || {
                    let ok = run_flutter(&exe, &["build", &n, "--help"])
                        .map(|h| h.contains("--flavor"))
                        .unwrap_or(false);
                    (n, ok)
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });

    for (n, ok) in flags {
        if let Some(t) = targets.iter_mut().find(|t| t.name == n) {
            t.supports_flavor = ok;
        }
    }

    Ok(targets)
}

#[tauri::command]
fn build_targets(
    app: AppHandle,
    cache: tauri::State<'_, TargetCache>,
    project_id: Option<String>,
) -> Result<Vec<BuildTarget>, String> {
    let state = store::load(&app)?;
    let exe = match project_id {
        Some(pid) => flutter_exe_for(&state, &pid)?,
        None => {
            // 模板编辑时可能还没有项目：退回 PATH / 设置里的 Flutter
            let custom = state.settings.flutter_tool.custom_path.clone();
            flutter::resolve(std::path::Path::new("."), custom.as_deref())
                .0
                .ok_or_else(|| "未找到 flutter 可执行文件".to_string())?
        }
    };
    let key = exe.display().to_string();

    if let Ok(map) = cache.0.lock() {
        if let Some(list) = map.get(&key) {
            return Ok(list.clone());
        }
    }

    let list = detect_targets(&exe)?;
    if let Ok(mut map) = cache.0.lock() {
        map.insert(key, list.clone());
    }
    Ok(list)
}

/* ---------------- 命令增删 ---------------- */

#[tauri::command]
fn upsert_command(
    app: AppHandle,
    project_id: String,
    command: model::Command,
) -> Result<State, String> {
    let mut state = store::load(&app)?;
    let idx = state
        .projects
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let mut cmd = command;
    if cmd.id.trim().is_empty() {
        cmd.id = model::make_id("cmd", &format!("{}|{}|{}", project_id, cmd.name, cmd.kind));
    }

    let project = &mut state.projects[idx];
    match project.commands.iter_mut().find(|c| c.id == cmd.id) {
        Some(existing) => *existing = cmd,
        None => project.commands.push(cmd),
    }

    store::save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
fn remove_command(
    app: AppHandle,
    project_id: String,
    command_id: String,
) -> Result<State, String> {
    let mut state = store::load(&app)?;
    let project = state
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    project.commands.retain(|c| c.id != command_id);
    store::save(&app, &state)?;
    Ok(state)
}

/* ---------------- 全局命令模板 ---------------- */

#[tauri::command]
fn upsert_template(app: AppHandle, template: model::Command) -> Result<State, String> {
    let mut state = store::load(&app)?;
    let mut tpl = template;
    if tpl.id.trim().is_empty() {
        tpl.id = model::make_id("tpl", &format!("{}|{}", tpl.name, tpl.kind));
    }
    tpl.source = Some("template".to_string());

    match state
        .command_templates
        .iter_mut()
        .find(|t| t.id == tpl.id)
    {
        Some(existing) => *existing = tpl,
        None => state.command_templates.push(tpl),
    }

    store::save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
fn remove_template(app: AppHandle, id: String) -> Result<State, String> {
    let mut state = store::load(&app)?;
    state.command_templates.retain(|t| t.id != id);
    store::save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
fn reset_templates(app: AppHandle) -> Result<State, String> {
    let mut state = store::load(&app)?;
    state.command_templates = model::default_templates();
    store::save(&app, &state)?;
    Ok(state)
}

#[derive(serde::Serialize)]
struct ImportTemplatesResponse {
    state: State,
    added: usize,
}

#[tauri::command]
fn import_templates(
    app: AppHandle,
    project_id: String,
    template_ids: Vec<String>,
) -> Result<ImportTemplatesResponse, String> {
    let mut state = store::load(&app)?;
    let added = ops::import_templates(&mut state, &project_id, &template_ids)?;
    store::save(&app, &state)?;
    Ok(ImportTemplatesResponse { state, added })
}

/* ---------------- 会话恢复（D-10） ---------------- */

#[tauri::command]
fn save_session_logs(app: AppHandle, mut logs: Vec<logs::SessionLog>) -> Result<(), String> {
    let now = logs::now_ms();
    for l in logs.iter_mut() {
        if l.saved_at == 0 {
            l.saved_at = now;
        }
    }
    let path = logs::path_of(&app)?;
    logs::save_to(&path, logs)
}

#[tauri::command]
fn load_session_logs(app: AppHandle) -> Vec<logs::SessionLog> {
    match logs::path_of(&app) {
        Ok(p) => logs::load_from(&p),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
fn clear_session_logs(app: AppHandle) -> Result<(), String> {
    let path = logs::path_of(&app)?;
    logs::save_to(&path, Vec::new())
}

/* ---------------- 设置与工具链 ---------------- */

#[tauri::command]
fn save_settings(app: AppHandle, settings: model::Settings) -> Result<State, String> {
    let mut state = store::load(&app)?;
    state.settings = settings;
    store::save(&app, &state)?;
    Ok(state)
}

#[tauri::command]
fn detect_toolchains() -> detect::Detected {
    detect::detect()
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct EmulatorEntry {
    id: String,
    name: String,
    detail: String,
    kind: String,
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AllEmulators {
    android: Vec<EmulatorEntry>,
    harmony: Vec<EmulatorEntry>,
    notes: Vec<String>,
}

/// 未显式配置时回退到自动探测结果，保证开箱即用
fn effective_harmony(state: &State) -> model::HarmonySettings {
    if state
        .settings
        .harmony
        .emulator_path
        .as_ref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false)
    {
        state.settings.harmony.clone()
    } else {
        detect::detect().harmony
    }
}

/// 聚合两个来源：Android（flutter daemon）+ HarmonyOS（Emulator.exe -list）
#[tauri::command]
fn list_all_emulators(
    app: AppHandle,
    reg: tauri::State<'_, daemon::Daemons>,
    project_id: Option<String>,
) -> AllEmulators {
    let mut out = AllEmulators::default();

    let state = match store::load(&app) {
        Ok(s) => s,
        Err(e) => {
            out.notes.push(e);
            return out;
        }
    };

    match harmony::list(&effective_harmony(&state)) {
        Ok(list) => {
            out.harmony = list
                .into_iter()
                .map(|h| EmulatorEntry {
                    id: h.name.clone(),
                    name: h.name,
                    detail: h.detail,
                    kind: "harmony".into(),
                })
                .collect()
        }
        Err(e) => out.notes.push(e),
    }

    let target = project_id.or_else(|| state.projects.first().map(|p| p.id.clone()));
    match target {
        Some(pid) => match flutter_exe_for(&state, &pid) {
            Ok(exe) => match daemon::get_or_start(&reg, &exe, device_sink(&app)) {
                Ok(d) => match d.request("emulator.getEmulators", None) {
                    Ok(v) => {
                        if let Ok(list) = serde_json::from_value::<Vec<daemon::EmulatorInfo>>(v) {
                            out.android = list
                                .into_iter()
                                .map(|m| EmulatorEntry {
                                    detail: format!(
                                        "{} · {}",
                                        m.id,
                                        m.category.unwrap_or_else(|| "android".into())
                                    ),
                                    id: m.id,
                                    name: m.name,
                                    kind: "android".into(),
                                })
                                .collect();
                        }
                    }
                    Err(e) => out.notes.push(format!("Android: {e}")),
                },
                Err(e) => out.notes.push(format!("Android: {e}")),
            },
            Err(e) => out.notes.push(format!("Android: {e}")),
        },
        None => out
            .notes
            .push("Android 模拟器需要先添加至少一个 Flutter 项目".into()),
    }

    out
}

#[tauri::command]
fn launch_harmony_emulator(app: AppHandle, name: String) -> Result<(), String> {
    let state = store::load(&app)?;
    harmony::start(&effective_harmony(&state), &name)
}

/* ---------------- 开发期钩子 ---------------- */

/// 自动化/调试用：设置 `FLA_AUTOSTART="<项目ID>|<命令ID>|<设备ID?>"` 后，
/// 应用启动时会自动运行该命令，便于在无法交互的环境里验证终端链路。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DevAutostart {
    project_id: String,
    command_id: String,
    device_id: Option<String>,
}

#[tauri::command]
fn dev_env(name: String) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

#[tauri::command]
fn dev_autostart() -> Option<DevAutostart> {
    let raw = std::env::var("FLA_AUTOSTART").ok()?;
    let mut parts = raw.split('|');
    let project_id = parts.next()?.trim().to_string();
    let command_id = parts.next()?.trim().to_string();
    let device_id = parts
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if project_id.is_empty() || command_id.is_empty() {
        return None;
    }

    Some(DevAutostart {
        project_id,
        command_id,
        device_id,
    })
}

/* ---------------- 入口 ---------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::Registry::default())
        .manage(daemon::Daemons::default())
        .manage(TargetCache::default())
        .invoke_handler(tauri::generate_handler![
            load_state,
            state_location,
            add_project,
            remove_project,
            import_launch,
            detect_flutter,
            start_session,
            start_template_session,
            write_session,
            resize_session,
            kill_session,
            list_devices,
            launch_emulator,
            build_targets,
            upsert_command,
            remove_command,
            upsert_template,
            remove_template,
            reset_templates,
            import_templates,
            save_settings,
            detect_toolchains,
            save_session_logs,
            load_session_logs,
            clear_session_logs,
            list_all_emulators,
            launch_harmony_emulator,
            dev_autostart,
            dev_env
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
