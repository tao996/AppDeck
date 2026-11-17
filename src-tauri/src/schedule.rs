//! 循环任务（模拟 Linux crontab）：配置、调度线程、后台执行、日志与运行历史。
//!
//! 设计要点：
//! - **配置进 `state.json`，运行态进 `task-runtime.json`**：调度线程绝不写 state.json，
//!   避免和前端「读—改—写」互相覆盖。
//! - 只有应用运行期间才触发；退出时正在跑的进程由 Job Object 一起回收。
//! - 后台执行不经过 PTY：`stdin` 置空、stdout/stderr 落日志，程序跑完即结束。
//! - 命令一律以 argv 数组传递；`.bat/.cmd` 交给 `cmd /d /c`，`.ps1` 交给 PowerShell。

use crate::atomic;
use crate::cron_spec::CronSpec;
use crate::logs::now_ms;
use crate::model::{self, ScheduledTask};
use crate::pty::JobGuard;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as PCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

/// 单个任务的日志文件上限；到顶后轮转成 `task.log.1`，新运行重新写 `task.log`。
const MAX_TASK_LOG_BYTES: u64 = 10 * 1024 * 1024;
/// 所有任务日志的总预算：超出时只删旧的 `task.log.1`，不动正在用的 `task.log`。
const MAX_ALL_LOG_BYTES: u64 = 200 * 1024 * 1024;
const MAX_RUNS: usize = 500;
const MAX_RUNS_PER_TASK: usize = 50;

static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

/// 调度器。可以克隆：内部共享同一个 `Arc<Mutex<Inner>>`。
#[derive(Clone)]
pub struct Scheduler {
    app: AppHandle,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    tasks: Vec<ScheduledTask>,
    runtime: RuntimeStore,
    /// taskId → 正在跑的运行
    running: HashMap<String, Arc<RunControl>>,
    /// taskId → 因 overlap=queue 而等待的槽位
    pending: HashMap<String, u64>,
    /// 已经打印过「任务信息」头的任务；停用 / 清空日志 / 轮转后移除，
    /// 下次运行或重新启动时重新打印。
    session_info: HashSet<String>,
    /// 上次 tick 的毫秒时间戳；0 表示刚启动（用于判断「应用关闭期间错过」）
    last_tick: u64,
}

/* ---------------- 运行态 ---------------- */

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskRuntime {
    pub next_at: u64,
    pub last_slot: u64,
    pub last_run_id: Option<String>,
    pub last_status: Option<String>,
    pub last_exit_code: Option<i32>,
    pub last_ms: u64,
    /// 最后一次「已收尾」运行的开始时间。用于避免 overlap=kill 时
    /// 旧运行的收尾消息覆盖新运行的结果。
    pub last_started_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunRecord {
    pub id: String,
    pub task_id: String,
    pub slot: u64,
    pub started_at: u64,
    pub ended_at: u64,
    /// running | success | failed | timeout | interrupted | skipped
    pub status: String,
    pub exit_code: Option<i32>,
    /// 相对配置目录的路径；skipped 为空
    pub log: String,
    pub reason: Option<String>,
}

impl RunRecord {
    fn skipped(task_id: &str, slot: u64, reason: &str) -> Self {
        let now = now_ms();
        Self {
            id: format!("skip-{}-{}", now, RUN_SEQ.fetch_add(1, Ordering::SeqCst)),
            task_id: task_id.to_string(),
            slot,
            started_at: now,
            ended_at: now,
            status: "skipped".to_string(),
            exit_code: None,
            log: String::new(),
            reason: Some(reason.to_string()),
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RuntimeStore {
    tasks: HashMap<String, TaskRuntime>,
    runs: Vec<RunRecord>,
}

impl RuntimeStore {
    /// 上次进程退出时没来得及收尾的运行，标记为 interrupted。
    fn reconcile_interrupted(&mut self) {
        for run in self.runs.iter_mut() {
            if run.ended_at == 0 {
                run.ended_at = run.started_at;
                run.status = "interrupted".to_string();
                run.reason = Some("应用退出时运行未正常结束".to_string());
                if let Some(rt) = self.tasks.get_mut(&run.task_id) {
                    if rt.last_run_id.as_deref() == Some(run.id.as_str()) {
                        rt.last_status = Some("interrupted".to_string());
                        rt.last_exit_code = run.exit_code;
                        rt.last_ms = 0;
                    }
                }
            }
        }
    }
}

/* ---------------- 运行中的进程 ---------------- */

struct RunControl {
    run_id: String,
    job: Mutex<Option<JobGuard>>,
    done: AtomicBool,
    timed_out: AtomicBool,
    cancelled: AtomicBool,
}

impl RunControl {
    fn new(run_id: String, job: Option<JobGuard>) -> Self {
        Self {
            run_id,
            job: Mutex::new(job),
            done: AtomicBool::new(false),
            timed_out: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
        }
    }

    /// 结束整棵进程树。`cancelled` 用于区分「手动停止」和「超时」。
    fn terminate(&self, cancelled: bool) {
        if cancelled {
            self.cancelled.store(true, Ordering::SeqCst);
        }
        let job = self.job.lock().map(|mut g| g.take()).unwrap_or(None);
        if let Some(job) = job {
            job.terminate();
        }
    }

    /// 正常退出后调用： Drop JobGuard 会终止残留的子孙进程。
    fn finish_job(&self) {
        let job = self.job.lock().map(|mut g| g.take()).unwrap_or(None);
        drop(job);
    }
}

#[derive(Debug)]
struct Launch {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
}

/* ---------------- 对外视图 ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    #[serde(flatten)]
    pub task: ScheduledTask,
    pub next_at: u64,
    /// 未来 3 次；cron 非法时为空
    pub next_runs: Vec<u64>,
    pub next_error: Option<String>,
    pub running: bool,
    pub last_status: Option<String>,
    pub last_exit_code: Option<i32>,
    pub last_ms: u64,
    pub last_run_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunEvent {
    task_id: String,
    task_name: String,
    run_id: String,
    /// running | success | failed | timeout | interrupted | skipped
    status: String,
    exit_code: Option<i32>,
    started_at: u64,
    ended_at: u64,
    /// always | onFailure | never（前端据此决定是否弹系统通知）
    notify: String,
    manual: bool,
    reason: Option<String>,
}

/* ---------------- 文件路径 ---------------- */

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))
}

fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("task-runtime.json"))
}

