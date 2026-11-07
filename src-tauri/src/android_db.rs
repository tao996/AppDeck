//! Android 应用 SQLite 只读查看（adb `run-as` 快照）。
//!
//! 为什么不用 Android Studio 的 Database Inspector：
//! 它通过 JDWP 把 IDE 私有 agent 注入 debuggable 进程，协议不公开、也没有独立版本。
//! 这里换一条等价但解耦的路：debug 包可以用 `run-as`（app 同 UID）直接读文件，
//! 把 db（连同 `-wal`）拉到本机，再用 SQLite 打开——全程不改 app、不需要 Studio。
//!
//! 边界：
//! - 只支持 debuggable 包（`run-as` 的前提），release 包需要 root，不在范围内；
//! - 看到的是拉取那一刻的快照，不是 Studio 的实时连接；
//! - 本机副本只用于只读查询，写操作一律拒绝（`Statement::readonly` + `query_only`）。

use crate::model::AndroidSettings;
use rusqlite::{types::ValueRef, Connection, OpenFlags, Statement};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 单次查询/分页最多返回的行数，防止 `SELECT * FROM 大表` 把界面拖死。
const MAX_LIMIT: usize = 5000;

/* ---------------- 返回给前端的结构 ---------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbDevice {
    pub serial: String,
    /// device / unauthorized / offline …
    pub state: String,
    pub model: String,
    pub product: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbEnv {
    /// 解析到的 adb 可执行文件；None = 没找到
    pub adb: Option<String>,
    pub adb_version: Option<String>,
    pub devices: Vec<DbDevice>,
    /// 从项目 gradle 里猜出来的包名
    pub package: Option<String>,
    /// 当前前台应用（猜不到包名时的兜底提示）
    pub foreground: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbFile {
    /// 设备上的相对路径，如 `./databases/app.db`
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    pub name: String,
    pub sql: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbOpen {
    pub session_id: String,
    pub local_path: String,
    pub remote_path: String,
    pub size: u64,
    /// 拉取时是否带上了 `-wal`（WAL 里的最新数据靠它）
    pub wal: bool,
    pub tables: Vec<DbTable>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbPage {
    pub columns: Vec<String>,
    /// 每格已转成字符串；SQL NULL 用 null 表示
    pub rows: Vec<Vec<Option<String>>>,
    pub truncated: bool,
    pub elapsed_ms: u64,
    /// 仅表浏览模式有值（COUNT(*)）；SQL 模式为 null
    pub total: Option<i64>,
}

/* ---------------- 会话 ---------------- */

pub struct DbSession {
    conn: Mutex<Connection>,
    dir: PathBuf,
    db: PathBuf,
}

#[derive(Default)]
pub struct DbSessions(pub Mutex<HashMap<String, Arc<DbSession>>>);

impl DbSessions {
    /// 退出应用前调用：关连接、删临时副本。
    pub fn clear(&self) {
        let sessions: Vec<Arc<DbSession>> = match self.0.lock() {
            Ok(mut map) => map.drain().map(|(_, s)| s).collect(),
            Err(_) => return,
        };
        for s in sessions {
            drop(s); // 先关连接，Windows 上才删得掉文件
        }
    }

    fn take(&self, id: &str) -> Option<Arc<DbSession>> {
        self.0.lock().ok()?.remove(id)
    }
}

/* ---------------- adb 基础 ---------------- */

fn clean(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "adb.exe"
    } else {
        "adb"
    }
}

/// 定位 adb：设置里的 SDK 目录 → ANDROID_SDK_ROOT / ANDROID_HOME → PATH。
pub fn resolve_adb(s: &AndroidSettings) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(sdk) = clean(&s.sdk_path) {
        candidates.push(Path::new(&sdk).join("platform-tools").join(exe_name()));
    }
    for key in ["ANDROID_SDK_ROOT", "ANDROID_HOME", "ANDROID_SDK_HOME"] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                candidates.push(Path::new(v.trim()).join("platform-tools").join(exe_name()));
            }
        }
    }
    if let Some(p) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(p);
    }
    find_in_path(exe_name())
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn run(adb: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new(adb);
    cmd.args(args);
    // 不弹黑框
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output()
        .map_err(|e| format!("无法执行 adb（{}）：{e}", adb.display()))
}

