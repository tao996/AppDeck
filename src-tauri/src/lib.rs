mod android;
mod apksig;
mod atomic;
mod locate;
mod editor;
mod project_files;
mod tauri_cli;
mod cache;
mod daemon;
mod docker;
mod detect;
mod doctor;
mod filing;
mod flutter;
mod harmony;
mod logs;
mod platforms;
mod jsonc;
mod launch;
mod model;
mod npm;
mod ops;
mod pty;
mod store;
mod terminal;

use model::State;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportPathResponse {
    state: State,
    project_id: String,
    project_name: String,
    /// single（Flutter 项目）| workspace（命令集）
    kind: String,
    created: bool,
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

/// 导入 docker-compose：按 service 生成「启动 / 日志 / 全部停止」
#[tauri::command]
fn import_compose_path(app: AppHandle, path: String) -> Result<ComposeImportResponse, String> {
    let mut state = store::load(&app)?;
    let (project, outcome, created, services) = ops::import_compose_from_path(&mut state, &path)?;
    store::save(&app, &state)?;

    if let Ok(mut map) = app.state::<PlatformCache>().0.lock() {
        map.remove(&project.id);
    }

    Ok(ComposeImportResponse {
        state,
        project_id: project.id,
        project_name: project.name,
        created,
        services,
        added: outcome.added,
        kept: outcome.kept,
        stale: outcome.stale,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposeImportResponse {
    state: State,
    project_id: String,
    project_name: String,
    created: bool,
    services: usize,
    added: Vec<String>,
    kept: Vec<String>,
    stale: Vec<String>,
}

/// 导入 package.json：解析 scripts 生成命令（生态挂在命令上，source = "npm"）
/// 里面会跑一次 `tauri --help` 探测子命令（约 1 秒），所以放线程池，别占主线程。
#[tauri::command(async)]
fn import_package_path(app: AppHandle, path: String) -> Result<NpmImportResponse, String> {
    let mut state = store::load(&app)?;
    let (project, outcome, created, manager) = ops::import_package_from_path(&mut state, &path)?;
    store::save(&app, &state)?;

    Ok(NpmImportResponse {
        state,
        project_id: project.id,
        project_name: project.name,
        manager: manager.exe().to_string(),
        created,
        added: outcome.added,
        kept: outcome.kept,
        stale: outcome.stale,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NpmImportResponse {
    state: State,
    project_id: String,
    project_name: String,
    manager: String,
    created: bool,
    added: Vec<String>,
    kept: Vec<String>,
    stale: Vec<String>,
}

/// 从路径导入 launch.json：目录有 pubspec.yaml 就当普通 Flutter 项目，
/// 否则当命令集（命令集没有平台菜单、也不显示全局命令）。
#[tauri::command]
fn import_launch_path(
    app: AppHandle,
    path: String,
) -> Result<ImportPathResponse, String> {
    let mut state = store::load(&app)?;
    let (project, outcome, created) = ops::import_launch_from_path(&mut state, &path)?;
    store::save(&app, &state)?;

    // 项目的平台信息可能因重新导入而变化
    if let Ok(mut map) = app.state::<PlatformCache>().0.lock() {
        map.remove(&project.id);
    }

    Ok(ImportPathResponse {
        state,
        project_id: project.id,
        project_name: project.name,
        kind: project.kind,
        created,
        total: outcome.total,
        imported: outcome.imported,
        skipped: outcome.skipped,
        warnings: outcome.warnings,
    })
}

#[tauri::command(async)]
fn detect_flutter(app: AppHandle, project_id: String) -> Result<flutter::FlutterInfo, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|x| x.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let root = PathBuf::from(&project.path);

    // 必须走项目上下文：直接调 flutter::detect 只看 PATH/FVM，
    // 会把鸿蒙工程显示成标准 flutter 的版本号（踩过）
    match flutter::ctx_for(&state, project, &root) {
        Ok(ctx) => Ok(flutter::probe(
            &ctx.exe,
            &ctx.env_with_path(),
            &ctx.source,
            &root,
        )),
        Err(e) => Ok(flutter::FlutterInfo {
            source: "none".to_string(),
            error: Some(e),
            ..Default::default()
        }),
    }
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
    /// 「预填」用：需要输入到终端提示符、但**不回车**的命令行
    #[serde(skip_serializing_if = "Option::is_none")]
    prefill: Option<String>,
    /// 是否复用了已有终端（true 时前端只聚焦，不新建标签）
    #[serde(skip_serializing_if = "Option::is_none")]
    reused: Option<bool>,
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
    // 带时间戳：恢复自磁盘的旧会话可能已占用 sess-N，纯序号会撞号
    let id = format!("sess-{}-{seq}", logs::now_ms());

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
        prefill: None,
        reused: None,
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
    // 带时间戳：恢复自磁盘的旧会话可能已占用 sess-N，纯序号会撞号
    let id = format!("sess-{}-{seq}", logs::now_ms());

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
        prefill: None,
        reused: None,
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

/// 项目的运行上下文（exe + 环境 + shim）。所有"跑 flutter"的入口都该用它，
/// 否则会出现"设备列表用鸿蒙分支、构建却用标准 flutter"这种分裂。
fn project_ctx(state: &State, project_id: &str) -> Result<flutter::Ctx, String> {
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    flutter::ctx_for(state, project, &PathBuf::from(&project.path))
}

/// 有项目就用项目上下文；没有项目（如模板编辑）退回 PATH / 设置里的 flutter
fn ctx_or_default(state: &State, project_id: Option<&str>) -> Result<flutter::Ctx, String> {
    match project_id {
        Some(pid) => project_ctx(state, pid),
        None => {
            let custom = state.settings.flutter_tool.custom_path.clone();
            let (exe, source) = flutter::resolve(std::path::Path::new("."), custom.as_deref());
            let exe = exe.ok_or_else(|| "未找到 flutter 可执行文件".to_string())?;
            Ok(flutter::Ctx {
                exe,
                env: Vec::new(),
                path_prepend: None,
                source,
            })
        }
    }
}
fn device_sink(app: &AppHandle) -> daemon::EventSink {
    let app = app.clone();
    std::sync::Arc::new(move |p: daemon::DevicesPayload| {
        let _ = app.emit("devices://changed", p);
    })
}

#[tauri::command(async)]
fn list_devices(
    app: AppHandle,
    reg: tauri::State<'_, daemon::Daemons>,
    project_id: String,
) -> Result<daemon::DevicesPayload, String> {
    let state = store::load(&app)?;
    let ctx = project_ctx(&state, &project_id)?;
    let d = daemon::get_or_start(&reg, &ctx.exe, &ctx.env_with_path(), device_sink(&app))?;

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

#[tauri::command(async)]
fn launch_emulator(
    app: AppHandle,
    reg: tauri::State<'_, daemon::Daemons>,
    project_id: String,
    emulator_id: String,
) -> Result<(), String> {
    let state = store::load(&app)?;

    // 优先直接用 emulator.exe：它会带上设置里的 SDK / AVD 目录
    if let Some(r) = android::resolve(&effective_android(&state)) {
        return android::start_avd(&r, &emulator_id);
    }

    // 退回 flutter daemon（只认得默认 AVD 目录）
    let ctx = project_ctx(&state, &project_id)?;
    let d = daemon::get_or_start(&reg, &ctx.exe, &ctx.env_with_path(), device_sink(&app))?;
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

#[tauri::command(async)]
fn build_targets(
    app: AppHandle,
    cache: tauri::State<'_, TargetCache>,
    project_id: Option<String>,
) -> Result<Vec<BuildTarget>, String> {
    let state = store::load(&app)?;
    let ctx = ctx_or_default(&state, project_id.as_deref())?;
    let exe = ctx.exe;
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

/* ---------------- 平台动作（派生，不落盘） ---------------- */

/// 宿主能构建哪些目标（复用 TargetCache）
fn host_target_names(
    app: &AppHandle,
    cache: &TargetCache,
    project_id: &str,
) -> Result<Vec<String>, String> {
    let state = store::load(app)?;
    let ctx = project_ctx(&state, project_id)?;
    let exe = ctx.exe;
    let key = exe.display().to_string();

    if let Ok(map) = cache.0.lock() {
        if let Some(list) = map.get(&key) {
            return Ok(list.iter().map(|t| t.name.clone()).collect());
        }
    }

    let list = detect_targets(&exe)?;
    if let Ok(mut map) = cache.0.lock() {
        map.insert(key, list.clone());
    }
    Ok(list.into_iter().map(|t| t.name).collect())
}

fn devices_snapshot(
    app: &AppHandle,
    reg: &daemon::Daemons,
    project_id: &str,
) -> Result<Vec<daemon::DeviceInfo>, String> {
    let state = store::load(app)?;
    let ctx = project_ctx(&state, project_id)?;
    let d = daemon::get_or_start(reg, &ctx.exe, &ctx.env_with_path(), device_sink(app))?;
    let v = d.request("device.getDevices", None)?;
    serde_json::from_value(v).map_err(|e| format!("解析设备列表失败: {e}"))
}

/// 平台矩阵缓存：分析一次就留着，只有点「重新分析」才刷新。
/// 首次分析要跑 6 次 `flutter build <t> --help` 并拉起 daemon，约十秒量级。
#[derive(Default)]
struct PlatformCache(std::sync::Mutex<std::collections::HashMap<String, platforms::PlatformMatrix>>);

fn platform_matrix_impl(
    app: &AppHandle,
    project_id: &str,
    force: bool,
) -> Result<platforms::PlatformMatrix, String> {
    let pcache = app.state::<PlatformCache>();

    if !force {
        // 1) 进程内缓存
        if let Ok(map) = pcache.0.lock() {
            if let Some(hit) = map.get(project_id) {
                return Ok(hit.clone());
            }
        }

        // 2) 磁盘缓存（跨重启有效）
        let disk = read_disk_cache(app);
        if let Some(hit) = disk.platforms.get(project_id) {
            if let Ok(mut map) = pcache.0.lock() {
                map.insert(project_id.to_string(), hit.matrix.clone());
            }
            return Ok(hit.matrix.clone());
        }
    }

    let state = store::load(app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    // 命令集（无 pubspec 的 workspace）没有平台菜单
    let matrix = if project.kind != "single" {
        platforms::matrix(project, &[], &[], None)
    } else {
        let cache = app.state::<TargetCache>();
        let reg = app.state::<daemon::Daemons>();

        let targets = host_target_names(app, &cache, project_id)?;
        let (devices, device_error) = match devices_snapshot(app, &reg, project_id) {
            Ok(list) => (list, None),
            Err(e) => (Vec::new(), Some(e)),
        };

        platforms::matrix(project, &targets, &devices, device_error)
    };

    if let Ok(mut map) = pcache.0.lock() {
        map.insert(project_id.to_string(), matrix.clone());
    }
    cache_matrix(app, project_id, &matrix);

    Ok(matrix)
}

#[tauri::command]
async fn platform_matrix(
    app: AppHandle,
    project_id: String,
    force: Option<bool>,
) -> Result<platforms::PlatformMatrix, String> {
    let force = force.unwrap_or(false);

    // 放到阻塞线程池：分析可能耗时数秒，绝不能占住主线程（会卡住界面）
    tauri::async_runtime::spawn_blocking(move || platform_matrix_impl(&app, &project_id, force))
        .await
        .map_err(|e| format!("分析平台信息失败: {e}"))?
}

#[tauri::command]
fn invalidate_platform_cache(app: AppHandle, project_id: Option<String>) {
    if let Ok(mut map) = app.state::<PlatformCache>().0.lock() {
        match project_id {
            Some(id) => {
                map.remove(&id);
            }
            None => map.clear(),
        }
    }
}

/// 派生动作：平台 + 动作（+ 构建目标）→ 起一个会话，**不写入项目命令**
#[tauri::command]
fn start_platform_action(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    dreg: tauri::State<'_, daemon::Daemons>,
    project_id: String,
    platform: String,
    action: String,
    target: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<StartResponse, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    // 运行类要具体设备；构建类不需要
    let device_id = if action == "build" {
        None
    } else {
        let devices = devices_snapshot(&app, &dreg, &project_id)?;
        platforms::device_for(&devices, &platform).map(|d| d.id.clone())
    };

    let (args, label, _kind) =
        platforms::args_for(&platform, &action, target.as_deref(), device_id.as_deref())?;

    let title = format!(
        "{}:{} {}",
        project.name,
        platforms::label_of(&platform),
        label
    );
    let plan = ops::flutter_adhoc_plan(&state, project, args, title)?;

    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    // 带时间戳：恢复自磁盘的旧会话可能已占用 sess-N，纯序号会撞号
    let id = format!("sess-{}-{seq}", logs::now_ms());

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
        device: device_id.unwrap_or_else(|| "—".to_string()),
        cwd: plan.cwd.display().to_string(),
        program: plan.program,
        args: plan.args,
        prefill: None,
        reused: None,
    })
}

/// 把一个**恢复的**终端标签重新拉起来：用原来的会话 id 起一个 shell，
/// 这样历史输出还在，下面接一个可以继续输入的提示符。
#[tauri::command]
fn resume_terminal(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    project_id: String,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<bool, String> {
    // 已经在跑就别重复起
    if session_of(&reg, &session_id).is_ok() {
        return Ok(false);
    }

    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let plan = ops::terminal_plan(&state, project, rows, cols)?;
    let session = pty::spawn(
        app.clone(),
        session_id.clone(),
        &plan.program,
        &plan.args,
        plan.cwd.clone(),
        &plan.env,
        rows,
        cols,
    )?;

    reg.0
        .lock()
        .map_err(|_| "会话注册表锁定失败".to_string())?
        .insert(session_id, session);

    Ok(true)
}

/// 在项目的常驻终端里执行一条普通命令（custom）。
///
/// 有活着的终端就**直接敲进去**，没有就新开一个 shell 再把命令打进去。
/// 这样 `docker compose up -d` 跑完 shell 还在，可以接着 `docker ps`。
#[tauri::command]
fn run_in_terminal(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    project_id: String,
    command_id: String,
    reuse_session_id: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<StartResponse, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let command = project
        .commands
        .iter()
        .find(|c| c.id == command_id)
        .ok_or_else(|| "命令不存在".to_string())?;

    let line = ops::shell_line_for(&state, project, command)?;
    let title = format!("{} · 终端", project.name);

    // 1) 复用已有终端
    if let Some(id) = reuse_session_id.filter(|s| !s.trim().is_empty()) {
        if let Ok(session) = session_of(&reg, &id) {
            session.write(&format!("{line}\r"))?;
            return Ok(StartResponse {
                id,
                pid: session.pid,
                title,
                device: "—".to_string(),
                cwd: project.path.clone(),
                program: String::new(),
                args: Vec::new(),
                prefill: None,
                reused: Some(true),
            });
        }
    }

    // 2) 新开一个 shell，稍后把命令敲进去
    //    延迟是为了让 shell 先把提示符准备好，避免输入被初始化过程吃掉
    let plan = ops::terminal_plan(&state, project, rows, cols)?;
    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let id = format!("sess-{}-{seq}", logs::now_ms());

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
        .insert(id.clone(), session.clone());

    let writer = session.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(220));
        let _ = writer.write(&format!("{line}\r"));
    });

    Ok(StartResponse {
        id,
        pid,
        title,
        device: "—".to_string(),
        cwd: plan.cwd.display().to_string(),
        program: plan.program,
        args: plan.args,
        prefill: None,
        reused: Some(false),
    })
}

/// 恢复的 run 会话「重跑」：开终端并把命令预填到提示符，不自动执行
#[tauri::command]
fn prefill_run(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    project_id: String,
    command_id: String,
    rows: u16,
    cols: u16,
) -> Result<StartResponse, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let command = project
        .commands
        .iter()
        .find(|c| c.id == command_id)
        .ok_or_else(|| "命令不存在".to_string())?;

    let (plan, line) = ops::prefill_plan(&state, project, command)?;

    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let id = format!("sess-{}-{seq}", logs::now_ms());

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
        device: "—".to_string(),
        cwd: plan.cwd.display().to_string(),
        program: plan.program,
        args: plan.args,
        prefill: Some(line),
        reused: None,
    })
}

/* ---------------- 终端 ---------------- */

#[tauri::command]
fn detect_terminals() -> Vec<terminal::TerminalCandidate> {
    terminal::detect()
}

/// 在终端中打开项目目录，注入项目环境（鸿蒙工程会带上变量与 PATH shim）
#[tauri::command]
fn open_terminal(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    project_id: String,
    rows: u16,
    cols: u16,
) -> Result<StartResponse, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let plan = ops::terminal_plan(&state, project, rows, cols)?;

    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let id = format!("sess-{}-{seq}", logs::now_ms());

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
        device: "—".to_string(),
        cwd: plan.cwd.display().to_string(),
        program: plan.program,
        args: plan.args,
        prefill: None,
        reused: None,
    })
}

/* ---------------- 备案信息 ---------------- */

#[tauri::command(async)]
fn filing_info(app: AppHandle, apk: String) -> Result<filing::FilingInfo, String> {
    let state = store::load(&app)?;
    Ok(filing::inspect(&apk, &state.settings.android))
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

    // 没有显式分类就按 program/args 推断并固化，
    // 模板库分组与导入过滤都读这个字段，不必每次重算
    if tpl.category.is_none() {
        tpl.category = Some(ops::template_category(&tpl).to_string());
    }

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

/* ---------------- 体检（§14 / §6.6） ---------------- */

// `(async)` 让 Tauri 把这条命令放到线程池执行。
// 不用它会跑在主线程上：`flutter doctor` 实测要 23 秒，界面会整段"无响应"。
#[tauri::command(async)]
fn flutter_doctor(
    app: AppHandle,
    cache: tauri::State<'_, doctor::Cache>,
    project_id: Option<String>,
    force: Option<bool>,
    cached_only: Option<bool>,
) -> Result<doctor::DoctorReport, String> {
    let state = store::load(&app)?;

    let ctx = ctx_or_default(&state, project_id.as_deref())?;
    let env = ctx.env_with_path();
    let exe = ctx.exe;

    let key = exe.display().to_string();
    if let Some(hit) = doctor::cached(&cache, &key, force.unwrap_or(false)) {
        return Ok(hit);
    }

    // 磁盘缓存：跨重启直接用上次结果（`flutter doctor` 实测 23 秒）。
    // 不设过期：体检只在用户点「重新检查」时才重跑。
    if !force.unwrap_or(false) {
        if let Some(rep) = read_cached_doctor(&app, &key) {
            doctor::store(&cache, &key, &rep);
            return Ok(rep);
        }
    }

    // 启动时只想拿缓存、不想触发探测：没有缓存就返回"未体检"占位（ranAt = 0）
    if cached_only.unwrap_or(false) {
        return Ok(doctor::DoctorReport::default());
    }

    let rep = doctor::report(&exe, &env);
    doctor::store(&cache, &key, &rep);
    write_cached_doctor(&app, &key, &rep);
    Ok(rep)
}

/// 读出上次的体检结果（同一个 flutter 可执行文件）。
/// 不看过期时间：什么时候重跑由用户决定。
fn read_cached_doctor(app: &AppHandle, key: &str) -> Option<doctor::DoctorReport> {
    let c = read_disk_cache(app);
    let hit = c.doctor?;
    if hit.key != key {
        return None;
    }
    Some(hit.report)
}

fn write_cached_doctor(app: &AppHandle, key: &str, rep: &doctor::DoctorReport) {
    let mut c = read_disk_cache(app);
    c.doctor = Some(CachedDoctor {
        saved_at: logs::now_ms(),
        key: key.to_string(),
        report: rep.clone(),
    });
    write_disk_cache(app, &c);
}

/// 在终端里执行体检给出的修复动作。
/// **白名单**：只认预定义字符串，绝不执行 doctor 输出里的任意命令。
#[tauri::command(async)]
fn start_doctor_fix(
    app: AppHandle,
    reg: tauri::State<'_, pty::Registry>,
    project_id: String,
    fix: String,
    rows: u16,
    cols: u16,
) -> Result<StartResponse, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let args: Vec<String> = match fix.as_str() {
        "flutter doctor --android-licenses" => {
            vec!["doctor".to_string(), "--android-licenses".to_string()]
        }
        other => {
            return Err(format!("「{other}」需要手动处理，启动器不代为执行"));
        }
    };

    let plan = ops::flutter_adhoc_plan(
        &state,
        project,
        args,
        format!("{}:Android 许可证", project.name),
    )?;

    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    // 带时间戳：恢复自磁盘的旧会话可能已占用 sess-N，纯序号会撞号
    let id = format!("sess-{}-{seq}", logs::now_ms());

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
        prefill: None,
        reused: None,
    })
}