fn logs_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("task-logs"))
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 每个任务一个固定日志文件：所有运行都追加到这里，方便在一个面板里持续查看。
fn task_log_rel(task_id: &str) -> String {
    format!("task-logs/{}/task.log", safe_id(task_id))
}

fn task_log_path(app: &AppHandle, task_id: &str) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(task_log_rel(task_id)))
}

fn load_runtime(app: &AppHandle) -> RuntimeStore {
    let Ok(path) = runtime_path(app) else {
        return RuntimeStore::default();
    };
    if !path.exists() {
        return RuntimeStore::default();
    }
    match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<RuntimeStore>(&raw) {
            Ok(mut store) => {
                store.reconcile_interrupted();
                store
            }
            Err(_) => {
                let _ = fs::copy(&path, path.with_file_name("task-runtime.corrupt.json"));
                RuntimeStore::default()
            }
        },
        Err(_) => RuntimeStore::default(),
    }
}

fn save_runtime(app: &AppHandle, store: &RuntimeStore) -> Result<(), String> {
    let path = runtime_path(app)?;
    let data = serde_json::to_string_pretty(store)
        .map_err(|e| format!("序列化循环任务运行态失败: {e}"))?;
    atomic::write_atomic(&path, &data)
}

fn ms(dt: DateTime<Local>) -> u64 {
    dt.timestamp_millis().max(0) as u64
}

/* ---------------- 调度器 ---------------- */

impl Scheduler {
    pub fn start(app: &AppHandle) -> Self {
        let sc = Self::new(app.clone());
        // 应用启动 = 每个启用任务的一次「启动」：先打任务信息头
        sc.startup_info();
        let bg = sc.clone();
        thread::spawn(move || bg.run_loop());
        sc
    }

    fn new(app: AppHandle) -> Self {
        let state = crate::store::load(&app).unwrap_or_default();
        let mut runtime = load_runtime(&app);
        let now = Local::now();

        for task in &state.scheduled_tasks {
            let rt = runtime.tasks.entry(task.id.clone()).or_default();
            // 首次见到这个任务（或旧版运行态里没有）：从未来算起，不补历史。
            // 已经存过 next_at 的保持原样，让第一次 tick 能识别「关闭期间错过」。
            if task.enabled && rt.next_at == 0 {
                rt.next_at = CronSpec::parse(&task.cron)
                    .ok()
                    .and_then(|s| s.next_after(now))
                    .map(ms)
                    .unwrap_or(0);
            }
        }

        Self {
            app,
            inner: Arc::new(Mutex::new(Inner {
                tasks: state.scheduled_tasks,
                runtime,
                running: HashMap::new(),
                pending: HashMap::new(),
                session_info: HashSet::new(),
                // 0：第一次 tick 按「应用刚启动」处理错过的槽位
                last_tick: 0,
            })),
        }
    }

    fn run_loop(self) {
        loop {
            // 250ms 一轮：秒级任务（6 段 cron）也能在 1 秒内可靠触发
            thread::sleep(Duration::from_millis(250));
            self.tick();
        }
    }

    fn tick(&self) {
        let now = Local::now();
        let now_ms = now.timestamp_millis().max(0) as u64;
        let mut due: Vec<(ScheduledTask, u64)> = Vec::new();
        let mut skipped: Vec<(ScheduledTask, u64, String)> = Vec::new();
        let mut persist = false;

        {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let inner = &mut *guard;
            let first_tick = inner.last_tick == 0;
            let gap = first_tick || now_ms.saturating_sub(inner.last_tick) > 120_000;
            inner.last_tick = now_ms;

            let Inner {
                tasks,
                runtime,
                last_tick: _,
                ..
            } = inner;

            for task in tasks.iter().filter(|t| t.enabled) {
                let rt = runtime.tasks.entry(task.id.clone()).or_default();

                // next_at = 0 有两种含义：cron 永不触发，或还没算过。
                // 初始化在 `new` / `upsert` / `set_enabled` 里做，这里不再重算，
                // 否则「永不触发」的任务每秒都会写一次运行态文件。
                if rt.next_at == 0 || now_ms < rt.next_at {
                    continue;
                }

                let slot = rt.next_at;
                // 先把 next 推到未来：同一槽位只处理一次，即使这次因并发策略被跳过
                rt.next_at = CronSpec::parse(&task.cron)
                    .ok()
                    .and_then(|s| s.next_after(now))
                    .map(ms)
                    .unwrap_or(0);
                persist = true;

                // 应用关闭 / 休眠期间错过：默认跳过，catchUp=once 才补一次
                if gap && task.catch_up != "once" {
                    skipped.push((task.clone(), slot, "应用未运行期间错过的任务".to_string()));
                    continue;
                }

                due.push((task.clone(), slot));
            }

            if !skipped.is_empty() {
                for (task, slot, reason) in &skipped {
                    runtime
                        .runs
                        .push(RunRecord::skipped(&task.id, *slot, reason));
                }
                cap_runs(runtime);
                persist = true;
            }
        }

        if persist {
            self.persist();
        }
        for (task, _slot, reason) in skipped {
            self.emit_run(
                &task,
                "",
                "skipped",
                None,
                now_ms,
                now_ms,
                false,
                Some(reason),
            );
        }
        for (task, slot) in due {
            let _ = self.fire(task, slot, false);
        }
    }