fn ok_text(out: Output, what: &str) -> Result<String, String> {
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("{what}失败（adb 退出码 {:?}）", out.status.code())
        } else {
            format!("{what}失败：{err}")
        })
    }
}

fn shell(adb: &Path, serial: &str, cmd: &str) -> Result<String, String> {
    ok_text(run(adb, &["-s", serial, "shell", cmd])?, "adb shell")
}

/// 设备侧路径的 shell 引用（只给安全字符放行，其余单引号包起来）。
fn shell_quote(s: &str) -> String {
    let safe = !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-' | b'~'));
    if safe {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

pub fn valid_package(pkg: &str) -> bool {
    !pkg.is_empty()
        && pkg.len() <= 255
        && pkg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_'))
}

fn valid_serial(serial: &str) -> bool {
    !serial.is_empty()
        && serial.len() <= 128
        && serial
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/* ---------------- 设备 / 包名 ---------------- */

/// 解析 `adb devices -l`。独立函数便于单测。
pub fn parse_devices(text: &str) -> Vec<DbDevice> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
            continue;
        }
        let mut it = line.split_whitespace();
        let Some(serial) = it.next() else { continue };
        let state = it.next().unwrap_or("").to_string();
        if serial.is_empty() || state.is_empty() {
            continue;
        }
        let mut model = String::new();
        let mut product = String::new();
        for kv in it {
            if let Some(v) = kv.strip_prefix("model:") {
                model = v.to_string();
            } else if let Some(v) = kv.strip_prefix("product:") {
                product = v.to_string();
            }
        }
        out.push(DbDevice {
            serial: serial.to_string(),
            state,
            model,
            product,
        });
    }
    out
}

/// 当前前台应用包名：`dumpsys window` 里 `mCurrentFocus=Window{... u0 pkg/act}`。
pub fn parse_foreground(text: &str) -> Option<String> {
    for key in ["mCurrentFocus", "mFocusedApp"] {
        for line in text.lines().filter(|l| l.contains(key)) {
            // 取最后一个 `xxx/yyy` 里的 xxx
            let mut best: Option<String> = None;
            for token in line.split_whitespace() {
                if let Some(slash) = token.find('/') {
                    let mut pkg = &token[..slash];
                    // 去掉 `u0` / `+` 之类前缀
                    if let Some(pos) = pkg.rfind('}') {
                        pkg = &pkg[pos + 1..];
                    }
                    if let Some(pos) = pkg.rfind(' ') {
                        pkg = &pkg[pos + 1..];
                    }
                    let pkg = pkg.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '_');
                    if !pkg.is_empty() && pkg.contains('.') {
                        best = Some(pkg.to_string());
                    }
                }
            }
            if best.is_some() {
                return best;
            }
        }
    }
    None
}

/// 从 Gradle 脚本里取 `applicationId`（取不到再退 `namespace`）。
/// Groovy: `applicationId "com.x"` / Kotlin: `applicationId = "com.x"`。
pub fn parse_application_id(gradle: &str) -> Option<String> {
    fn quoted_after(line: &str, key: &str) -> Option<String> {
        let idx = line.find(key)?;
        let rest = &line[idx + key.len()..];
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            return None;
        }
        let end = rest[1..].find(quote)?;
        let v = rest[1..1 + end].trim();
        if v.is_empty() {
            None
        } else {
            Some(v.to_string())
        }
    }

    let mut namespace = None;
    for line in gradle.lines() {
        let code = line.split("//").next().unwrap_or(line);
        if code.contains("applicationIdSuffix") {
            continue;
        }
        if let Some(v) = quoted_after(code, "applicationId") {
            return Some(v);
        }
        if namespace.is_none() {
            namespace = quoted_after(code, "namespace");
        }
    }
    namespace
}

