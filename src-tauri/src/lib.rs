mod daemon;
mod detect;
mod flutter;
mod harmony;
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
        .manage(pty::Registry::default())
        .manage(daemon::Daemons::default())
        .invoke_handler(tauri::generate_handler![
            load_state,
            state_location,
            add_project,
            remove_project,
            import_launch,
            detect_flutter,
            start_session,
            write_session,
            resize_session,
            kill_session,
            list_devices,
            launch_emulator,
            save_settings,
            detect_toolchains,
            list_all_emulators,
            launch_harmony_emulator,
            dev_autostart,
            dev_env
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