    /// 应用启动 = 每个启用任务的一次「启动」：先打任务信息头。
    fn startup_info(&self) {
        let tasks: Vec<ScheduledTask> = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.tasks.iter().filter(|t| t.enabled).cloned().collect()
        };
        for task in tasks {
            self.ensure_task_info(&task);
        }
    }

    /// 打印一次任务信息（每个「启动会话」只打印一次）。
    fn ensure_task_info(&self, task: &ScheduledTask) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            // 先占位，避免启动线程与 tick 同时写两遍；写失败再撤销
            if !inner.session_info.insert(task.id.clone()) {
                return;
            }
        }

        let text = task_info_text(task);
        if !append_task_log(&self.app, task, &text) {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.session_info.remove(&task.id);
        }
    }

    /// 单任务日志到 10MB 时轮转；轮转后下次运行要重新打印任务信息。
    fn rotate_task_log_if_needed(&self, task: &ScheduledTask) {
        let Ok(path) = task_log_path(&self.app, &task.id) else {
            return;
        };
        let Ok(meta) = fs::metadata(&path) else {
            return;
        };
        if meta.len() < MAX_TASK_LOG_BYTES {
            return;
        }

        let rotated = path.with_file_name("task.log.1");
        let _ = fs::remove_file(&rotated);
        if fs::rename(&path, &rotated).is_ok() {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.session_info.remove(&task.id);
            drop(inner);
            prune_all_logs(&self.app);
        }
    }

    /// 清空任务日志（当前 task.log + 旧的 task.log.1）。
    pub fn clear_task_log(&self, task_id: &str) -> Result<(), String> {
        let path = task_log_path(&self.app, task_id)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败: {e}"))?;
        }
        if path.exists() {
            OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .map_err(|e| format!("清空日志失败: {e}"))?;
        }
        let _ = fs::remove_file(path.with_file_name("task.log.1"));

        // 清空后视为新会话：下次运行重新打印任务信息
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.session_info.remove(task_id);
        Ok(())
    }

    /// 触发一次运行。`slot = 0` 表示手动运行。
    fn fire(&self, task: ScheduledTask, slot: u64, manual: bool) -> Result<String, String> {
        let mut skip_reason: Option<String> = None;
        let mut kill_previous: Option<Arc<RunControl>> = None;

        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());

            // 任务可能在 tick 收集之后被删/停用
            let Some(current) = inner.tasks.iter().find(|t| t.id == task.id) else {
                return Ok(String::new());
            };
            if !current.enabled && !manual {
                return Ok(String::new());
            }

            if let Some(running) = inner.running.get(&task.id).cloned() {
                match task.overlap.as_str() {
                    "kill" => kill_previous = Some(running),
                    "queue" => {
                        if manual {
                            return Err("上一次运行还没结束".to_string());
                        }
                        inner.pending.insert(task.id.clone(), slot);
                        return Ok(String::new());
                    }
                    _ => {
                        skip_reason = Some("上一次运行还没结束".to_string());
                    }
                }
            }
        }

        if let Some(reason) = skip_reason {
            if manual {
                return Err(reason);
            }
            self.record_skipped(&task, slot, &reason);
            return Ok(String::new());
        }

        if let Some(previous) = kill_previous {
            previous.terminate(true);
        }

        // 每次运行前：日志过大先轮转；本会话第一次运行时打印任务信息
        self.rotate_task_log_if_needed(&task);
        self.ensure_task_info(&task);

        let launch = match build_launch(&task.command) {
            Ok(l) => l,
            Err(e) => {
                let run_id = self.record_failed_start(&task, slot, manual, &e);
                let _ = run_id;
                return Err(format!("{e}（已记录到运行日志）"));
            }
        };

        let started_at = now_ms();
        let run_id = format!(
            "run-{}-{}",
            started_at,
            RUN_SEQ.fetch_add(1, Ordering::SeqCst)
        );
        let (file, written, truncated, log_rel) = match open_task_log(&self.app, &task) {
            Ok(v) => v,
            Err(e) => {
                self.record_failed_start(&task, slot, manual, &e);
                return Err(format!("{e}（无法写运行日志）"));
            }
        };

        let mut cmd = PCommand::new(&launch.program);
        cmd.args(&launch.args)
            .current_dir(&launch.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::flutter::hide_console(&mut cmd);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                write_log(
                    &file,
                    &written,
                    &truncated,
                    format!("启动失败：{e}\n").as_bytes(),
                );
                self.finish_run(
                    task,
                    run_id,
                    slot,
                    started_at,
                    "failed",
                    None,
                    Some(log_rel),
                    Some(format!("启动失败：{e}")),
                    manual,
                );
                return Err(format!("启动失败：{e}"));
            }
        };

        let job = JobGuard::assign(child.id());
        let control = Arc::new(RunControl::new(run_id.clone(), job));

        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.running.insert(task.id.clone(), control.clone());
        }

        self.emit_run(&task, &run_id, "running", None, started_at, 0, manual, None);

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let out_file = file.clone();
        let out_written = written.clone();
        let out_truncated = truncated.clone();
        let out_handle = stdout.map(|mut s| {
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match s.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => write_log(&out_file, &out_written, &out_truncated, &buf[..n]),
                        Err(_) => break,
                    }
                }
            })
        });
        let err_file = file.clone();
        let err_written = written.clone();
        let err_truncated = truncated.clone();
        let err_handle = stderr.map(|mut s| {
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match s.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => write_log(&err_file, &err_written, &err_truncated, &buf[..n]),
                        Err(_) => break,
                    }
                }
            })
        });

        // 超时看门狗
        if task.timeout_secs > 0 {
            let timed = control.clone();
            let secs = task.timeout_secs;
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(secs);
                while Instant::now() < deadline {
                    if timed.done.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(500));
                }
                if !timed.done.load(Ordering::SeqCst) {
                    timed.timed_out.store(true, Ordering::SeqCst);
                    timed.terminate(false);
                }
            });
        }

        let me = self.clone();
        let wait_control = control.clone();
        let wait_task = task.clone();
        let wait_log = log_rel.clone();
        let wait_run_id = run_id.clone();
        thread::spawn(move || {
            let status = child.wait();
            let code = status.ok().and_then(|s| s.code());
            wait_control.done.store(true, Ordering::SeqCst);
            // 父进程退出后，Job 里可能还有子孙进程；先终止再收读线程
            wait_control.finish_job();
            if let Some(h) = out_handle {
                let _ = h.join();
            }
            if let Some(h) = err_handle {
                let _ = h.join();
            }

            let (final_status, reason) = if wait_control.timed_out.load(Ordering::SeqCst) {
                ("timeout", Some("超过设定时限，已终止".to_string()))
            } else if wait_control.cancelled.load(Ordering::SeqCst) {
                ("interrupted", Some("手动停止".to_string()))
            } else if code == Some(0) {
                ("success", None)
            } else {
                ("failed", code.map(|c| format!("退出码 {c}")))
            };

            me.finish_run(
                wait_task,
                wait_run_id,
                slot,
                started_at,
                final_status,
                code,
                Some(wait_log),
                reason,
                manual,
            );
        });

        Ok(run_id)
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_run(
        &self,
        task: ScheduledTask,
        run_id: String,
        slot: u64,
        started_at: u64,
        status: &str,
        exit_code: Option<i32>,
        log: Option<String>,
        reason: Option<String>,
        manual: bool,
    ) {
        let ended_at = now_ms();
        let elapsed = ended_at.saturating_sub(started_at);
        let mut pending: Option<(u64, ScheduledTask)> = None;

        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());

            // 只有仍是「我自己」时才移除，避免 overlap=kill 时把新运行删掉
            if let Some(current) = inner.running.get(&task.id) {
                if current.run_id == run_id {
                    inner.running.remove(&task.id);
                }
            }

            let rt = inner.runtime.tasks.entry(task.id.clone()).or_default();
            // 只有比「已记录的最后一次运行」更新的收尾才允许写状态。
            // overlap=kill 时旧运行的退出线程可能比新运行晚回来，
            // 不加这个判断会把新运行的成功结果覆盖成「被停止」。
            if started_at >= rt.last_started_at {
                if !manual && slot > 0 {
                    rt.last_slot = slot;
                }
                rt.last_run_id = Some(run_id.clone());
                rt.last_status = Some(status.to_string());
                rt.last_exit_code = exit_code;
                rt.last_ms = elapsed;
                rt.last_started_at = started_at;
            }

            inner.runtime.runs.push(RunRecord {
                id: run_id.clone(),
                task_id: task.id.clone(),
                slot,
                started_at,
                ended_at,
                status: status.to_string(),
                exit_code,
                log: log.clone().unwrap_or_default(),
                reason: reason.clone(),
            });
            cap_runs(&mut inner.runtime);

            if let Some(slot) = inner.pending.remove(&task.id) {
                if let Some(next) = inner
                    .tasks
                    .iter()
                    .find(|t| t.id == task.id && t.enabled)
                    .cloned()
                {
                    pending = Some((slot, next));
                }
            }
        }

        self.persist();
        self.emit_run(
            &task, &run_id, status, exit_code, started_at, ended_at, manual, reason,
        );

        if log.is_some() {
            prune_all_logs(&self.app);
        }

        if let Some((slot, task)) = pending {
            let _ = self.fire(task, slot, false);
        }
    }

    fn record_skipped(&self, task: &ScheduledTask, slot: u64, reason: &str) {
        let now = now_ms();
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .runtime
                .runs
                .push(RunRecord::skipped(&task.id, slot, reason));
            cap_runs(&mut inner.runtime);
        }
        self.persist();
        self.emit_run(
            task,
            "",
            "skipped",
            None,
            now,
            now,
            false,
            Some(reason.to_string()),
        );
    }

    /// 启动前就失败（路径不存在、.lnk、日志目录不可写……）：也留一条历史与日志。
    fn record_failed_start(
        &self,
        task: &ScheduledTask,
        slot: u64,
        manual: bool,
        error: &str,
    ) -> String {
        let started_at = now_ms();
        let run_id = format!(
            "run-{}-{}",
            started_at,
            RUN_SEQ.fetch_add(1, Ordering::SeqCst)
        );
        let log_rel = task_log_rel(&task.id);
        let text = format!(
            "======== {} ========\n无法启动：{error}\n",
            Local::now().format("%Y-%m-%d %H:%M:%S")
        );
        let wrote_log = append_task_log(&self.app, task, &text);

        self.finish_run(
            task.clone(),
            run_id.clone(),
            slot,
            started_at,
            "failed",
            None,
            wrote_log.then_some(log_rel),
            Some(error.to_string()),
            manual,
        );
        run_id
    }

    fn persist(&self) {
        let store = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.runtime.clone()
        };
        if let Err(e) = save_runtime(&self.app, &store) {
            eprintln!("[schedule] 保存运行态失败：{e}");
        }
    }

    fn emit_run(
        &self,
        task: &ScheduledTask,
        run_id: &str,
        status: &str,
        exit_code: Option<i32>,
        started_at: u64,
        ended_at: u64,
        manual: bool,
        reason: Option<String>,
    ) {
        let _ = self.app.emit(
            "schedule://run",
            RunEvent {
                task_id: task.id.clone(),
                task_name: task.name.clone(),
                run_id: run_id.to_string(),
                status: status.to_string(),
                exit_code,
                started_at,
                ended_at,
                notify: task.notify.clone(),
                manual,
                reason,
            },
        );
    }

    fn emit_changed(&self) {
        let _ = self.app.emit("schedule://changed", ());
    }

    /* ---------------- 供命令调用 ---------------- */

    pub fn list(&self) -> Vec<TaskView> {
        let now = Local::now();
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .tasks
            .iter()
            .map(|task| {
                let rt = inner
                    .runtime
                    .tasks
                    .get(&task.id)
                    .cloned()
                    .unwrap_or_default();
                let (next_runs, next_error) = match CronSpec::parse(&task.cron) {
                    Ok(spec) => (spec.next_n(now, 3).into_iter().map(ms).collect(), None),
                    Err(e) => (Vec::new(), Some(e)),
                };
                TaskView {
                    task: task.clone(),
                    next_at: rt.next_at,
                    next_runs,
                    next_error,
                    running: inner.running.contains_key(&task.id),
                    last_status: rt.last_status,
                    last_exit_code: rt.last_exit_code,
                    last_ms: rt.last_ms,
                    last_run_id: rt.last_run_id,
                }
            })
            .collect()
    }

    pub fn task(&self, id: &str) -> Option<ScheduledTask> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.tasks.iter().find(|t| t.id == id).cloned()
    }

    pub fn upsert(&self, task: ScheduledTask) {
        let next = if task.enabled {
            CronSpec::parse(&task.cron)
                .ok()
                .and_then(|s| s.next_after(Local::now()))
                .map(ms)
                .unwrap_or(0)
        } else {
            0
        };

        let mut need_info = false;
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let old = inner.tasks.iter().find(|t| t.id == task.id).cloned();

            match inner.tasks.iter_mut().find(|t| t.id == task.id) {
                Some(existing) => *existing = task.clone(),
                None => inner.tasks.push(task.clone()),
            }
            let rt = inner.runtime.tasks.entry(task.id.clone()).or_default();
            rt.next_at = next;
            inner.pending.remove(&task.id);

            let config_changed = old.as_ref().map_or(true, |o| {
                o.name != task.name
                    || o.cron != task.cron
                    || o.command.program != task.command.program
                    || o.command.args != task.command.args
                    || o.command.cwd != task.command.cwd
            });
            let was_enabled = old.as_ref().map(|o| o.enabled).unwrap_or(false);

            if !task.enabled {
                inner.session_info.remove(&task.id);
            } else if config_changed || !was_enabled || !inner.session_info.contains(&task.id) {
                // 新任务 / 从停用变启用 / 改了配置：视为一次新的「启动」，重打信息头
                inner.session_info.remove(&task.id);
                need_info = true;
            }
        }
        if need_info {
            self.ensure_task_info(&task);
        }
        self.persist();
        self.emit_changed();
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) {
        let next = if enabled {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let cron = inner
                .tasks
                .iter()
                .find(|t| t.id == id)
                .map(|t| t.cron.clone())
                .unwrap_or_default();
            drop(inner);
            CronSpec::parse(&cron)
                .ok()
                .and_then(|s| s.next_after(Local::now()))
                .map(ms)
                .unwrap_or(0)
        } else {
            0
        };

        let running = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.running.get(id).cloned()
        };

        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) {
                task.enabled = enabled;
            }
            let rt = inner.runtime.tasks.entry(id.to_string()).or_default();
            rt.next_at = next;
            if !enabled {
                inner.pending.remove(id);
                // 停用 = 暂停：下次启用时重新打印任务信息
                inner.session_info.remove(id);
            }
        }

        // 面板里复选框同时承担原来的「停止」按钮：取消勾选 = 停用并结束当前运行
        if !enabled {
            if let Some(control) = running {
                control.terminate(true);
            }
        } else {
            let task = {
                let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                inner.tasks.iter().find(|t| t.id == id).cloned()
            };
            if let Some(task) = task {
                self.ensure_task_info(&task);
            }
        }

        self.persist();
        self.emit_changed();
    }

    pub fn remove(&self, id: &str) {
        let control = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.running.get(id).cloned()
        };
        if let Some(control) = control {
            control.terminate(true);
        }

        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.tasks.retain(|t| t.id != id);
            inner.runtime.tasks.remove(id);
            inner.pending.remove(id);
            inner.session_info.remove(id);
        }
        self.persist();
        self.emit_changed();
    }

    pub fn stop(&self, id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.running.get(id) {
            Some(control) => {
                control.terminate(true);
                true
            }
            None => false,
        }
    }

    pub fn shutdown(&self) {
        let controls: Vec<Arc<RunControl>> = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.running.values().cloned().collect()
        };
        for control in controls {
            control.terminate(true);
        }
        self.persist();
    }

    pub fn list_runs(&self, task_id: &str, limit: usize) -> Vec<RunRecord> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut runs: Vec<RunRecord> = inner
            .runtime
            .runs
            .iter()
            .filter(|r| r.task_id == task_id)
            .cloned()
            .collect();
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        runs.truncate(limit.clamp(1, 100));
        runs
    }

    pub fn read_log(
        &self,
        task_id: &str,
        run_id: &str,
        tail_bytes: usize,
    ) -> Result<String, String> {
        let run = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .runtime
                .runs
                .iter()
                .find(|r| r.task_id == task_id && r.id == run_id)
                .cloned()
        }
        .ok_or_else(|| "运行记录不存在".to_string())?;

        if run.log.is_empty() {
            return Ok(run
                .reason
                .unwrap_or_else(|| "这次运行没有日志（已跳过）".to_string()));
        }

        let path = config_dir(&self.app)?.join(&run.log);
        if !path.is_file() {
            return Ok("该次运行的日志已轮转（每个任务只保留 task.log 与 task.log.1）".to_string());
        }
        read_tail(&path, tail_bytes.clamp(4096, 2 * 1024 * 1024))
    }

    /// 任务面板用：直接读该任务的固定 `task.log` 尾部（所有运行都追加在这里）。
    pub fn read_task_log(&self, task_id: &str, tail_bytes: usize) -> Result<String, String> {
        let path = task_log_path(&self.app, task_id)?;
        if !path.is_file() {
            return Ok("还没有日志。任务第一次运行后，输出会持续追加到这里。".to_string());
        }
        let mut text = read_tail(&path, tail_bytes.clamp(4096, 2 * 1024 * 1024))?;
        if path.with_file_name("task.log.1").is_file() {
            text.insert_str(0, "…（更早的日志已轮转到 task.log.1）\n");
        }
        Ok(text)
    }

    pub fn task_log_path_str(&self, task_id: &str) -> Result<String, String> {
        let path = task_log_path(&self.app, task_id)?;
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // 还没运行过时文件不存在：返回它所在的目录，用户至少能打开目录
        if path.is_file() {
            return Ok(path.display().to_string());
        }
        Ok(path
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| path.display().to_string()))
    }

    pub fn log_path(&self, task_id: &str, run_id: &str) -> Result<String, String> {
        let run = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .runtime
                .runs
                .iter()
                .find(|r| r.task_id == task_id && r.id == run_id)
                .cloned()
        }
        .ok_or_else(|| "运行记录不存在".to_string())?;
        if run.log.is_empty() {
            return Err("这次运行没有日志文件".to_string());
        }
        Ok(config_dir(&self.app)?.join(&run.log).display().to_string())
    }
}