/* ---------------- 设置与工具链 ---------------- */

#[tauri::command]
fn save_settings(
    app: AppHandle,
    reg: tauri::State<'_, daemon::Daemons>,
    settings: model::Settings,
) -> Result<State, String> {
    let mut state = store::load(&app)?;
    state.settings = settings;
    store::save(&app, &state)?;

    // 设置可能改变鸿蒙 flutter 路径与环境变量。daemon 的环境在 spawn 时已固定，
    // 必须丢弃让下次重新拉起；代价是下一次列设备要等几秒。
    reg.invalidate_all();

    Ok(state)
}

#[tauri::command(async)]
fn detect_toolchains() -> detect::Detected {
    detect::detect()
}

/* ---------------- 环境变量 ---------------- */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvEntry {
    key: String,
    value: String,
    /// 全局 / .fvmrc / 项目
    source: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectEnvInfo {
    /// 是否鸿蒙工程（有 ohos/）——不是的话这些变量根本不注入
    harmony: bool,
    /// 该项目实际使用的 flutter
    exe: String,
    /// harmony | fvm | custom | path
    flutter_source: String,
    /// 生成的 PATH shim 目录（没有则为 null）
    shim: Option<String>,
    entries: Vec<EnvEntry>,
}

#[tauri::command]
fn project_env(app: AppHandle, project_id: String) -> Result<ProjectEnvInfo, String> {
    let state = store::load(&app)?;
    let project = state
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let root = PathBuf::from(&project.path);
    let harmony = flutter::is_harmony(&root);

    // 优先级：全局 < .fvmrc < 项目
    let mut map: std::collections::BTreeMap<String, (String, String)> =
        std::collections::BTreeMap::new();

    if harmony {
        for (k, v) in &state.settings.harmony.env {
            map.insert(k.clone(), (v.clone(), "全局".to_string()));
        }
    }
    for (k, v) in flutter::fvm_env(&root) {
        map.insert(k, (v, ".fvmrc".to_string()));
    }
    if harmony {
        for (k, v) in &project.env {
            map.insert(k.clone(), (v.clone(), "项目".to_string()));
        }
    }

    let ctx = flutter::ctx_for(&state, project, &root).ok();

    Ok(ProjectEnvInfo {
        harmony,
        exe: ctx
            .as_ref()
            .map(|c| c.exe.display().to_string())
            .unwrap_or_default(),
        flutter_source: ctx.as_ref().map(|c| c.source.clone()).unwrap_or_default(),
        shim: ctx
            .as_ref()
            .and_then(|c| c.path_prepend.as_ref())
            .map(|p| p.display().to_string()),
        entries: map
            .into_iter()
            .map(|(key, (value, source))| EnvEntry { key, value, source })
            .collect(),
    })
}

#[tauri::command]
fn save_project_env(
    app: AppHandle,
    project_id: String,
    env: std::collections::BTreeMap<String, String>,
) -> Result<State, String> {
    let mut state = store::load(&app)?;
    let project = state
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    project.env = env;
    store::save(&app, &state)?;
    Ok(state)
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct EmulatorEntry {
    id: String,
    name: String,
    detail: String,
    kind: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct AllEmulators {
    android: Vec<EmulatorEntry>,
    harmony: Vec<EmulatorEntry>,
    notes: Vec<String>,
}

/* ---------------- 磁盘缓存（跨重启有效） ---------------- */

/// 缓存结构版本。**改平台定义或缓存语义时必须 +1**，否则旧缓存会挡住新逻辑。
/// （踩过：新增 HarmonyOS 平台，但该项目的平台矩阵是旧版本缓存的，新平台不出现。）
const DISK_CACHE_VERSION: u32 = 3;

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct DiskCache {
    v: u32,
    platforms: std::collections::HashMap<String, CachedMatrix>,
    emulators: Option<CachedEmulators>,
    /// 体检结果落盘：`flutter doctor` 实测要 20+ 秒，
    /// 只放内存的话每次启动都要重跑一遍
    doctor: Option<CachedDoctor>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedDoctor {
    saved_at: u64,
    /// 按 flutter 可执行文件区分（不同项目可能用不同分支）
    key: String,
    report: doctor::DoctorReport,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedMatrix {
    saved_at: u64,
    matrix: platforms::PlatformMatrix,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedEmulators {
    saved_at: u64,
    payload: AllEmulators,
}

fn read_disk_cache(app: &AppHandle) -> DiskCache {
    let c = cache::path_of(app)
        .map(|p| cache::load::<DiskCache>(&p))
        .unwrap_or_default();

    // 版本不符：全部丢弃，按新逻辑重算
    if c.v != DISK_CACHE_VERSION {
        return DiskCache {
            v: DISK_CACHE_VERSION,
            ..Default::default()
        };
    }

    c
}

fn write_disk_cache(app: &AppHandle, c: &DiskCache) {
    if let Ok(p) = cache::path_of(app) {
        let tagged = DiskCache {
            v: DISK_CACHE_VERSION,
            ..c.clone()
        };
        let _ = cache::save(&p, &tagged);
    }
}

fn cache_matrix(app: &AppHandle, project_id: &str, matrix: &platforms::PlatformMatrix) {
    let mut disk = read_disk_cache(app);
    disk.platforms.insert(
        project_id.to_string(),
        CachedMatrix {
            saved_at: logs::now_ms(),
            matrix: matrix.clone(),
        },
    );
    write_disk_cache(app, &disk);
}

fn cache_emulators(app: &AppHandle, payload: &AllEmulators) {
    let mut disk = read_disk_cache(app);
    disk.emulators = Some(CachedEmulators {
        saved_at: logs::now_ms(),
        payload: payload.clone(),
    });
    write_disk_cache(app, &disk);
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

/// 未显式配置时回退到自动探测结果，保证开箱即用
fn effective_android(state: &State) -> model::AndroidSettings {
    let s = &state.settings.android;
    let has = |v: &Option<String>| v.as_ref().is_some_and(|p| !p.trim().is_empty());

    if has(&s.emulator_path) || has(&s.sdk_path) {
        s.clone()
    } else {
        detect::detect().android
    }
}

/// 聚合两个来源：Android（emulator.exe，退化时用 flutter daemon）+ HarmonyOS（Emulator.exe -list）。
/// 结果落磁盘缓存，只有 `force`（菜单里的 ⟳）才重新检查。
#[tauri::command(async)]
fn list_all_emulators(
    app: AppHandle,
    reg: tauri::State<'_, daemon::Daemons>,
    project_id: Option<String>,
    force: Option<bool>,
) -> AllEmulators {
    // 1) 命中磁盘缓存直接返回
    if !force.unwrap_or(false) {
        let disk = read_disk_cache(&app);
        if let Some(hit) = disk.emulators {
            return hit.payload;
        }
    }

    let mut out = AllEmulators::default();

    let state = match store::load(&app) {
        Ok(s) => s,
        Err(e) => {
            out.notes.push(e);
            return out;
        }
    };

    /* ---- Android：优先直接驱动 emulator.exe ---- */
    let android_settings = effective_android(&state);
    let mut android_resolved = false;

    if let Some(r) = android::resolve(&android_settings) {
        match android::list_avds(&r) {
            Ok(list) => {
                android_resolved = true; // 查到了就不再退回 daemon，避免两套结果互相矛盾
                out.android = list
                    .into_iter()
                    .map(|a| EmulatorEntry {
                        id: a.name.clone(),
                        name: a.name,
                        detail: a.detail,
                        kind: "android".into(),
                    })
                    .collect();
            }
            Err(e) => out.notes.push(format!("Android: {e}")),
        }
    }

    if android_resolved && out.android.is_empty() {
        // 明确指出用的是哪个目录——"改了设置还是没 AVD"多半是目录填错
        out.notes.push(format!(
            "未发现 Android AVD；当前 AVD 目录：{}",
            android_settings
                .avd_path
                .clone()
                .unwrap_or_else(|| "默认（%USERPROFILE%\\.android\\avd）".to_string())
        ));
    }

    if !android_resolved {
        let target = project_id.or_else(|| state.projects.first().map(|p| p.id.clone()));
        match target {
            Some(pid) => match project_ctx(&state, &pid) {
                Ok(ctx) => match daemon::get_or_start(
                    &reg,
                    &ctx.exe,
                    &ctx.env_with_path(),
                    device_sink(&app),
                ) {
                    Ok(d) => match d.request("emulator.getEmulators", None) {
                        Ok(v) => {
                            if let Ok(list) =
                                serde_json::from_value::<Vec<daemon::EmulatorInfo>>(v)
                            {
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
    }

    /* ---- HarmonyOS ---- */
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

    cache_emulators(&app, &out);
    out
}

#[tauri::command(async)]
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

/* ---------------- 终端里的可点击位置 ---------------- */

/// 解析终端里的一段位置文本（路径 / package: URI），返回磁盘位置与是否存在。
#[tauri::command(async)]
fn resolve_location(cwd: Option<String>, text: String) -> Option<locate::Location> {
    let base = cwd
        .as_deref()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| std::env::current_dir().ok())?;
    locate::resolve(&base, &text)
}

/// 用 VS Code 打开文件并跳到行列。
#[tauri::command(async)]
fn open_in_editor(
    app: AppHandle,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
) -> Result<(), String> {
    let state = store::load(&app)?;
    let code = editor::detect(state.settings.editor.vscode_path.as_deref())
        .ok_or_else(|| "没找到 VS Code，请到「设置 → 通用 → 编辑器」里指定 Code.exe".to_string())?;
    editor::open(&code, std::path::Path::new(&path), line, col)
}

/// 用系统默认程序打开文件（图片 / 日志 / 其他非源码）。
/// 不走 opener 插件的 open_path：那个要 scope 授权，运行时会被拒。
#[tauri::command(async)]
fn open_path_default(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    editor::open_with_default_app(p)
}

/// 项目目录里可编辑的配置文件（右键菜单据此显示「编辑 …」）
#[tauri::command(async)]
fn project_files(path: String) -> project_files::ProjectFiles {
    project_files::detect(std::path::Path::new(&path))
}

/// 自动探测到的 VS Code 路径（设置里留空时实际会用它）
#[tauri::command(async)]
fn detect_editor_path() -> Option<String> {
    editor::detect(None).map(|p| p.display().to_string())
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
        // 单实例必须**第一个**注册：第二个实例启动时直接退出，
        // 并把已有窗口拉到前面——否则两个进程会同时写 state.json，互相覆盖。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 改过 identifier：把老目录的配置搬过来（只在新目录还没有数据时执行）
            if let Some(msg) = crate::store::migrate_legacy_dir(app.handle()) {
                println!("[store] {msg}");
            }
            Ok(())
        })
        .manage(pty::Registry::default())
        .manage(daemon::Daemons::default())
        .manage(TargetCache::default())
        .manage(PlatformCache::default())
        .manage(doctor::Cache::default())
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
            platform_matrix,
            invalidate_platform_cache,
            import_launch_path,
            import_package_path,
            import_compose_path,
            start_platform_action,
            filing_info,
            upsert_command,
            remove_command,
            upsert_template,
            remove_template,
            reset_templates,
            import_templates,
            save_settings,
            project_env,
            save_project_env,
            detect_terminals,
            open_terminal,
            prefill_run,
            run_in_terminal,
            resume_terminal,
            detect_toolchains,
            flutter_doctor,
            start_doctor_fix,
            save_session_logs,
            load_session_logs,
            clear_session_logs,
            list_all_emulators,
            launch_harmony_emulator,
            dev_autostart,
            dev_env,
            resolve_location,
            detect_editor_path,
            open_path_default,
            project_files,
            open_in_editor
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}










