/// 兼容老工程的 AndroidManifest：`package="com.x"`
pub fn parse_manifest_package(manifest: &str) -> Option<String> {
    let idx = manifest.find("package=")?;
    let rest = &manifest[idx + "package=".len()..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let end = rest[1..].find(quote)?;
    let v = rest[1..1 + end].trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// 从项目目录猜包名。猜不到返回 None（前端可以让用户手填）。
pub fn detect_package(project_path: &str) -> Option<String> {
    let app = Path::new(project_path).join("android").join("app");
    for name in ["build.gradle.kts", "build.gradle"] {
        let p = app.join(name);
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Some(v) = parse_application_id(&text) {
                return Some(v);
            }
        }
    }
    let manifest = app.join("src").join("main").join("AndroidManifest.xml");
    std::fs::read_to_string(manifest)
        .ok()
        .and_then(|t| parse_manifest_package(&t))
}

/* ---------------- 文件列表 ---------------- */

const FIND_BODY: &str = r#"find . -maxdepth 4 -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db3" \)"#;

/// shared_prefs 目录只找 XML；Flutter 的键在 FlutterSharedPreferences.xml 里。
const PREFS_FIND_BODY: &str =
    r#"find ./shared_prefs -maxdepth 1 -type f -name "*.xml""#;

fn list_xml_files(
    adb: &Path,
    serial: &str,
    package: &str,
    find_body: &str,
) -> Result<Vec<DbFile>, String> {
    if !valid_serial(serial) {
        return Err("设备序号不合法".into());
    }
    if !valid_package(package) {
        return Err("包名不合法".into());
    }

    let with_stat = format!(
        "run-as {package} sh -c '{find_body} -exec stat -c \"%s %n\" {{}} + 2>/dev/null'"
    );
    let text = shell(adb, serial, &with_stat).unwrap_or_default();
    let mut files = parse_find_output(&text);

    if files.is_empty() {
        let plain = format!("run-as {package} sh -c '{find_body} 2>/dev/null'");
        let text = shell(adb, serial, &plain)?;
        if text.trim().is_empty() {
            let probe = format!("run-as {package} true");
            if let Err(e) = shell(adb, serial, &probe) {
                return Err(format!(
                    "无法以 {package} 的身份读取数据目录（release 包或未安装？）：{e}"
                ));
            }
        }
        files = parse_find_output(&text);
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// 列出 `<app>/shared_prefs/*.xml`（Flutter 的 SharedPreferences 就在这里）。
pub fn list_pref_files(
    adb: &Path,
    serial: &str,
    package: &str,
) -> Result<Vec<DbFile>, String> {
    list_xml_files(adb, serial, package, PREFS_FIND_BODY)
}

fn valid_pref_path(remote: &str) -> bool {
    remote.starts_with("./shared_prefs/")
        && remote.ends_with(".xml")
        && !remote.contains("..")
        && !remote.contains('\0')
        && remote.len() <= 512
}

/// 读取一个 shared_prefs XML 的原文；解析交给前端 DOMParser。
pub fn read_pref_file(
    adb: &Path,
    serial: &str,
    package: &str,
    remote: &str,
) -> Result<String, String> {
    if !valid_serial(serial) || !valid_package(package) {
        return Err("设备或包名不合法".into());
    }
    if !valid_pref_path(remote) {
        return Err("SharedPreferences 文件路径不合法".into());
    }

    let cmd = format!("run-as {package} cat {}", shell_quote(remote));
    let out = run(adb, &["-s", serial, "exec-out", &cmd])?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("读取 {remote} 失败（adb 退出码 {:?}）", out.status.code())
        } else {
            format!("读取 {remote} 失败：{err}")
        });
    }
    if out.stdout.len() > 4 * 1024 * 1024 {
        return Err("SharedPreferences 文件超过 4 MB，拒绝在面板里展开".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 解析 `-exec stat -c "%s %n"` 的输出；没有 stat 时退回只有路径的 find 输出。
pub fn parse_find_output(text: &str) -> Vec<DbFile> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 两种输出：`stat` 的 `<size> <path>`，或纯 `find` 的 `<path>`
        let (size, path) = match line.split_once(' ') {
            Some((s, p)) if s.bytes().all(|b| b.is_ascii_digit()) && p.trim().starts_with("./") => {
                (s.parse::<u64>().unwrap_or(0), p.trim().to_string())
            }
            _ if line.starts_with("./") => (0, line.to_string()),
            _ => continue,
        };
        out.push(DbFile { path, size });
    }
    out
}

/// 列出设备上 app 数据目录里的 SQLite 文件（相对 app 数据目录）。
pub fn list_files(
    adb: &Path,
    serial: &str,
    package: &str,
) -> Result<Vec<DbFile>, String> {
    if !valid_serial(serial) {
        return Err("设备序号不合法".into());
    }
    if !valid_package(package) {
        return Err("包名不合法".into());
    }

    // 一次 find 带上 stat：`40960 ./databases/app.db`
    let with_stat = format!(
        "run-as {package} sh -c '{FIND_BODY} -exec stat -c \"%s %n\" {{}} + 2>/dev/null'"
    );
    let text = shell(adb, serial, &with_stat).unwrap_or_default();
    let mut files = parse_find_output(&text);

    if files.is_empty() {
        // 老设备没有 `stat`：退化成只列路径（大小显示 0）
        let plain = format!("run-as {package} sh -c '{FIND_BODY} 2>/dev/null'");
        let text = shell(adb, serial, &plain)?;
        if text.trim().is_empty() {
            // 区分「run-as 不可用」和「确实没有库」
            let probe = format!("run-as {package} true");
            if let Err(e) = shell(adb, serial, &probe) {
                return Err(format!(
                    "无法以 {package} 的身份读取数据目录（release 包或未安装？）：{e}"
                ));
            }
        }
        files = parse_find_output(&text);
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn remote_exists(adb: &Path, serial: &str, package: &str, path: &str) -> bool {
    let cmd = format!("run-as {package} test -e {}", shell_quote(path));
    run(adb, &["-s", serial, "shell", &cmd])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn pull_file(
    adb: &Path,
    serial: &str,
    package: &str,
    remote: &str,
    dest: &Path,
) -> Result<u64, String> {
    let cmd = format!("run-as {package} cat {}", shell_quote(remote));
    let out = run(adb, &["-s", serial, "exec-out", &cmd])?;
    if !out.status.success() || out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("拉取 {remote} 失败（adb 退出码 {:?}）", out.status.code())
        } else {
            format!("拉取 {remote} 失败：{err}")
        });
    }
    std::fs::write(dest, &out.stdout).map_err(|e| format!("写入临时文件失败：{e}"))?;
    Ok(out.stdout.len() as u64)
}

/* ---------------- SQLite ---------------- */

fn tables_of(conn: &Connection) -> Result<Vec<DbTable>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|e| format!("读取表列表失败：{e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DbTable {
                name: r.get::<_, String>(0)?,
                sql: r.get::<_, Option<String>>(1)?,
            })
        })
        .map_err(|e| format!("读取表列表失败：{e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取表列表失败：{e}"))?);
    }
    Ok(out)
}