/* ---------------- 命令组装 ---------------- */

fn build_launch(command: &model::ScheduledCommand) -> Result<Launch, String> {
    let raw = command.program.trim();
    if raw.is_empty() {
        return Err("没有填写程序".to_string());
    }
    let lower = raw.to_ascii_lowercase();
    if lower.ends_with(".lnk") {
        return Err("循环任务不支持 .lnk，请填写真实程序或 .bat/.cmd/.ps1".to_string());
    }

    let args = crate::custom_cmd::parse_args(&command.args)?;

    let cwd = match command
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(cwd) => PathBuf::from(cwd),
        None => {
            let p = Path::new(raw);
            let parent = p.parent().filter(|d| !d.as_os_str().is_empty());
            match parent {
                Some(dir) if dir.is_dir() => dir.to_path_buf(),
                _ => default_cwd(),
            }
        }
    };
    if !cwd.is_dir() {
        return Err(format!("工作目录不存在：{}", cwd.display()));
    }

    let resolved = crate::terminal::resolve_executable(raw);
    let resolved_lower = resolved.to_ascii_lowercase();

    let (program, args) = if resolved_lower.ends_with(".ps1") {
        let ps = crate::terminal::powershell_for(None);
        crate::terminal::wrap_ps1(&ps, &resolved, &args)
    } else {
        crate::ops::wrap_batch(resolved, args)
    };

    Ok(Launch { program, args, cwd })
}

