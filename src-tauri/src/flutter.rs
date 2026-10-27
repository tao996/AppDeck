use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command as PCommand;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlutterInfo {
    pub ok: bool,
    pub version: Option<String>,
    pub channel: Option<String>,
    pub dart: Option<String>,
    pub executable: Option<String>,
    /// fvm | custom | path | none
    pub source: String,
    /// `.fvmrc` 里声明的 flutter 版本别名（如 "harmony" / "3.24.5"）。
    /// 即使 SDK 不在 `.fvm/flutter_sdk`，也能据此在界面上标注这是 FVM 工程。
    pub fvm_version: Option<String>,
    pub error: Option<String>,
}

#[cfg(windows)]
pub fn hide_console(cmd: &mut PCommand) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_cmd: &mut PCommand) {}

fn flutter_bin_name() -> &'static str {
    if cfg!(windows) {
        "flutter.bat"
    } else {
        "flutter"
    }
}

fn is_script(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if e == "bat" || e == "cmd"
    )
}

/// PATH 中查找 flutter，优先可执行封装（.bat/.exe/.cmd）
fn which_flutter() -> Option<PathBuf> {
    let out = if cfg!(windows) {
        let mut c = PCommand::new("where");
        c.arg("flutter");
        hide_console(&mut c);
        c.output().ok()?
    } else {
        let mut c = PCommand::new("which");
        c.arg("flutter");
        hide_console(&mut c);
        c.output().ok()?
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let candidates: Vec<PathBuf> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();

    // 优先取 .bat/.cmd/.exe，避免拿到 bash 脚本
    candidates
        .iter()
        .find(|p| is_script(p) || p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")))
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

fn normalize_custom(custom: &str) -> Option<PathBuf> {
    let p = PathBuf::from(custom.trim());
    if p.is_dir() {
        let cand = p.join("bin").join(flutter_bin_name());
        if cand.exists() {
            return Some(cand);
        }
        return None;
    }
    if p.exists() {
        return Some(p);
    }
    None
}

/// 解析项目的 Flutter 可执行文件。优先级：FVM junction > 自定义 > PATH
pub fn resolve(project: &Path, custom: Option<&str>) -> (Option<PathBuf>, String) {
    let fvm = project
        .join(".fvm")
        .join("flutter_sdk")
        .join("bin")
        .join(flutter_bin_name());
    if fvm.exists() {
        return (Some(fvm), "fvm".to_string());
    }

    if let Some(c) = custom.filter(|c| !c.trim().is_empty()) {
        if let Some(p) = normalize_custom(c) {
            return (Some(p), "custom".to_string());
        }
    }

    if let Some(p) = which_flutter() {
        return (Some(p), "path".to_string());
    }

    (None, "none".to_string())
}

fn token_after<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    let i = s.find(key)?;
    let rest = &s[i + key.len()..];
    let t = rest
        .split(|c: char| c == '•' || c == '\n' || c == '\r' || c.is_whitespace())
        .find(|t| !t.is_empty())?;
    Some(t)
}

#[cfg(windows)]
fn win_quote(a: &str) -> String {
    if a.is_empty() {
        return "\"\"".to_string();
    }
    if a.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", a.replace('"', "\"\""))
    } else {
        a.to_string()
    }
}

/// 构造调用命令。
///
/// Windows 上 `CreateProcess` 无法直接执行 `.bat` / `.cmd`，必须经 `cmd.exe`。
/// 而 Rust 的 `Command` 会把参数里的引号转义成 `\"`，cmd.exe **不认**这种转义
/// （实测会报 “不是内部或外部命令”）。因此这里用 `raw_arg` 直接拼接命令尾，
/// 采用 cmd 的标准形式：`cmd.exe /d /s /c ""C:\path\flutter.bat" --args"`。
pub fn build_command(exe: &Path, args: &[&str]) -> PCommand {
    #[cfg(windows)]
    {
        if is_script(exe) {
            use std::os::windows::process::CommandExt;
            let mut c = PCommand::new("cmd.exe");
            c.arg("/d").arg("/s").arg("/c");

            let mut line = format!("\"{}\"", exe.display());
            for a in args {
                line.push(' ');
                line.push_str(&win_quote(a));
            }
            c.raw_arg(format!("\"{line}\""));
            return c;
        }
    }

    let mut c = PCommand::new(exe);
    for a in args {
        c.arg(a);
    }
    c
}

/// 读 `.fvmrc` 里声明的 flutter 版本（如 "harmony" / "3.24.5"）。
///
/// 有些工程只用 `.fvmrc` 指定版本、并不在项目内放 `.fvm/flutter_sdk`
/// （SDK 走 FVM 全局缓存），这种情况也要能标注成 FVM 工程。
pub fn fvm_declared(project: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(project.join(".fvmrc")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("flutter")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 用**指定的** exe 与环境探测版本。
///
/// 必须与 `ctx_for` 配套使用：只走 `resolve`（PATH/FVM）看不到鸿蒙分支，
/// 会把鸿蒙工程显示成标准 flutter 的版本号。
pub fn probe(exe: &Path, env: &[(String, String)], source: &str, project: &Path) -> FlutterInfo {
    let source = source.to_string();
    let args = ["--version", "--suppress-analytics"];
    let mut cmd = build_command(exe, &args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    hide_console(&mut cmd);

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            return FlutterInfo {
                source,
                executable: Some(exe.display().to_string()),
                error: Some(format!("启动失败: {e}")),
                ..Default::default()
            }
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{stdout}\n{stderr}");

    if !output.status.success() && stdout.trim().is_empty() {
        return FlutterInfo {
            source,
            executable: Some(exe.display().to_string()),
            error: Some(format!("退出码 {:?}：{}", output.status.code(), stderr.trim())),
            ..Default::default()
        };
    }

    let version = token_after(&combined, "Flutter ").map(|s| s.to_string());
    let channel = token_after(&combined, "channel ").map(|s| s.to_string());
    let dart = token_after(&combined, "Dart ").map(|s| s.to_string());

    FlutterInfo {
        ok: version.is_some(),
        version,
        channel,
        dart,
        executable: Some(exe.display().to_string()),
        source,
        fvm_version: fvm_declared(project),
        error: None,
    }
}

/* ---------------- 统一运行上下文 ---------------- */

/// 鸿蒙工程的唯一判定：项目根有 `ohos/` 目录。
/// （`pubspec.yaml` 区分不了；`.fvmrc` 里的 "harmony" 只是 FVM 版本别名。）
pub fn is_harmony(root: &Path) -> bool {
    root.join("ohos").is_dir()
}

/// `.fvmrc` 的 `env` 块 —— FVM 的正式语义，与是否鸿蒙无关。
pub fn fvm_env(root: &Path) -> Vec<(String, String)> {
    let Ok(raw) = std::fs::read_to_string(root.join(".fvmrc")) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    v.get("env")
        .and_then(|e| e.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// 应用配置目录下的 shim 目录（与 tauri 的 app_config_dir 同一个约定）
fn shim_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
                .map(|p| PathBuf::from(p).join(crate::store::APP_ID).join("shims"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .map(|p| p.join(crate::store::APP_ID).join("shims"))
    }
}

/// 在 shim 目录生成 `flutter.bat`，内容只是转发到项目实际使用的 flutter。
///
/// 目的：不改用户的 `$PROFILE`，却让**子进程**和**内嵌终端里手敲的 flutter**
/// 都落到项目自己的分支上（鸿蒙工程尤其需要）。
///
/// 只有当解析出的 flutter 与 PATH 里的不是同一个时才生成——普通项目零影响。
pub fn ensure_shim(project_id: &str, exe: &Path) -> Option<PathBuf> {
    let on_path = which_flutter();
    let same = on_path
        .as_ref()
        .map(|p| {
            // 用规范化后的字符串比较，避免大小写/短路径差异
            let a = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
            let b = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
            a.display().to_string().eq_ignore_ascii_case(&b.display().to_string())
        })
        .unwrap_or(false);

    if same {
        return None;
    }

    let dir = shim_root()?.join(project_id);
    std::fs::create_dir_all(&dir).ok()?;

    let bat = dir.join("flutter.bat");
    let body = format!(
        "@echo off\r\nrem 由 AppDeck 生成：转发到项目使用的 flutter\r\ncall \"{}\" %*\r\n",
        exe.display()
    );

    // 内容没变就不重写，避免每次都碰磁盘
    if let Ok(old) = std::fs::read_to_string(&bat) {
        if old == body {
            return Some(dir);
        }
    }
    std::fs::write(&bat, body).ok()?;
    Some(dir)
}

/// 只算环境（不解析 exe）：鸿蒙全局 env < .fvmrc.env < 项目 env
pub fn env_for(
    state: &crate::model::State,
    project: &crate::model::Project,
) -> Vec<(String, String)> {
    let root = PathBuf::from(&project.path);
    let harmony = is_harmony(&root);

    let mut env: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

    if harmony {
        for (k, v) in &state.settings.harmony.env {
            env.insert(k.clone(), v.clone());
        }
    }

    // .fvmrc.env 是 FVM 自身语义，任何工程都该生效
    for (k, v) in fvm_env(&root) {
        env.insert(k, v);
    }

    if harmony {
        for (k, v) in &project.env {
            env.insert(k.clone(), v.clone());
        }
    }

    env.into_iter().collect()
}

/// 项目运行上下文：用哪个 flutter、带什么环境、PATH 要不要前置 shim。
pub struct Ctx {
    pub exe: PathBuf,
    /// 已按优先级合并好的环境变量
    pub env: Vec<(String, String)>,
    pub path_prepend: Option<PathBuf>,
    pub source: String,
}

impl Ctx {
    /// 环境 + 前置了 shim 目录的 PATH
    pub fn env_with_path(&self) -> Vec<(String, String)> {
        let mut out = self.env.clone();

        if let Some(dir) = &self.path_prepend {
            let sep = if cfg!(windows) { ";" } else { ":" };
            let mut p = dir.display().to_string();
            if let Some(old) = std::env::var_os("PATH") {
                p.push_str(sep);
                p.push_str(&old.to_string_lossy());
            }
            out.retain(|(k, _)| !k.eq_ignore_ascii_case("PATH"));
            out.push(("PATH".to_string(), p));
        }

        out
    }
}

/// 解析项目该用哪个 flutter（含鸿蒙分支与 FVM）
pub fn resolve_for_project(
    state: &crate::model::State,
    project: &crate::model::Project,
    cwd: &Path,
) -> Result<(PathBuf, String), String> {
    let root = PathBuf::from(&project.path);

    let custom = project
        .flutter_tool
        .as_ref()
        .and_then(|f| f.custom_path.clone())
        .or_else(|| state.settings.flutter_tool.custom_path.clone());

    // 1) 鸿蒙工程：标准 flutter 不认识 ohos/，也没有 build hap
    if is_harmony(&root) {
        if let Some(hp) = state.settings.harmony.flutter_path.as_deref() {
            let hp = hp.trim();
            if !hp.is_empty() {
                let bin = PathBuf::from(hp)
                    .join("bin")
                    .join(if cfg!(windows) { "flutter.bat" } else { "flutter" });
                if bin.is_file() {
                    return Ok((bin, "harmony".to_string()));
                }
            }
        }
    }

    // 2) FVM 的 junction 通常挂在子应用目录下，先查 cwd 再查项目根
    let mut resolved = resolve(cwd, custom.as_deref());
    if resolved.0.is_none() {
        resolved = resolve(&root, custom.as_deref());
    }

    resolved.0.ok_or_else(|| {
        "未找到 flutter 可执行文件（PATH 中没有，项目也没有 .fvm/flutter_sdk）".to_string()
    }).map(|exe| (exe, resolved.1))
}

/// 组装项目的运行上下文（exe + 环境 + shim）
pub fn ctx_for(
    state: &crate::model::State,
    project: &crate::model::Project,
    cwd: &Path,
) -> Result<Ctx, String> {
    let root = PathBuf::from(&project.path);
    let harmony = is_harmony(&root);

    let (exe, source) = resolve_for_project(state, project, cwd)?;

    // 优先级：全局鸿蒙 env < .fvmrc.env < 项目 env
    let mut env: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

    if harmony {
        for (k, v) in &state.settings.harmony.env {
            env.insert(k.clone(), v.clone());
        }
    }

    // .fvmrc.env 是 FVM 自身语义，任何工程都该生效
    for (k, v) in fvm_env(&root) {
        env.insert(k, v);
    }

    // 项目级 env 只对鸿蒙工程注入
    if harmony {
        for (k, v) in &project.env {
            env.insert(k.clone(), v.clone());
        }
    }

    let path_prepend = if harmony { ensure_shim(&project.id, &exe) } else { None };

    Ok(Ctx {
        exe,
        env: env.into_iter().collect(),
        path_prepend,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::{ctx_for, env_for, fvm_env, is_harmony, probe, resolve, resolve_for_project};
    use crate::model::{Project, State};
    use std::path::Path;

    /// 造一个带 ohos/ 的鸿蒙工程目录
    fn harmony_project(tag: &str) -> (std::path::PathBuf, Project) {
        let root = std::env::temp_dir().join(format!("fla_harmony_{tag}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("ohos")).unwrap();
        std::fs::write(root.join("pubspec.yaml"), b"name: demo\n").unwrap();

        let p = Project {
            id: format!("proj-{tag}"),
            name: "demo".into(),
            path: root.display().to_string(),
            kind: "single".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        };
        (root, p)
    }

    #[test]
    fn harmony_detected_by_ohos_dir() {
        let (root, _) = harmony_project("detect");
        assert!(is_harmony(&root));

        std::fs::create_dir_all(root.join("plain")).unwrap();
        assert!(!is_harmony(&root.join("plain")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fvm_env_reads_dot_fvmrc() {
        let (root, _) = harmony_project("fvmrc");
        std::fs::write(
            root.join(".fvmrc"),
            r#"{"flutter":"harmony","env":{"PUB_CACHE":"D:\\pub","FLUTTER_STORAGE_BASE_URL":"https://x"}}"#,
        )
        .unwrap();

        let list = fvm_env(&root);
        assert_eq!(list.len(), 2, "应解析出两个环境变量");
        assert!(list.iter().any(|(k, v)| k == "PUB_CACHE" && v == "D:\\pub"));

        // 没有 .fvmrc 时返回空
        std::fs::remove_file(root.join(".fvmrc")).unwrap();
        assert!(fvm_env(&root).is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn env_layers_follow_priority() {
        let (root, mut project) = harmony_project("layers");

        let mut state = State::default();
        state
            .settings
            .harmony
            .env
            .insert("DEVECO_SDK_HOME".into(), "GLOBAL".into());
        state
            .settings
            .harmony
            .env
            .insert("FLUTTER_GIT_URL".into(), "G".into());

        // .fvmrc 覆盖全局同名项
        std::fs::write(
            root.join(".fvmrc"),
            r#"{"flutter":"harmony","env":{"PUB_CACHE":"D:\\pub"}}"#,
        )
        .unwrap();

        // 项目级覆盖全局同名项
        project.env.insert("DEVECO_SDK_HOME".into(), "PROJECT".into());

        let env = env_for(&state, &project);
        let get = |k: &str| env.iter().find(|(ek, _)| ek == k).map(|(_, v)| v.clone());

        assert_eq!(get("DEVECO_SDK_HOME").as_deref(), Some("PROJECT"), "项目应覆盖全局");
        assert_eq!(get("FLUTTER_GIT_URL").as_deref(), Some("G"), "全局独有项应保留");
        assert_eq!(get("PUB_CACHE").as_deref(), Some("D:\\pub"), "fvmrc 应生效");

        // 非鸿蒙工程：全局与项目 env 都不注入，只有 .fvmrc
        std::fs::remove_dir_all(root.join("ohos")).unwrap();
        let env2 = env_for(&state, &project);
        assert!(
            env2.iter().all(|(k, _)| k == "PUB_CACHE"),
            "非鸿蒙工程只应保留 .fvmrc 的变量，实际：{env2:?}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn harmony_project_resolves_harmony_flutter() {
        let (root, project) = harmony_project("resolve");

        // 伪造一个鸿蒙 flutter 分支目录
        let fake = root.join("fake_flutter");
        std::fs::create_dir_all(fake.join("bin")).unwrap();
        let bin = fake.join("bin").join(if cfg!(windows) { "flutter.bat" } else { "flutter" });
        std::fs::write(&bin, b"@echo off\r\n").unwrap();

        let mut state = State::default();
        state.settings.harmony.flutter_path = Some(fake.display().to_string());

        let (exe, source) = resolve_for_project(&state, &project, &root).unwrap();
        assert_eq!(source, "harmony", "有 ohos/ 就该用鸿蒙分支");
        assert_eq!(exe, bin);

        // 拿掉 ohos/ 后应退回普通解析（不会再选鸿蒙分支）
        std::fs::remove_dir_all(root.join("ohos")).unwrap();
        let resolved = resolve_for_project(&state, &project, &root);
        if let Ok((e, s)) = resolved {
            assert_ne!(s, "harmony");
            assert_ne!(e, bin);
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ctx_carries_env_and_shim_only_for_harmony() {
        let (root, mut project) = harmony_project("ctx");

        let fake = root.join("fake_flutter");
        std::fs::create_dir_all(fake.join("bin")).unwrap();
        let bin = fake.join("bin").join(if cfg!(windows) { "flutter.bat" } else { "flutter" });
        std::fs::write(&bin, b"@echo off\r\n").unwrap();

        let mut state = State::default();
        state.settings.harmony.flutter_path = Some(fake.display().to_string());
        state.settings.harmony.env.insert("K".into(), "V".into());
        project.env.insert("P".into(), "Q".into());

        let ctx = ctx_for(&state, &project, &root).unwrap();
        assert!(ctx.env.iter().any(|(k, v)| k == "K" && v == "V"));
        assert!(ctx.env.iter().any(|(k, v)| k == "P" && v == "Q"));
        // 鸿蒙分支与 PATH 里的 flutter 不同 → 应生成 shim
        assert!(ctx.path_prepend.is_some(), "鸿蒙工程应生成 PATH shim");

        let with_path = ctx.env_with_path();
        let path = with_path
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| v.clone());
        assert!(path.is_some(), "env_with_path 应带上 PATH");
        assert!(
            path.unwrap().contains(&ctx.path_prepend.as_ref().unwrap().display().to_string()),
            "PATH 首位应是 shim 目录"
        );

        // ctx_for 会真的在配置目录生成 shim，测试要自己收尾。
        // 只删本项目那一层（path_prepend 就是 shims/<项目id>），不能删父目录——
        // 会连带删掉真实项目的 shim。
        if let Some(dir) = ctx.path_prepend.as_ref() {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真实环境探测：验证 PATH 解析 + `cmd /d /s /c` 调用 `.bat` + 版本解析。
    /// 无 Flutter 的机器上直接跳过。
    #[test]
    fn detects_flutter_from_path() {
        let (exe, source) = resolve(Path::new("."), None);
        let Some(exe) = exe else {
            eprintln!("跳过：本机未找到 flutter");
            return;
        };
        let info = probe(&exe, &[], &source, Path::new("."));

        if info.source == "none" {
            eprintln!("跳过：本机未找到 flutter");
            return;
        }

        assert!(info.ok, "探测失败：{:?}", info.error);
        let version = info.version.unwrap_or_default();
        assert!(
            version.split('.').count() >= 2,
            "版本号格式异常：{version}"
        );
        assert_eq!(info.channel.as_deref(), Some("stable"));
        assert!(info.dart.is_some(), "应解析出 Dart 版本");
    }
}