fn cell(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(n) => Some(n.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Some(format!("<BLOB {} B>", b.len())),
    }
}

/// 执行一条**只读**语句并取前 `limit` 行。
///
/// 安全边界：
/// - `Statement::readonly()` 拒绝 INSERT/UPDATE/DELETE/DDL 等；
/// - 连接本身也开了 `PRAGMA query_only=ON`（双保险）；
/// - 永远只调 `query`，不调 `execute`。
fn read_page(conn: &Connection, sql: &str, limit: usize) -> Result<DbPage, String> {
    let t0 = Instant::now();
    let limit = limit.clamp(1, MAX_LIMIT);

    let mut stmt: Statement<'_> = conn
        .prepare(sql)
        .map_err(|e| format!("SQL 解析失败：{e}"))?;
    if !stmt.readonly() {
        return Err("这里只允许只读 SQL（SELECT / PRAGMA / WITH / EXPLAIN）".into());
    }

    let columns: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
    let mut out: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    {
        let mut rows = stmt.query([]).map_err(|e| format!("执行失败：{e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("读取结果失败：{e}"))? {
            if out.len() >= limit {
                truncated = true;
                break;
            }
            let mut rec = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                let v = row.get_ref(i).map_err(|e| format!("读取第 {i} 列失败：{e}"))?;
                rec.push(cell(v));
            }
            out.push(rec);
        }
    }

    Ok(DbPage {
        columns,
        rows: out,
        truncated,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        total: None,
    })
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |_| Ok(()),
    )
    .map(|_| true)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(false),
        other => Err(format!("检查表是否存在失败：{other}")),
    })
}