fn default_cwd() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 打开任务的固定日志文件，并追加本次运行的时间分隔行。
///
/// 任务信息头由 `ensure_task_info` 在「启动会话」开始时写一次；这里只写
/// `======== 时间 ========`，后面紧跟程序输出。
fn open_task_log(
    app: &AppHandle,
    task: &ScheduledTask,
) -> Result<(Arc<Mutex<File>>, Arc<AtomicU64>, Arc<AtomicBool>, String), String> {
    let path = task_log_path(app, &task.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败: {e}"))?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志文件失败: {e}"))?;

    // 程序输出不一定以换行结束：时间行必须另起一行
    if !ends_with_newline(&path) {
        let _ = file.write_all(b"\n");
    }
    let header = format!(
        "======== {} ========\n",
        Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    file.write_all(header.as_bytes())
        .map_err(|e| format!("写日志分隔行失败: {e}"))?;

    let size = fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(header.len() as u64);

    Ok((
        Arc::new(Mutex::new(file)),
        Arc::new(AtomicU64::new(size)),
        Arc::new(AtomicBool::new(false)),
        task_log_rel(&task.id),
    ))
}

/// 任务信息头：每个启动会话打印一次，格式与面板里看到的一致。
fn task_info_text(task: &ScheduledTask) -> String {
    let cwd = task
        .command
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("（程序所在目录）");
    format!(
        "任务：{}\n计划：{}\n程序：{}\n参数：{}\n工作目录：{}\n----------------------------------------\n",
        task.name, task.cron, task.command.program, task.command.args, cwd
    )
}

