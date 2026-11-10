//! Qt / CMake 工程识别与命令生成。
//!
//! 识别依据（任一，目录下）：
//! - `CMakeLists.txt`（CMake 工程，Qt 的 CMake 工程也有）
//! - `CMakePresets.json` / `CMakeUserPresets.json`（预设驱动的 CMake 工程）
//! - `*.pro`（qmake 工程；只用于"认得出这是 Qt 工程"，不自动生成构建命令）
//!
//! 命令生成：
//! - 每个 configurePreset → `配置 · <name>`：`cmake --preset <name>`
//! - 每个 buildPreset     → `构建 · <name>`：`cmake --build --preset <name>`
//! - 没有 presets 但目录是 CMake 工程 → 兜底
//!   `配置 (CMake)`：`cmake -S . -B build`、`构建 (CMake)`：`cmake --build build`
//! - 根目录有 `run.ps1` / `run.cmd` / `run.bat` → `运行`（执行该脚本）
//!
//! 工具链：Qt 工程通常没把 Qt Tools 加进 PATH（README 里都是先 `$env:Path = ...`）。
//! 这里会从 preset 的 `CMAKE_PREFIX_PATH` / `CMAKE_CXX_COMPILER` 推导 Qt 根目录，
//! 找到 cmake.exe / ninja.exe 就用绝对路径；Ninja 不在 PATH 时给配置命令补
//! `-DCMAKE_MAKE_PROGRAM=<ninja>`，这样双击命令就能直接配置，不用先开终端配 PATH。

use crate::model::{make_id, Command, Project};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 运行脚本的候选名，按优先级排列
pub const RUN_SCRIPTS: &[&str] = &["run.ps1", "run.cmd", "run.bat"];

