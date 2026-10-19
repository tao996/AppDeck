mod flutter;
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
            dev_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