/// 向任务日志追加文本；必要时先补一个换行，保证新内容从行首开始。
fn append_task_log(app: &AppHandle, task: &ScheduledTask, text: &str) -> bool {
    let Ok(path) = task_log_path(app, &task.id) else {
        return false;
    };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return false;
    };
    if !ends_with_newline(&path) {
        let _ = file.write_all(b"\n");
    }
    file.write_all(text.as_bytes()).is_ok()
}

/// 文件是否为空或以 `\n` 结尾；用于在追加新段落前补换行。
fn ends_with_newline(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return true;
    };
    if meta.len() == 0 {
        return true;
    }
    let Ok(mut file) = File::open(path) else {
        return true;
    };
    if file.seek(SeekFrom::End(-1)).is_err() {
        return true;
    }
    let mut byte = [0u8; 1];
    file.read_exact(&mut byte)
        .map(|_| byte[0] == b'\n')
        .unwrap_or(true)
}

/// 清理轮转出来的旧日志（`task.log.1`），保住总预算；绝不删正在写的 `task.log`。
fn prune_all_logs(app: &AppHandle) {
    let Ok(root) = logs_root(app) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };

    let mut all: Vec<(PathBuf, u64, SystemTime, bool)> = Vec::new();
    for dir in entries.flatten() {
        if !dir.path().is_dir() {
            continue;
        }
        let Ok(inner) = fs::read_dir(dir.path()) else {
            continue;
        };
        for f in inner.flatten() {
            let path = f.path();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let Ok(meta) = f.metadata() else { continue };
            if meta.is_file() {
                all.push((
                    path,
                    meta.len(),
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    name.ends_with(".log.1"),
                ));
            }
        }
    }

    let mut total: u64 = all.iter().map(|(_, size, _, _)| *size).sum();
    let mut rotated: Vec<(PathBuf, u64, SystemTime)> = all
        .into_iter()
        .filter(|(_, _, _, is_rotated)| *is_rotated)
        .map(|(path, size, time, _)| (path, size, time))
        .collect();
    rotated.sort_by_key(|(_, _, time)| *time);

    for (path, size, _) in rotated {
        if total <= MAX_ALL_LOG_BYTES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn write_log(
    file: &Arc<Mutex<File>>,
    written: &Arc<AtomicU64>,
    truncated: &Arc<AtomicBool>,
    data: &[u8],
) {
    let total = written.load(Ordering::Relaxed);
    if total >= MAX_TASK_LOG_BYTES {
        if !truncated.swap(true, Ordering::Relaxed) {
            if let Ok(mut f) = file.lock() {
                let _ = f.write_all("\n[本次运行日志超过 10 MB，后续输出已截断]\n".as_bytes());
            }
        }
        return;
    }

    let remain = (MAX_TASK_LOG_BYTES - total) as usize;
    let take = remain.min(data.len());
    if take == 0 {
        return;
    }

    if let Ok(mut f) = file.lock() {
        let _ = f.write_all(&data[..take]);
        written.fetch_add(take as u64, Ordering::Relaxed);
        if take < data.len() && !truncated.swap(true, Ordering::Relaxed) {
            let _ = f.write_all("\n[本次运行日志超过 10 MB，后续输出已截断]\n".as_bytes());
        }
    }
}

fn read_tail(path: &Path, max: usize) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("打开日志失败: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("读取日志信息失败: {e}"))?
        .len();
    let start = len.saturating_sub(max as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位日志失败: {e}"))?;

    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("读取日志失败: {e}"))?;

    let mut text = String::from_utf8_lossy(&buf).to_string();
    if start > 0 {
        text.insert_str(0, "…（仅显示日志尾部）\n");
    }
    Ok(text)
}

fn cap_runs(store: &mut RuntimeStore) {
    store.runs.sort_by_key(|r| r.started_at);
    if store.runs.len() > MAX_RUNS {
        let drop = store.runs.len() - MAX_RUNS;
        store.runs.drain(..drop);
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut keep: Vec<RunRecord> = Vec::new();
    for run in store.runs.iter().rev() {
        let count = counts.entry(run.task_id.clone()).or_default();
        if *count < MAX_RUNS_PER_TASK {
            keep.push(run.clone());
            *count += 1;
        }
    }
    keep.reverse();
    store.runs = keep;
}

/* ---------------- Tauri 命令 ---------------- */

#[tauri::command]
pub fn list_scheduled_tasks(sc: tauri::State<'_, Scheduler>) -> Vec<TaskView> {
    sc.list()
}

/// 校验 cron 并返回接下来 `count` 次触发（毫秒时间戳）。编辑器实时预览用。
#[tauri::command]
pub fn preview_cron(cron: String, count: Option<usize>) -> Result<Vec<u64>, String> {
    let spec = CronSpec::parse(&cron)?;
    let list = spec.next_n(Local::now(), count.unwrap_or(5).clamp(1, 10));
    if list.is_empty() {
        return Err("这个 cron 表达式在可预见的未来不会触发".to_string());
    }
    Ok(list.into_iter().map(ms).collect())
}

fn normalize_task(mut task: ScheduledTask) -> Result<ScheduledTask, String> {
    task.name = task.name.trim().to_string();
    if task.name.is_empty() {
        return Err("任务名称不能为空".to_string());
    }
    if task.name.chars().count() > 80 {
        return Err("任务名称最多 80 个字符".to_string());
    }

    task.cron = task.cron.trim().to_string();
    if task.cron.chars().count() > 200 {
        return Err("cron 表达式过长".to_string());
    }
    let spec = CronSpec::parse(&task.cron)?;
    if spec.next_after(Local::now()).is_none() {
        return Err("这个 cron 表达式在可预见的未来不会触发".to_string());
    }

    task.command.program = task.command.program.trim().to_string();
    if task.command.program.is_empty() {
        return Err("请填写要执行的程序".to_string());
    }
    if task.command.program.to_ascii_lowercase().ends_with(".lnk") {
        return Err("循环任务不支持 .lnk，请填写真实程序或 .bat/.cmd/.ps1".to_string());
    }
    task.command.args = task.command.args.trim().to_string();
    // 参数原文在保存时就校验一次，避免「保存成功、每次运行都失败」
    crate::custom_cmd::parse_args(&task.command.args)?;
    task.command.cwd = task
        .command
        .cwd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    task.notify = match task.notify.trim() {
        "always" => "always".to_string(),
        "never" => "never".to_string(),
        _ => "onFailure".to_string(),
    };
    task.overlap = match task.overlap.trim() {
        "queue" => "queue".to_string(),
        "kill" => "kill".to_string(),
        _ => "skip".to_string(),
    };
    task.catch_up = match task.catch_up.trim() {
        "once" => "once".to_string(),
        _ => "skip".to_string(),
    };
    // 7 天封顶，避免手改状态文件写出离谱的超时
    task.timeout_secs = task.timeout_secs.min(7 * 24 * 3600);

    if task.id.trim().is_empty() {
        task.id = model::make_id(
            "task",
            &format!("{}|{}|{}", task.name, task.command.program, now_ms()),
        );
    }
    if task.created_at == 0 {
        task.created_at = now_ms();
    }
    Ok(task)
}

#[tauri::command]
pub fn upsert_scheduled_task(
    app: AppHandle,
    sc: tauri::State<'_, Scheduler>,
    task: ScheduledTask,
) -> Result<crate::model::State, String> {
    let task = normalize_task(task)?;

    let mut state = crate::store::load(&app)?;
    match state.scheduled_tasks.iter_mut().find(|t| t.id == task.id) {
        Some(existing) => *existing = task.clone(),
        None => state.scheduled_tasks.push(task.clone()),
    }
    crate::store::save(&app, &state)?;

    sc.upsert(task);
    Ok(state)
}

#[tauri::command]
pub fn remove_scheduled_task(
    app: AppHandle,
    sc: tauri::State<'_, Scheduler>,
    id: String,
) -> Result<crate::model::State, String> {
    let mut state = crate::store::load(&app)?;
    state.scheduled_tasks.retain(|t| t.id != id);
    crate::store::save(&app, &state)?;

    sc.remove(&id);
    Ok(state)
}

#[tauri::command]
pub fn set_scheduled_task_enabled(
    app: AppHandle,
    sc: tauri::State<'_, Scheduler>,
    id: String,
    enabled: bool,
) -> Result<crate::model::State, String> {
    let mut state = crate::store::load(&app)?;
    let task = state
        .scheduled_tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| "任务不存在".to_string())?;
    task.enabled = enabled;
    crate::store::save(&app, &state)?;

    sc.set_enabled(&id, enabled);
    Ok(state)
}

#[tauri::command]
pub fn run_scheduled_task_now(
    sc: tauri::State<'_, Scheduler>,
    id: String,
) -> Result<String, String> {
    let task = sc.task(&id).ok_or_else(|| "任务不存在".to_string())?;
    let run_id = sc.fire(task, 0, true)?;
    if run_id.is_empty() {
        return Err("任务不存在或已删除".to_string());
    }
    Ok(run_id)
}

#[tauri::command]
pub fn stop_scheduled_task(sc: tauri::State<'_, Scheduler>, id: String) -> Result<bool, String> {
    Ok(sc.stop(&id))
}

#[tauri::command]
pub fn list_scheduled_runs(
    sc: tauri::State<'_, Scheduler>,
    task_id: String,
    limit: Option<usize>,
) -> Vec<RunRecord> {
    sc.list_runs(&task_id, limit.unwrap_or(20))
}

#[tauri::command]
pub fn read_scheduled_log(
    sc: tauri::State<'_, Scheduler>,
    task_id: String,
    run_id: String,
    tail_bytes: Option<usize>,
) -> Result<String, String> {
    sc.read_log(&task_id, &run_id, tail_bytes.unwrap_or(200_000))
}

#[tauri::command]
pub fn scheduled_log_path(
    sc: tauri::State<'_, Scheduler>,
    task_id: String,
    run_id: String,
) -> Result<String, String> {
    sc.log_path(&task_id, &run_id)
}

#[tauri::command]
pub fn read_task_log(
    sc: tauri::State<'_, Scheduler>,
    task_id: String,
    tail_bytes: Option<usize>,
) -> Result<String, String> {
    sc.read_task_log(&task_id, tail_bytes.unwrap_or(200_000))
}

/// 任务固定日志文件的绝对路径（面板里的「打开日志目录」用）。
#[tauri::command]
pub fn scheduled_task_log_path(
    sc: tauri::State<'_, Scheduler>,
    task_id: String,
) -> Result<String, String> {
    sc.task_log_path_str(&task_id)
}

/// 清空任务的 task.log（连同旧的 task.log.1）。
#[tauri::command]
pub fn clear_task_log(sc: tauri::State<'_, Scheduler>, task_id: String) -> Result<(), String> {
    sc.clear_task_log(&task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("appdeck_sched_{tag}_{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bat_is_wrapped_through_cmd() {
        let dir = temp_dir("bat");
        let bat = dir.join("hello.bat");
        fs::write(&bat, "@echo off\r\necho hi\r\n").unwrap();

        let launch = build_launch(&model::ScheduledCommand {
            program: bat.display().to_string(),
            args: "one two".to_string(),
            cwd: Some(dir.display().to_string()),
        })
        .unwrap();

        let name = Path::new(&launch.program)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase();
        assert_eq!(name, "cmd.exe");
        assert_eq!(launch.args[0], "/d");
        assert_eq!(launch.args[1], "/c");
        assert!(launch.args[2].to_ascii_lowercase().ends_with("hello.bat"));
        assert_eq!(
            &launch.args[3..],
            &["one".to_string(), "two".to_string()][..]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lnk_is_rejected() {
        let err = build_launch(&model::ScheduledCommand {
            program: "C:\\apps\\foo.lnk".to_string(),
            args: String::new(),
            cwd: None,
        })
        .unwrap_err();
        assert!(err.contains(".lnk"), "{err}");
    }

    #[test]
    fn missing_cwd_is_rejected() {
        let err = build_launch(&model::ScheduledCommand {
            program: "cmd.exe".to_string(),
            args: String::new(),
            cwd: Some("Z:\\definitely\\not\\here".to_string()),
        })
        .unwrap_err();
        assert!(err.contains("工作目录不存在"), "{err}");
    }

    #[test]
    fn unclosed_quote_is_rejected() {
        let err = build_launch(&model::ScheduledCommand {
            program: "cmd.exe".to_string(),
            args: "\"unclosed".to_string(),
            cwd: None,
        })
        .unwrap_err();
        assert!(err.contains("双引号"), "{err}");
    }

    #[test]
    fn cap_runs_keeps_global_and_per_task_limits() {
        let mut store = RuntimeStore::default();
        for i in 0..600 {
            store.runs.push(RunRecord {
                id: format!("run-{i}"),
                task_id: format!("task-{}", i % 20),
                started_at: i,
                ..Default::default()
            });
        }
        cap_runs(&mut store);

        assert!(store.runs.len() <= MAX_RUNS, "global cap");
        let mut counts: HashMap<String, usize> = HashMap::new();
        for run in &store.runs {
            *counts.entry(run.task_id.clone()).or_default() += 1;
        }
        assert!(
            counts.values().all(|n| *n <= MAX_RUNS_PER_TASK),
            "per-task cap: {counts:?}"
        );
    }

    #[test]
    fn read_tail_keeps_the_end() {
        let dir = temp_dir("tail");
        let path = dir.join("a.log");
        fs::write(&path, "A".repeat(1000) + "TAIL").unwrap();
        let text = read_tail(&path, 100).unwrap();
        assert!(text.ends_with("TAIL"), "{text}");
        assert!(text.starts_with("…（仅显示日志尾部）"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    fn valid_task() -> ScheduledTask {
        ScheduledTask {
            name: "测试任务".to_string(),
            cron: "* * * * *".to_string(),
            command: model::ScheduledCommand {
                program: "cmd.exe".to_string(),
                args: "/c echo hi".to_string(),
                cwd: None,
            },
            ..Default::default()
        }
    }

    #[test]
    fn normalize_rejects_never_firing_cron() {
        let mut task = valid_task();
        task.cron = "0 0 31 4 *".to_string();
        let err = normalize_task(task).unwrap_err();
        assert!(err.contains("不会触发"), "{err}");
    }

    #[test]
    fn normalize_rejects_lnk_and_bad_args() {
        let mut task = valid_task();
        task.command.program = "C:\\apps\\x.lnk".to_string();
        assert!(normalize_task(task).unwrap_err().contains(".lnk"));

        let mut task = valid_task();
        task.command.args = "\"unclosed".to_string();
        assert!(normalize_task(task).unwrap_err().contains("双引号"));
    }

    #[test]
    fn normalize_fills_id_and_defaults() {
        let task = normalize_task(valid_task()).unwrap();
        assert!(task.id.starts_with("task-"), "{}", task.id);
        assert!(task.enabled);
        assert_eq!(task.notify, "onFailure");
        assert_eq!(task.overlap, "skip");
        assert_eq!(task.catch_up, "skip");
        assert!(task.created_at > 0);
    }

    #[test]
    fn task_info_layout_matches_expected() {
        let text = task_info_text(&valid_task());
        assert_eq!(
            text,
            "任务：测试任务\n计划：* * * * *\n程序：cmd.exe\n参数：/c echo hi\n工作目录：（程序所在目录）\n----------------------------------------\n"
        );
    }

    #[test]
    fn ends_with_newline_detects_missing() {
        let dir = temp_dir("newline");
        let path = dir.join("a.log");
        assert!(ends_with_newline(&path), "missing file counts as newline");
        fs::write(&path, "").unwrap();
        assert!(ends_with_newline(&path));
        fs::write(&path, "abc").unwrap();
        assert!(!ends_with_newline(&path));
        fs::write(&path, "abc\n").unwrap();
        assert!(ends_with_newline(&path));
        let _ = fs::remove_dir_all(&dir);
    }
}