pub fn table_page(
    conn: &Connection,
    table: &str,
    offset: i64,
    limit: usize,
) -> Result<DbPage, String> {
    if !table_exists(conn, table)? {
        return Err(format!("表不存在：{table}"));
    }
    let limit = limit.clamp(1, MAX_LIMIT);
    let offset = offset.max(0);

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {}", quote_ident(table)),
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("统计行数失败：{e}"))?;

    let sql = format!(
        "SELECT * FROM {} LIMIT {} OFFSET {}",
        quote_ident(table),
        limit,
        offset
    );
    let mut page = read_page(conn, &sql, limit)?;
    page.total = Some(total);
    Ok(page)
}

/// 把本机副本导出成干净的单个 .db（WAL 内容会合并进去）。
pub fn export_db(session: &DbSession, dest: &str) -> Result<(), String> {
    let dest = Path::new(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    if dest.is_file() {
        std::fs::remove_file(dest).map_err(|e| format!("覆盖已有文件失败：{e}"))?;
    }
    // 单独开连接：导出连接不能带 query_only
    let conn = Connection::open(&session.db).map_err(|e| format!("打开副本失败：{e}"))?;
    conn.execute("VACUUM INTO ?1", [dest.display().to_string()])
        .map_err(|e| format!("导出失败：{e}"))?;
    Ok(())
}

/* ---------------- 打开 / 页面 / 关闭 ---------------- */

fn confirm_remote_path(remote: &str) -> Result<(), String> {
    if !remote.starts_with("./")
        || remote.contains("..")
        || remote.contains('\0')
        || remote.len() > 512
    {
        return Err("数据库路径不合法".into());
    }
    Ok(())
}

/// 拉取 db（+ wal）到临时目录并打开。
pub fn open_snapshot(
    sessions: &DbSessions,
    adb: &Path,
    serial: &str,
    package: &str,
    remote: &str,
) -> Result<DbOpen, String> {
    if !valid_serial(serial) || !valid_package(package) {
        return Err("设备或包名不合法".into());
    }
    confirm_remote_path(remote)?;

    let id = format!(
        "db-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    );
    let dir = std::env::temp_dir().join(format!("appdeck-{id}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;

    let local = dir.join("snapshot.db");
    let size = match pull_file(adb, serial, package, remote, &local) {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };

    let wal_remote = format!("{remote}-wal");
    let mut wal = false;
    if remote_exists(adb, serial, package, &wal_remote) {
        let wal_local = dir.join("snapshot.db-wal");
        match pull_file(adb, serial, package, &wal_remote, &wal_local) {
            Ok(_) => wal = true,
            Err(_) => {
                // WAL 拉不到不算致命：只是可能少最后几条已提交数据
                let _ = std::fs::remove_file(&wal_local);
            }
        }
    }

    let conn = match Connection::open_with_flags(
        &local,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!(
                "打开副本失败（可能不是有效的 SQLite 文件）：{e}"
            ));
        }
    };
    // 即使代码里只 prepare 不 execute，也把连接锁成只读，双保险
    let _ = conn.execute_batch("PRAGMA query_only = ON;");

    let tables = match tables_of(&conn) {
        Ok(t) => t,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };

    let session = Arc::new(DbSession {
        conn: Mutex::new(conn),
        dir: dir.clone(),
        db: local.clone(),
    });
    sessions
        .0
        .lock()
        .map_err(|_| "会话锁失败".to_string())?
        .insert(id.clone(), session);

    Ok(DbOpen {
        session_id: id,
        local_path: local.display().to_string(),
        remote_path: remote.to_string(),
        size,
        wal,
        tables,
    })
}

pub fn query(sessions: &DbSessions, id: &str, sql: &str, limit: usize) -> Result<DbPage, String> {
    let s = sessions
        .0
        .lock()
        .ok()
        .and_then(|m| m.get(id).cloned())
        .ok_or_else(|| "会话已关闭，请重新打开数据库".to_string())?;
    let conn = s.conn.lock().map_err(|_| "数据库锁失败".to_string())?;
    read_page(&conn, sql.trim(), limit)
}

pub fn rows(
    sessions: &DbSessions,
    id: &str,
    table: &str,
    offset: i64,
    limit: usize,
) -> Result<DbPage, String> {
    let s = sessions
        .0
        .lock()
        .ok()
        .and_then(|m| m.get(id).cloned())
        .ok_or_else(|| "会话已关闭，请重新打开数据库".to_string())?;
    let conn = s.conn.lock().map_err(|_| "数据库锁失败".to_string())?;
    table_page(&conn, table, offset, limit)
}

pub fn close(sessions: &DbSessions, id: &str) -> Result<(), String> {
    let s = sessions.take(id);
    if let Some(s) = s {
        let dir = s.dir.clone();
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(())
}

/// 清理上次异常退出（崩溃 / 被强杀）遗留的临时副本。
/// 正常退出会走 `close` / `quit_app`，不会留下；这里启动时兜底扫一遍。
pub fn clean_stale() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("appdeck-db-")
            && e.file_type().map(|t| t.is_dir()).unwrap_or(false)
        {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

pub fn export(sessions: &DbSessions, id: &str, dest: &str) -> Result<(), String> {
    let s = sessions
        .0
        .lock()
        .ok()
        .and_then(|m| m.get(id).cloned())
        .ok_or_else(|| "会话已关闭，请重新打开数据库".to_string())?;
    export_db(&s, dest)
}

/* ---------------- 环境探测 ---------------- */

pub fn env(project_path: Option<&str>, settings: &AndroidSettings) -> DbEnv {
    let mut notes: Vec<String> = Vec::new();
    let adb = resolve_adb(settings);

    let Some(adb_path) = adb else {
        notes.push(
            "没有找到 adb。请在设置 → Android 里填 SDK 目录，或把 platform-tools 加进 PATH。"
                .into(),
        );
        return DbEnv {
            adb: None,
            adb_version: None,
            devices: Vec::new(),
            package: project_path.and_then(detect_package),
            foreground: None,
            notes,
        };
    };

    let version = run(&adb_path, &["version"])
        .ok()
        .and_then(|o| o.status.success().then_some(o))
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find(|l| l.starts_with("Android Debug Bridge"))
                .map(|s| s.to_string())
        });

    let devices = run(&adb_path, &["devices", "-l"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_devices(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();

    let online: Vec<&DbDevice> = devices.iter().filter(|d| d.state == "device").collect();
    if online.is_empty() {
        notes.push("没有处于 device 状态的设备：检查 USB 调试 / 授权弹窗。".into());
    }

    let foreground = online.first().and_then(|d| {
        run(&adb_path, &["-s", &d.serial, "shell", "dumpsys", "window"])
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| parse_foreground(&String::from_utf8_lossy(&o.stdout)))
    });

    let package = project_path.and_then(detect_package).or_else(|| foreground.clone());
    if package.is_none() {
        notes.push("没能从 Gradle 里识别包名：可以直接填 applicationId。".into());
    }

    DbEnv {
        adb: Some(adb_path.display().to_string()),
        adb_version: version,
        devices,
        package,
        foreground,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_shared_prefs_path() {
        assert!(valid_pref_path("./shared_prefs/FlutterSharedPreferences.xml"));
        assert!(valid_pref_path("./shared_prefs/com.app_preferences.xml"));
        assert!(!valid_pref_path("./databases/app.db"));
        assert!(!valid_pref_path("./shared_prefs/../secret.xml"));
        assert!(!valid_pref_path("./shared_prefs/a.xml.exe"));
        assert!(!valid_pref_path("/data/data/com.app/shared_prefs/a.xml"));
    }

    #[test]
    fn parses_adb_devices() {
        let text = "List of devices attached\n\
                    daf3c642               device product:marble model:23049RAD8C device:marble transport_id:2\n\
                    emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 transport_id:1\n\
                    R58M1234               unauthorized usb:1-1 transport_id:3\n";
        let d = parse_devices(text);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].serial, "daf3c642");
        assert_eq!(d[0].model, "23049RAD8C");
        assert_eq!(d[0].product, "marble");
        assert_eq!(d[2].state, "unauthorized");
    }

    #[test]
    fn parses_gradle_application_id() {
        assert_eq!(
            parse_application_id("android {\n  applicationId \"com.demo.app\"\n}"),
            Some("com.demo.app".into())
        );
        assert_eq!(
            parse_application_id("android {\n  applicationId = 'com.demo.kts'\n}"),
            Some("com.demo.kts".into())
        );
        // 只有 namespace 时退而求其次
        assert_eq!(
            parse_application_id("android {\n  namespace = \"com.demo.ns\"\n}"),
            Some("com.demo.ns".into())
        );
        // applicationIdSuffix 不能被误当成主包名
        assert_eq!(
            parse_application_id(
                "android {\n  applicationIdSuffix \".debug\"\n  applicationId \"com.demo.main\"\n}"
            ),
            Some("com.demo.main".into())
        );
    }

    #[test]
    fn parses_manifest_package() {
        let m = r#"<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.old.app">"#;
        assert_eq!(parse_manifest_package(m), Some("com.old.app".into()));
    }

    #[test]
    fn parses_find_stat_output() {
        let text = "40960 ./databases/app.db\n\
                    12288 ./files/my app.sqlite\n\
                    garbage line\n";
        let f = parse_find_output(text);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].size, 40960);
        assert_eq!(f[0].path, "./databases/app.db");
        assert_eq!(f[1].path, "./files/my app.sqlite");
    }

    #[test]
    fn quotes_paths_for_device_shell() {
        assert_eq!(shell_quote("./databases/app.db"), "./databases/app.db");
        assert_eq!(
            shell_quote("./databases/my app.db"),
            "'./databases/my app.db'"
        );
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn foreground_package_parsed() {
        let text = "  mCurrentFocus=Window{2f3a8b1 u0 com.demo.app/com.demo.app.MainActivity}";
        assert_eq!(parse_foreground(text), Some("com.demo.app".into()));
    }

    #[test]
    fn rejects_writes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);")
            .unwrap();
        conn.execute("INSERT INTO t (name) VALUES ('a')", []).unwrap();

        let ok = read_page(&conn, "SELECT * FROM t", 10).unwrap();
        assert_eq!(ok.rows.len(), 1);
        assert_eq!(ok.rows[0][1].as_deref(), Some("a"));

        let err = read_page(&conn, "DELETE FROM t", 10).unwrap_err();
        assert!(err.contains("只读"), "写语句必须被拒绝：{err}");
    }

    #[test]
    fn table_page_counts_and_pages() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);\
             INSERT INTO items (name) VALUES ('a'), ('b'), ('c');",
        )
        .unwrap();

        let p = table_page(&conn, "items", 1, 1).unwrap();
        assert_eq!(p.total, Some(3));
        assert_eq!(p.rows.len(), 1);
        assert_eq!(p.rows[0][1].as_deref(), Some("b"));
    }

    #[test]
    fn blob_and_null_are_readable() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE b (x BLOB, y TEXT);\
             INSERT INTO b VALUES (x'0102', NULL);",
        )
        .unwrap();
        let p = table_page(&conn, "b", 0, 10).unwrap();
        assert_eq!(p.rows[0][0].as_deref(), Some("<BLOB 2 B>"));
        assert_eq!(p.rows[0][1], None);
    }

    #[test]
    fn validates_package_and_path() {
        assert!(valid_package("com.demo.app"));
        assert!(!valid_package("com.demo.app; rm -rf /"));
        assert!(confirm_remote_path("./databases/a.db").is_ok());
        assert!(confirm_remote_path("./databases/../../etc/passwd").is_err());
        assert!(confirm_remote_path("/data/data/x/databases/a.db").is_err());
    }

}