#[derive(Debug, Clone)]
pub struct ConfigurePreset {
    pub name: String,
    /// 解析过 `inherits` 的 generator（如 "Ninja" / "Visual Studio 17 2022"）
    pub generator: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Presets {
    pub configure: Vec<ConfigurePreset>,
    pub build: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct QtInfo {
    pub cmake_lists: bool,
    pub cmake_presets: Option<PathBuf>,
    pub qmake_projects: Vec<String>,
    pub presets: Presets,
    pub run_script: Option<PathBuf>,
    /// 解析到的 cmake.exe（找不到就是 None，命令退回裸 `cmake`）
    pub cmake: Option<PathBuf>,
    /// 解析到的 ninja.exe
    pub ninja: Option<PathBuf>,
    /// ninja 是否本来就在 PATH 里（在的话不用往命令里塞绝对路径）
    pub ninja_on_path: bool,
    /// 导入后展示给用户的提示（不阻断导入）
    pub warnings: Vec<String>,
}

/// 目录是不是 Qt / CMake 工程（只看标志文件，不读内容）
pub fn has_markers(dir: &Path) -> bool {
    dir.join("CMakeLists.txt").is_file()
        || dir.join("CMakePresets.json").is_file()
        || dir.join("CMakeUserPresets.json").is_file()
        || has_qmake_project(dir)
}

fn has_qmake_project(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok()).any(|e| {
                e.path().is_file()
                    && e.path()
                        .extension()
                        .map(|x| x.to_string_lossy().eq_ignore_ascii_case("pro"))
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn qmake_projects(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| {
                    e.path().is_file()
                        && e.path()
                            .extension()
                            .map(|x| x.to_string_lossy().eq_ignore_ascii_case("pro"))
                            .unwrap_or(false)
                })
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn find_run_script(dir: &Path) -> Option<PathBuf> {
    RUN_SCRIPTS
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file())
}

/* ---------------- 预设解析 ---------------- */

struct RawPreset {
    name: String,
    hidden: bool,
    generator: Option<String>,
    inherits: Vec<String>,
}

fn strings_of(v: Option<&serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn raw_presets(v: &serde_json::Value, key: &str) -> Vec<RawPreset> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    let name = o.get("name")?.as_str()?.trim().to_string();
                    if name.is_empty() {
                        return None;
                    }
                    Some(RawPreset {
                        name,
                        hidden: o.get("hidden").and_then(|h| h.as_bool()) == Some(true),
                        generator: o
                            .get("generator")
                            .and_then(|g| g.as_str())
                            .map(str::trim)
                            .filter(|g| !g.is_empty())
                            .map(str::to_string),
                        inherits: strings_of(o.get("inherits")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 沿 `inherits` 往上找 generator（最多 8 层，防止坏数据成环）
fn resolve_generator(list: &[RawPreset], start: &RawPreset) -> Option<String> {
    let by_name: HashMap<&str, &RawPreset> =
        list.iter().map(|p| (p.name.as_str(), p)).collect();
    let mut cur = start;
    for _ in 0..8 {
        if let Some(g) = &cur.generator {
            return Some(g.clone());
        }
        let next = cur
            .inherits
            .iter()
            .find_map(|n| by_name.get(n.as_str()).copied());
        match next {
            Some(p) => cur = p,
            None => return None,
        }
    }
    None
}

/// 读一个 preset 文件：configure 列表（含 generator）+ build 名单 + 工具链线索
fn read_presets(path: &Path) -> Result<(Presets, Vec<PathBuf>), String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("{} 不是合法 JSON：{e}", path.display()))?;

    let raw_configure = raw_presets(&v, "configurePresets");
    let configure: Vec<ConfigurePreset> = raw_configure
        .iter()
        .filter(|p| !p.hidden)
        .map(|p| ConfigurePreset {
            name: p.name.clone(),
            generator: resolve_generator(&raw_configure, p),
        })
        .collect();

    let build: Vec<String> = raw_presets(&v, "buildPresets")
        .into_iter()
        .filter(|p| !p.hidden)
        .map(|p| p.name)
        .collect();

    // 工具链线索：CMAKE_PREFIX_PATH 与 CMAKE_CXX_COMPILER（Qt 目录通常藏在这里）
    let mut hints = Vec::new();
    let empty: Vec<serde_json::Value> = Vec::new();
    let configure_list = v
        .get("configurePresets")
        .and_then(|x| x.as_array())
        .unwrap_or(&empty);
    for p in configure_list {
        let Some(cache) = p.get("cacheVariables").and_then(|c| c.as_object()) else {
            continue;
        };
        for key in ["CMAKE_PREFIX_PATH", "CMAKE_CXX_COMPILER"] {
            let Some(val) = cache.get(key) else { continue };
            for s in strings_of(Some(val)) {
                // CMAKE_PREFIX_PATH 可能是分号分隔的多个路径
                for part in s.split(';') {
                    let part = part.trim();
                    if !part.is_empty() {
                        hints.push(PathBuf::from(part));
                    }
                }
            }
        }
    }

    Ok((Presets { configure, build }, hints))
}

fn merge_presets(mut base: Presets, more: Presets) -> Presets {
    for p in more.configure {
        if !base.configure.iter().any(|x| x.name == p.name) {
            base.configure.push(p);
        }
    }
    for name in more.build {
        if !base.build.contains(&name) {
            base.build.push(name);
        }
    }
    base
}

/* ---------------- 工具链解析 ---------------- */

fn which_exe(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        for ext in ["exe", "cmd", "bat"] {
            let cand = dir.join(format!("{name}.{ext}"));
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// 从线索路径逐级向上找 Qt 安装根（带 `Tools` 目录的那一层）
fn qt_roots(hints: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for hint in hints {
        let mut cur = hint.clone();
        // 文件路径（g++.exe）先退到父目录
        if cur.extension().is_some() {
            if let Some(p) = cur.parent() {
                cur = p.to_path_buf();
            }
        }
        for _ in 0..4 {
            if cur.join("Tools").is_dir() {
                if !out.contains(&cur) {
                    out.push(cur.clone());
                }
                break;
            }
            match cur.parent() {
                Some(p) => cur = p.to_path_buf(),
                None => break,
            }
        }
    }
    out
}

fn find_tool(roots: &[PathBuf], rels: &[&str], name: &str) -> Option<PathBuf> {
    // 1) PATH 优先（用户自己配好的环境最可信）
    if let Some(p) = which_exe(name) {
        return Some(p);
    }
    // 2) Qt 安装目录下的常见位置
    for root in roots {
        for rel in rels {
            let cand = root.join(rel);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    // 3) 常见独立安装
    for base in [
        std::env::var_os("ProgramFiles").map(PathBuf::from),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("Programs")),
    ]
    .into_iter()
    .flatten()
    {
        let cand = base.join("CMake").join("bin").join(format!("{name}.exe"));
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/* ---------------- 识别入口 ---------------- */

/// 识别一个目录。返回 Err 表示"这不是 Qt / CMake 工程"。
pub fn detect(dir: &Path) -> Result<QtInfo, String> {
    if !dir.is_dir() {
        return Err(format!("目录不存在：{}", dir.display()));
    }
    if !has_markers(dir) {
        return Err(format!(
            "{} 不是 Qt / CMake 工程（没有 CMakeLists.txt、CMakePresets.json 或 *.pro）",
            dir.display()
        ));
    }

    let mut info = QtInfo {
        cmake_lists: dir.join("CMakeLists.txt").is_file(),
        cmake_presets: None,
        qmake_projects: qmake_projects(dir),
        presets: Presets::default(),
        run_script: find_run_script(dir),
        cmake: None,
        ninja: None,
        ninja_on_path: false,
        warnings: Vec::new(),
    };

    let main = dir.join("CMakePresets.json");
    let user = dir.join("CMakeUserPresets.json");
    let mut hints: Vec<PathBuf> = Vec::new();
    let mut parsed_any = false;
    for file in [&main, &user] {
        if !file.is_file() {
            continue;
        }
        let (presets, file_hints) = read_presets(file)?;
        if file == &main {
            info.cmake_presets = Some(file.clone());
        }
        info.presets = merge_presets(info.presets.clone(), presets);
        hints.extend(file_hints);
        parsed_any = true;
    }

    let roots = qt_roots(&hints);
    info.cmake = find_tool(&roots, &["Tools/CMake_64/bin/cmake.exe", "Tools/CMake/bin/cmake.exe"], "cmake");
    info.ninja = find_tool(&roots, &["Tools/Ninja/ninja.exe"], "ninja");
    info.ninja_on_path = which_exe("ninja").is_some();

    if !parsed_any && !info.cmake_lists {
        info.warnings.push(format!(
            "这是 qmake 工程（{}）：已识别，但没有自动生成构建命令；\
             请用「添加命令」补充 qmake / make，或改用 CMake。",
            info.qmake_projects.join(" / ")
        ));
    }
    if info.cmake.is_none() && (info.cmake_lists || info.cmake_presets.is_some()) {
        info.warnings.push(
            "没找到 cmake：命令会调用 PATH 里的 cmake，\
             请把 Qt Tools 的 CMake_64\\bin（或 CMake 安装目录）加入 PATH。"
                .to_string(),
        );
    }
    let needs_ninja = info
        .presets
        .configure
        .iter()
        .any(|p| p.generator.as_deref().is_some_and(|g| g.to_ascii_lowercase().contains("ninja")));
    if needs_ninja && info.ninja.is_none() && !info.ninja_on_path {
        info.warnings.push(
            "没找到 ninja：CMake 配置会失败，请把 Qt Tools 的 Ninja 目录加入 PATH。"
                .to_string(),
        );
    }
    if info.presets.build.is_empty() && info.presets.configure.is_empty() && info.cmake_lists {
        info.warnings.push(
            "没有 CMakePresets.json：已生成默认的 `cmake -S . -B build` / `cmake --build build`。"
                .to_string(),
        );
    }
    if info.run_script.is_none() && info.cmake_lists {
        info.warnings.push(
            "根目录没有 run.ps1 / run.cmd / run.bat，所以没有生成「运行」命令。"
                .to_string(),
        );
    }

    Ok(info)
}

/* ---------------- 命令生成 ---------------- */

fn command(id_seed: &str, name: &str, program: &str, args: &[String]) -> Command {
    Command {
        id: make_id("qt", id_seed),
        name: name.to_string(),
        kind: "custom".to_string(),
        program: Some(program.to_string()),
        cwd: None,
        flutter_mode: None,
        args: args.to_vec(),
        env: Default::default(),
        tool_args: Vec::new(),
        device_id: None,
        emulator_id: None,
        build_type: None,
        source: Some("qt".to_string()),
        scope: Some("project".to_string()),
        stale: false,
        group: None,
        role: None,
        category: Some("qt".to_string()),
    }
}

fn v(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

/// 由识别结果生成命令（纯函数，便于测试）
pub fn commands_for(info: &QtInfo) -> Vec<Command> {
    let mut out = Vec::new();
    let cmake = info
        .cmake
        .as_ref()
        .map(|p| p.display().to_string().replace('/', "\\"))
        .unwrap_or_else(|| "cmake".to_string());

    for preset in &info.presets.configure {
        let mut args = v(&["--preset", &preset.name]);
        // Qt 的 Ninja 一般不在 PATH：把 ninja 的绝对路径塞进配置命令，
        // 这样双击就能配置，不需要先手动 `$env:Path = ...`
        let is_ninja = preset
            .generator
            .as_deref()
            .is_some_and(|g| g.to_ascii_lowercase().contains("ninja"));
        if is_ninja && !info.ninja_on_path {
            if let Some(ninja) = &info.ninja {
                args.push(format!(
                    "-DCMAKE_MAKE_PROGRAM={}",
                    ninja.display().to_string().replace('\\', "/")
                ));
            }
        }
        out.push(command(
            &format!("config|{}", preset.name),
            &format!("配置 · {}", preset.name),
            &cmake,
            &args,
        ));
    }
    for name in &info.presets.build {
        out.push(command(
            &format!("build|{name}"),
            &format!("构建 · {name}"),
            &cmake,
            &v(&["--build", "--preset", name]),
        ));
    }

    // 没有 buildPresets 时给一条兜底构建（配置走 `-B build`，构建目录也对得上）
    if info.presets.build.is_empty() && (info.cmake_lists || info.cmake_presets.is_some()) {
        if info.presets.configure.is_empty() && info.cmake_lists {
            out.push(command(
                "config|default",
                "配置 (CMake)",
                &cmake,
                &v(&["-S", ".", "-B", "build"]),
            ));
        }
        out.push(command("build|default", "构建 (CMake)", &cmake, &v(&["--build", "build"])));
    }

    if let Some(script) = &info.run_script {
        let mut cmd = command("run", "运行", &script.display().to_string(), &[]);
        // 运行是长时间驻留的进程（Qt GUI）：独立 run 会话，
        // 停止 = 结束进程树 → 退出事件能把状态准确标成「已停止」。
        cmd.kind = "run".to_string();
        out.push(cmd);
    }

    out
}

#[derive(Debug, Default, Clone)]
pub struct MergeOutcome {
    pub added: Vec<String>,
    pub kept: Vec<String>,
    pub stale: Vec<String>,
}

/// 合并进项目：已有命令只同步 program/args（名字可能被用户改过，不覆盖），
/// 本次没再生成的 qt 命令标记 stale（保留，不删除）。
pub fn merge_into(project: &mut Project, fresh: Vec<Command>) -> MergeOutcome {
    let ids: Vec<String> = fresh.iter().map(|c| c.id.clone()).collect();
    let mut outcome = MergeOutcome::default();

    for c in fresh {
        match project.commands.iter_mut().find(|x| x.id == c.id) {
            Some(existing) => {
                existing.program = c.program.clone();
                existing.args = c.args.clone();
                // qt 命令的执行方式也由导入器定义（例如「运行」是独立 run 会话），
                // 一起同步，否则升级后老项目还按 custom 在共享终端里跑
                existing.kind = c.kind.clone();
                // 执行方式还看 source（qt → 外部程序，直接跑 run.ps1）；前端「编辑命令」
                // 曾把它覆盖成 manual，让「运行」掉进 flutter run 分支，重新导入时修回来
                existing.source = c.source.clone();
                existing.stale = false;
                if existing.name.trim().is_empty() {
                    existing.name = c.name.clone();
                }
                outcome.kept.push(existing.name.clone());
            }
            None => {
                outcome.added.push(c.name.clone());
                project.commands.push(c);
            }
        }
    }

    for cmd in project.commands.iter_mut() {
        if cmd.source.as_deref() != Some("qt") {
            continue;
        }
        if !ids.contains(&cmd.id) {
            if !cmd.stale {
                outcome.stale.push(cmd.name.clone());
            }
            cmd.stale = true;
        }
    }

    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fla_qt_{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(cmds: &[Command]) -> Vec<&str> {
        cmds.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn detects_cmake_project_with_presets_and_run_script() {
        let dir = temp_dir("presets");
        fs::write(dir.join("CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)").unwrap();
        fs::write(
            dir.join("CMakePresets.json"),
            r#"{
              "version": 6,
              "configurePresets": [
                { "name": "base", "hidden": true, "generator": "Ninja" },
                { "name": "mingw", "inherits": "base" }
              ],
              "buildPresets": [{ "name": "mingw", "configurePreset": "mingw" }]
            }"#,
        )
        .unwrap();
        fs::write(dir.join("run.ps1"), "echo hi").unwrap();

        let info = detect(&dir).expect("应能识别");
        assert!(info.cmake_lists);
        assert_eq!(info.presets.configure.len(), 1);
        assert_eq!(info.presets.configure[0].name, "mingw");
        assert_eq!(info.presets.configure[0].generator.as_deref(), Some("Ninja"));
        assert_eq!(info.presets.build, vec!["mingw"]);
        assert!(info.run_script.as_ref().unwrap().ends_with("run.ps1"));

        let cmds = commands_for(&info);
        assert_eq!(names(&cmds), vec!["配置 · mingw", "构建 · mingw", "运行"]);
        assert_eq!(cmds[1].args, vec!["--build", "--preset", "mingw"]);
        assert_eq!(cmds[0].kind, "custom", "配置在项目终端里执行");
        assert_eq!(cmds[2].kind, "run", "运行是独立 run 会话，停止能准确标红");
        assert!(cmds.iter().all(|c| c.source.as_deref() == Some("qt")));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn injects_absolute_ninja_for_ninja_presets_when_not_on_path() {
        let info = QtInfo {
            cmake_lists: true,
            cmake: Some(PathBuf::from(r"D:\Qt\Tools\CMake_64\bin\cmake.exe")),
            ninja: Some(PathBuf::from(r"D:\Qt\Tools\Ninja\ninja.exe")),
            ninja_on_path: false,
            presets: Presets {
                configure: vec![ConfigurePreset {
                    name: "mingw".into(),
                    generator: Some("Ninja".into()),
                }],
                build: vec![],
            },
            ..Default::default()
        };
        let cmds = commands_for(&info);
        let configure = cmds.iter().find(|c| c.name == "配置 · mingw").unwrap();
        assert_eq!(
            configure.program.as_deref(),
            Some(r"D:\Qt\Tools\CMake_64\bin\cmake.exe")
        );
        assert_eq!(
            configure.args,
            vec!["--preset", "mingw", "-DCMAKE_MAKE_PROGRAM=D:/Qt/Tools/Ninja/ninja.exe"]
        );
    }

    #[test]
    fn falls_back_to_default_cmake_commands_without_presets() {
        let dir = temp_dir("fallback");
        fs::write(dir.join("CMakeLists.txt"), "project(x)").unwrap();

        let info = detect(&dir).expect("应能识别");
        assert!(info.presets.configure.is_empty());
        let cmds = commands_for(&info);
        assert_eq!(names(&cmds), vec!["配置 (CMake)", "构建 (CMake)"]);
        assert_eq!(cmds[0].args, vec!["-S", ".", "-B", "build"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn qmake_only_is_recognized_with_warning() {
        let dir = temp_dir("qmake");
        fs::write(dir.join("app.pro"), "QT += core").unwrap();

        let info = detect(&dir).expect("应能识别 qmake 工程");
        assert_eq!(info.qmake_projects, vec!["app.pro"]);
        assert!(commands_for(&info).is_empty());
        assert!(info.warnings.iter().any(|w| w.contains("qmake")));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_presets_are_merged() {
        let dir = temp_dir("userpresets");
        fs::write(dir.join("CMakeLists.txt"), "project(x)").unwrap();
        fs::write(
            dir.join("CMakePresets.json"),
            r#"{"configurePresets":[{"name":"mingw","generator":"Ninja"}]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("CMakeUserPresets.json"),
            r#"{"configurePresets":[{"name":"mingw"},{"name":"debug","generator":"Ninja"}]}"#,
        )
        .unwrap();

        let info = detect(&dir).expect("应能识别");
        let names: Vec<&str> = info.presets.configure.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["mingw", "debug"]);
        // 主文件里的 generator 应保留
        assert_eq!(
            info.presets.configure[0].generator.as_deref(),
            Some("Ninja")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dir_is_error() {
        let err = detect(Path::new("D:/definitely/not/here")).unwrap_err();
        assert!(err.contains("目录不存在"));
    }

    #[test]
    fn merge_updates_existing_and_marks_removed_stale() {
        let dir = temp_dir("merge");
        fs::write(dir.join("CMakeLists.txt"), "project(x)").unwrap();

        let mut info = QtInfo {
            cmake_lists: true,
            ..Default::default()
        };
        info.presets.configure = vec![ConfigurePreset {
            name: "mingw".into(),
            generator: Some("Ninja".into()),
        }];
        info.presets.build = vec!["mingw".into()];
        info.run_script = Some(dir.join("run.ps1"));
        let fresh = commands_for(&info);

        let mut project = Project {
            id: "p".into(),
            name: "p".into(),
            path: dir.display().to_string(),
            kind: "workspace".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        };

        let first = merge_into(&mut project, fresh);
        assert_eq!(first.added.len(), 3);
        assert!(first.stale.is_empty());

        // 预设改名：新增配置命令，没再生成的运行命令标记 stale
        let renamed = commands_for(&QtInfo {
            presets: Presets {
                configure: vec![
                    ConfigurePreset {
                        name: "mingw".into(),
                        generator: Some("Ninja".into()),
                    },
                    ConfigurePreset {
                        name: "clang".into(),
                        generator: Some("Ninja".into()),
                    },
                ],
                build: vec!["mingw".into()],
            },
            cmake_lists: true,
            run_script: None,
            ..Default::default()
        });
        let second = merge_into(&mut project, renamed);
        assert_eq!(second.added, vec!["配置 · clang"]);
        assert!(second.stale.iter().any(|n| n == "运行"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_restores_qt_source_after_edit() {
        // 前端「编辑命令」改名字时曾把 source 写成 manual，导致「运行」
        // 被后端当成 flutter run（No pubspec.yaml）。重新读取 Qt / CMake 要能修回来。
        let dir = temp_dir("merge-source");
        let mut info = QtInfo {
            cmake_lists: true,
            ..Default::default()
        };
        info.presets.configure = vec![ConfigurePreset {
            name: "mingw".into(),
            generator: None,
        }];
        info.run_script = Some(dir.join("run.ps1"));

        let mut project = Project {
            id: "p".into(),
            name: "p".into(),
            path: dir.display().to_string(),
            kind: "workspace".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        };
        merge_into(&mut project, commands_for(&info));

        let run = project.commands.iter_mut().find(|c| c.name == "运行").unwrap();
        assert_eq!(run.kind, "run", "运行仍是独立 run 会话");
        assert_eq!(run.source.as_deref(), Some("qt"), "Qt 导入带 qt 归属");
        // 模拟老版本保存后的样子：名字改了、source 丢了
        run.name = "运行 ps1.run".into();
        run.source = Some("manual".into());

        merge_into(&mut project, commands_for(&info));
        let run = project
            .commands
            .iter()
            .find(|c| c.name == "运行 ps1.run")
            .unwrap();
        assert_eq!(run.source.as_deref(), Some("qt"), "重新导入应恢复 qt 归属");
        assert_eq!(run.kind, "run");

        let _ = fs::remove_dir_all(&dir);
    }
}
