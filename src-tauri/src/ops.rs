//! 业务操作：与 Tauri 解耦，便于直接单元测试。

use crate::launch::{self, ImportOutcome};
use crate::model::{instantiate_template, make_id, Command, Project, State};
use std::path::PathBuf;

/// 统一路径写法：分隔符归一为 `\`，去掉尾部斜杠
pub fn normalize(p: &str) -> String {
    p.trim().trim_end_matches(['\\', '/']).replace('/', "\\")
}

/// 添加项目。校验：
/// - 目录必须存在
/// - 不能重复添加
/// - 必须是 Flutter 应用（含 pubspec.yaml）或工作区（含 .vscode/launch.json）
pub fn add_project_to(state: &mut State, raw_path: &str) -> Result<Project, String> {
    let p = normalize(raw_path);
    if p.is_empty() {
        return Err("路径为空".to_string());
    }

    let pb = PathBuf::from(&p);
    if !pb.is_dir() {
        return Err(format!("目录不存在：{p}"));
    }
    if state
        .projects
        .iter()
        .any(|x| normalize(&x.path).eq_ignore_ascii_case(&p))
    {
        return Err("该项目已在列表中".to_string());
    }

    let has_pubspec = pb.join("pubspec.yaml").exists();
    let has_launch = pb.join(".vscode").join("launch.json").exists();
    if !has_pubspec && !has_launch {
        return Err(
            "不是 Flutter 项目（无 pubspec.yaml），也不是工作区（无 .vscode/launch.json）"
                .to_string(),
        );
    }

    let name = pb
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| p.clone());

    let id = make_id("proj", &p.to_lowercase());

    // 单应用项目：只套用**项目作用域**的模板；全局模板（如 Pub Get）不自动加入项目
    let commands: Vec<Command> = if has_pubspec {
        state
            .command_templates
            .iter()
            .filter(|t| t.scope.as_deref() != Some("global"))
            .map(|t| instantiate_template(t, &id))
            .collect()
    } else {
        Vec::new()
    };

    let project = Project {
        id,
        name,
        path: p,
        kind: if has_pubspec {
            "single".to_string()
        } else {
            "workspace".to_string()
        },
        flutter_tool: None,
        commands,
        env: Default::default(),
    };

    state.projects.push(project.clone());
    Ok(project)
}

/// 从全局模板库导入选中的模板到项目（按「名称 + 类型」去重）
pub fn import_templates(
    state: &mut State,
    project_id: &str,
    template_ids: &[String],
) -> Result<usize, String> {
    let picked: Vec<Command> = state
        .command_templates
        .iter()
        .filter(|t| template_ids.iter().any(|id| id == &t.id))
        .cloned()
        .collect();

    if picked.is_empty() {
        return Ok(0);
    }

    let project = state
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let mut added = 0usize;
    for tpl in picked {
        let inst = instantiate_template(&tpl, project_id);
        if project
            .commands
            .iter()
            .any(|c| c.name == inst.name && c.kind == inst.kind)
        {
            continue;
        }
        project.commands.push(inst);
        added += 1;
    }

    Ok(added)
}

/// 把用户给的路径归一成工作区根：
/// 支持直接选 `launch.json`、选 `.vscode` 目录、或选工作区目录本身。
pub fn resolve_workspace_root(raw: &str) -> Result<String, String> {
    let p = PathBuf::from(raw.trim());
    let mut dir = if p.is_file() {
        p.parent()
            .map(|x| x.to_path_buf())
            .ok_or_else(|| "路径无效".to_string())?
    } else {
        p
    };

    if dir
        .file_name()
        .map(|n| n.eq_ignore_ascii_case(".vscode"))
        .unwrap_or(false)
    {
        dir = dir
            .parent()
            .map(|x| x.to_path_buf())
            .ok_or_else(|| "路径无效".to_string())?;
    }

    if !dir.is_dir() {
        return Err(format!("目录不存在：{}", dir.display()));
    }

    Ok(dir.display().to_string())
}

/// 按 `.vscode/launch.json` 导入：
///
/// - 目录是 Flutter 项目（有 `pubspec.yaml`）→ 作为**普通项目**导入，
///   命令作为该项目的自定义命令
/// - 否则 → 作为**命令集**导入（旧称 workspace）
///
/// 已存在的项目只刷新命令，不重复添加。
/// 返回 (项目, 导入结果, 是否新建)
pub fn import_launch_from_path(
    state: &mut State,
    raw: &str,
) -> Result<(Project, ImportOutcome, bool), String> {
    let root = resolve_workspace_root(raw)?;

    // **先校验再改状态**：否则会在 state 里留下一个"加了一半"的项目，
    // 调用方虽然不会落盘，但函数语义上仍是脏的
    let launch = PathBuf::from(&root).join(".vscode").join("launch.json");
    if !launch.is_file() {
        let has_pubspec = PathBuf::from(&root).join("pubspec.yaml").is_file();
        return Err(if has_pubspec {
            format!(
                "{} 是 Flutter 项目，但没有 .vscode/launch.json。\n\
                 用「＋ 添加 Flutter 项目」即可，它的命令走右键「平台 → 动作」。",
                root
            )
        } else {
            format!("{root} 下没有 .vscode/launch.json")
        });
    }

    let existing = state
        .projects
        .iter()
        .find(|p| normalize(&p.path).eq_ignore_ascii_case(&normalize(&root)))
        .map(|p| p.id.clone());

    let (project, created) = match existing {
        Some(id) => {
            let p = state
                .projects
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .ok_or_else(|| "项目不存在".to_string())?;
            (p, false)
        }
        None => (add_project_to(state, &root)?, true),
    };

    let outcome = import_into(state, &project.id)?;

    let updated = state
        .projects
        .iter()
        .find(|p| p.id == project.id)
        .cloned()
        .unwrap_or(project);

    Ok((updated, outcome, created))
}

/// 导入项目的 `.vscode/launch.json`，覆盖该项目已有命令。
pub fn import_into(state: &mut State, project_id: &str) -> Result<ImportOutcome, String> {
    let idx = state
        .projects
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let path = state.projects[idx].path.clone();
    let outcome = launch::import(PathBuf::from(&path).as_path())?;

    state.projects[idx].commands = outcome.commands.clone();
    Ok(outcome)
}

/// 一次会话的执行计划：最终要执行的程序、参数、工作目录、环境变量
#[derive(Debug, Clone)]
pub struct Plan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub title: String,
    pub device: String,
    pub env: Vec<(String, String)>,
}

fn is_batch(path: &str) -> bool {
    matches!(
        std::path::Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .as_deref(),
        Some("bat") | Some("cmd")
    )
}

/// `.bat` / `.cmd` 不能直接 CreateProcess，用 `cmd.exe /d /c` 包一层。
/// **不能加 `/s`**：实测会剥掉引号，含空格路径会被截断。
fn wrap_batch(program: String, args: Vec<String>) -> (String, Vec<String>) {
    if !is_batch(&program) {
        return (program, args);
    }
    let mut a = vec!["/d".to_string(), "/c".to_string(), program];
    a.extend(args);
    ("cmd.exe".to_string(), a)
}

pub fn build_plan(
    state: &State,
    project_id: &str,
    command_id: &str,
    device_override: Option<&str>,
) -> Result<Plan, String> {
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
    build_plan_for(state, project, command, device_override)
}

/// 把「项目 + 命令」翻译成可直接 spawn 的程序与参数。
///
/// - `run` / `build`：调用 flutter，自动补 `run -d -t` 或 `build <type> --release`
/// - `custom`：用户直接给程序与参数；`program` 支持 `%FLUTTER%` 占位符
/// - 工作目录 = 项目根 + 命令的 `cwd`
/// `flutter run` 的参数（供 build_plan_for 与「预填命令」共用，避免两处走偏）
fn run_args(command: &Command, device: Option<&str>) -> Vec<String> {
    let mut a = vec!["run".to_string()];
    if let Some(d) = device {
        a.push("-d".to_string());
        a.push(d.to_string());
    }
    if let Some(p) = command.program.as_ref().filter(|p| !p.is_empty()) {
        a.push("-t".to_string());
        a.push(p.clone());
    }
    a.extend(command.tool_args.iter().cloned());
    a.extend(command.args.iter().cloned());
    a
}

/// 「预填」计划：开一个**普通交互终端**，命令只输入到提示符、不回车。
/// 用户按 Enter 才真正执行——避免"点重跑就默默跑起来"。
pub fn prefill_plan(
    state: &State,
    project: &Project,
    command: &Command,
) -> Result<(Plan, String), String> {
    let cwd = match &command.cwd {
        Some(c) if !c.trim().is_empty() => PathBuf::from(&project.path).join(c),
        _ => PathBuf::from(&project.path),
    };
    if !cwd.is_dir() {
        return Err(format!("工作目录不存在：{}", cwd.display()));
    }

    let ctx = crate::flutter::ctx_for(state, project, &cwd)?;
    let term = crate::terminal::resolve(state.settings.terminal.path.as_deref());
    let line = crate::terminal::command_line(
        &term,
        &ctx.exe.display().to_string(),
        &run_args(command, command.device_id.as_deref()),
    );

    Ok((
        Plan {
            program: term.display().to_string(),
            args: crate::terminal::args_for(&term),
            cwd,
            title: format!("{} · {}", project.name, command.name),
            device: "—".to_string(),
            env: ctx.env_with_path(),
        },
        line,
    ))
}

pub fn build_plan_for(
    state: &State,
    project: &Project,
    command: &Command,
    device_override: Option<&str>,
) -> Result<Plan, String> {
    let project_root = PathBuf::from(&project.path);
    let cwd = match &command.cwd {
        Some(c) if !c.trim().is_empty() => project_root.join(c),
        _ => project_root.clone(),
    };
    if !cwd.is_dir() {
        return Err(format!("工作目录不存在：{}", cwd.display()));
    }

    // 设备优先级：本次调用显式指定 > 命令自身配置
    let resolved_device = device_override
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| command.device_id.clone().filter(|s| !s.is_empty()));

    // 项目运行上下文：鸿蒙工程会换成鸿蒙 flutter、注入 env、前置 shim。
    // 允许 None：纯自定义命令（如 git）不依赖 flutter，不该因为它缺失就跑不了。
    let ctx = crate::flutter::ctx_for(state, project, &cwd).ok();

    // 环境优先级：项目层（含鸿蒙/ fvmrc）< 命令自身
    let mut env: Vec<(String, String)> = match &ctx {
        Some(c) => c.env_with_path(),
        None => crate::flutter::env_for(state, project),
    };
    for (k, v) in &command.env {
        if let Some(pos) = env.iter().position(|(ek, _)| ek == k) {
            env[pos].1 = v.clone();
        } else {
            env.push((k.clone(), v.clone()));
        }
    }

    // 需要 flutter 的分支：没有上下文就直接报错
    let need_flutter = || -> Result<PathBuf, String> {
        match &ctx {
            Some(c) => Ok(c.exe.clone()),
            None => Err(
                "未找到 flutter 可执行文件（PATH 中没有，项目也没有 .fvm/flutter_sdk）"
                    .to_string(),
            ),
        }
    };

    let (program, args) = match command.kind.as_str() {
        "custom" => {
            let raw = command.program.as_deref().unwrap_or("").trim();
            if raw.is_empty() {
                return Err("自定义命令必须填写程序（可执行文件路径，或 %FLUTTER%）".to_string());
            }

            let prog = if raw.eq_ignore_ascii_case("%FLUTTER%") {
                need_flutter()?.display().to_string()
            } else {
                raw.to_string()
            };

            wrap_batch(prog, command.args.clone())
        }
        kind => {
            let exe = need_flutter()?;
            let mut flutter_args: Vec<String> = Vec::new();

            if kind == "build" {
                flutter_args.push("build".to_string());
                flutter_args.push(
                    command
                        .build_type
                        .clone()
                        .unwrap_or_else(|| "apk".to_string()),
                );
                let has_mode = command
                    .args
                    .iter()
                    .any(|a| a == "--release" || a == "--profile" || a == "--debug");
                if !has_mode {
                    flutter_args.push("--release".to_string());
                }
            } else {
                flutter_args.push("run".to_string());
                if let Some(d) = resolved_device.as_ref() {
                    flutter_args.push("-d".to_string());
                    flutter_args.push(d.clone());
                }
                if let Some(p) = command.program.as_ref().filter(|p| !p.is_empty()) {
                    flutter_args.push("-t".to_string());
                    flutter_args.push(p.clone());
                }
            }

            flutter_args.extend(command.tool_args.iter().cloned());
            flutter_args.extend(command.args.iter().cloned());

            if kind == "run" {
                // run 走「shell + 命令 + 哨兵」：命令结束后终端仍在（可以接着用），
                // 而 flutter run 独占终端，所以要靠哨兵判定它什么时候退出。
                let term = crate::terminal::resolve(state.settings.terminal.path.as_deref());
                let line =
                    crate::terminal::command_line(&term, &exe.display().to_string(), &flutter_args);
                crate::terminal::wrap_run(&term, &line)
            } else {
                wrap_batch(exe.display().to_string(), flutter_args)
            }
        }
    };

    Ok(Plan {
        program,
        args,
        cwd,
        title: format!("{}:{}", project.name, command.name),
        device: resolved_device.unwrap_or_else(|| "自动".to_string()),
        env,
    })
}


/// 供体检修复等场景使用：用该项目解析出的 flutter 执行给定参数。
/// 参数由调用方**白名单**产生，不接受 doctor 输出里的任意字符串。
/// 「在终端中打开」：起一个交互终端，**注入项目环境**（鸿蒙工程尤其需要）。
///
/// 这不是为了跑 flutter 命令——而是让人能在正确的环境里手敲 `flutter --version`、
/// `flutter doctor` 这类需要现场看输出的操作。
pub fn terminal_plan(
    state: &State,
    project: &Project,
    rows: u16,
    cols: u16,
) -> Result<Plan, String> {
    let _ = (rows, cols);

    let cwd = PathBuf::from(&project.path);
    if !cwd.is_dir() {
        return Err(format!("工作目录不存在：{}", cwd.display()));
    }

    let term = crate::terminal::resolve(state.settings.terminal.path.as_deref());
    let args = crate::terminal::args_for(&term);

    // 环境：鸿蒙工程带上全局/项目变量与 PATH shim；普通项目只带 .fvmrc
    let env = crate::flutter::ctx_for(state, project, &cwd)
        .map(|c| c.env_with_path())
        .unwrap_or_else(|_| crate::flutter::env_for(state, project));

    let name = term
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "终端".to_string());

    Ok(Plan {
        program: term.display().to_string(),
        args,
        cwd,
        title: format!("{} · {name}", project.name),
        device: "—".to_string(),
        env,
    })
}

pub fn flutter_adhoc_plan(
    state: &State,
    project: &Project,
    args: Vec<String>,
    title: String,
) -> Result<Plan, String> {
    let cwd = PathBuf::from(&project.path);
    if !cwd.is_dir() {
        return Err(format!("工作目录不存在：{}", cwd.display()));
    }

    // 平台动作一律走 flutter：必须拿到上下文（鸿蒙工程会换成鸿蒙分支并注入 env）
    let ctx = crate::flutter::ctx_for(state, project, &cwd)?;
    let (program, args) = wrap_batch(ctx.exe.display().to_string(), args);

    Ok(Plan {
        program,
        args,
        cwd,
        title,
        device: "—".to_string(),
        env: ctx.env_with_path(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::State;
    use crate::store;
    use std::fs;

    fn fixture() -> Option<&'static str> {
        let ws = r"D:\demo\code\flutter\library";
        if std::path::Path::new(ws)
            .join(".vscode")
            .join("launch.json")
            .exists()
        {
            Some(ws)
        } else {
            None
        }
    }

    #[test]
    fn rejects_non_project_directory() {
        let mut state = State::default();
        let err = add_project_to(&mut state, r"C:\Windows").unwrap_err();
        assert!(err.contains("pubspec.yaml"), "错误信息应说明原因：{err}");
        assert!(state.projects.is_empty());
    }

    #[test]
    fn rejects_missing_directory() {
        let mut state = State::default();
        assert!(add_project_to(&mut state, r"D:\__nope__\not_here").is_err());
    }

    /// 端到端：添加 → 导入 → 落盘 → 重新读取，全链路校验。
    #[test]
    fn add_import_persist_roundtrip() {
        let Some(ws) = fixture() else {
            eprintln!("跳过：测试素材不存在");
            return;
        };

        let tmp = std::env::temp_dir().join("fla_m1_state.json");
        let _ = fs::remove_file(&tmp);

        let mut state = State::default();

        // 1. 添加工作区
        let project = add_project_to(&mut state, ws).expect("添加应成功");
        assert_eq!(project.kind, "workspace", "无 pubspec.yaml 应判定为工作区");
        assert_eq!(project.name, "library");
        assert_eq!(state.projects.len(), 1);

        // 2. 重复添加应被拒绝
        assert!(add_project_to(&mut state, ws).is_err(), "重复添加应失败");

        // 3. 导入命令
        let outcome = import_into(&mut state, &project.id).expect("导入应成功");
        assert!(outcome.imported >= 9, "应导入至少 9 条");
        assert!(outcome.warnings.is_empty(), "不该有告警：{:?}", outcome.warnings);
        assert_eq!(state.projects[0].commands.len(), outcome.imported);

        // 4. 落盘 + 重新读取
        store::save_to(&tmp, &state).expect("保存应成功");
        let reloaded = store::load_from(&tmp);
        assert_eq!(reloaded.schema_version, crate::model::SCHEMA_VERSION);
        assert_eq!(reloaded.projects.len(), 1);
        assert_eq!(reloaded.projects[0].commands.len(), outcome.imported);
        assert_eq!(reloaded.projects[0].id, project.id);
        // 字段往返不丢失
        let jbook_cn = reloaded.projects[0]
            .commands
            .iter()
            .find(|c| c.name == "jbook (国内 APK)")
            .expect("应保留 jbook (国内 APK)");
        assert_eq!(jbook_cn.flutter_mode.as_deref(), Some("release"));
        assert_eq!(jbook_cn.args, vec!["--dart-define=APP_CHANNEL=cn"]);
        assert_eq!(jbook_cn.cwd.as_deref(), Some(r"projects\jbook"));

        println!("STATE_PATH={}", tmp.display());
    }

    #[test]
    fn terminal_plan_injects_harmony_env_and_shim() {
        let root = std::env::temp_dir().join("fla_term_plan");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("ohos")).unwrap();

        // 伪造鸿蒙 flutter 分支
        let fake = root.join("fake_flutter");
        std::fs::create_dir_all(fake.join("bin")).unwrap();
        let bin = fake
            .join("bin")
            .join(if cfg!(windows) { "flutter.bat" } else { "flutter" });
        std::fs::write(&bin, b"@echo off\r\n").unwrap();

        let mut state = State::default();
        state.settings.harmony.flutter_path = Some(fake.display().to_string());
        state
            .settings
            .harmony
            .env
            .insert("DEVECO_SDK_HOME".into(), "D:/sdk".into());

        let project = Project {
            id: "proj-term".into(),
            name: "demo".into(),
            path: root.display().to_string(),
            kind: "single".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        };

        let plan = terminal_plan(&state, &project, 30, 100).unwrap();

        assert_eq!(plan.cwd, root);
        assert!(
            plan.env
                .iter()
                .any(|(k, v)| k == "DEVECO_SDK_HOME" && v == "D:/sdk"),
            "终端应注入鸿蒙环境变量：{:?}",
            plan.env
        );

        let path = plan
            .env
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| v.clone());
        assert!(path.is_some(), "鸿蒙工程的终端应前置 PATH shim");
        assert!(
            path.unwrap().contains("com.flutterlauncher.app"),
            "PATH 应包含 shim 目录"
        );

        // 收尾：shim 与临时目录
        if let Some(dir) = plan
            .env
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| v.split(';').next().unwrap_or("").to_string())
        {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_plan_uses_command_cwd_and_cmd_wrapper() {
        let Some(ws) = fixture() else {
            eprintln!("跳过：测试素材不存在");
            return;
        };

        let mut state = State::default();
        let project = add_project_to(&mut state, ws).unwrap();
        let outcome = import_into(&mut state, &project.id).unwrap();

        let cmd = outcome
            .commands
            .iter()
            .find(|c| c.name == "jbook (国内 APK)")
            .unwrap();
        let plan = build_plan(&state, &project.id, &cmd.id, None).unwrap();

        // 工作目录 = 项目根 + 命令 cwd
        assert!(
            plan.cwd.ends_with(r"projects\jbook"),
            "实际 cwd: {}",
            plan.cwd.display()
        );
        // run 走 shell 模式：program 是终端，命令作为文本交给 -Command，
        // 并附带哨兵用于判定 flutter run 何时退出
        let joined = plan.args.join(" ");
        assert!(
            ["pwsh.exe", "powershell.exe", "cmd.exe"]
                .iter()
                .any(|e| plan.program.to_ascii_lowercase().ends_with(e)),
            "run 应由终端承载，实际: {}",
            plan.program
        );
        assert!(
            joined.contains("-NoExit") || joined.contains("/k"),
            "shell 应保持交互，实际: {joined}"
        );
        assert!(
            joined.contains(crate::terminal::RUN_END_MARKER),
            "应带退出哨兵，实际: {joined}"
        );
        assert!(
            joined.to_ascii_lowercase().contains("flutter"),
            "命令行里应有 flutter，实际: {joined}"
        );
        assert!(joined.contains("run"), "应是 run 子命令，实际: {joined}");
        assert!(!joined.contains("--release"), "run 不该带 --release");
        assert!(
            joined.contains("--dart-define=APP_CHANNEL=cn"),
            "应保留自定义 args，实际: {joined}"
        );
        assert_eq!(plan.device, "自动");
    }

    #[test]
    fn build_plan_rejects_unknown_command() {
        let mut state = State::default();
        let Some(ws) = fixture() else { return };
        let project = add_project_to(&mut state, ws).unwrap();
        assert!(build_plan(&state, &project.id, "nope", None).is_err());
        assert!(build_plan(&state, "nope", "nope", None).is_err());
    }

    #[test]
    fn imports_templates_into_project() {
        let Some(ws) = fixture() else {
            eprintln!("跳过：测试素材不存在");
            return;
        };

        let mut state = State::default();
        assert!(!state.command_templates.is_empty(), "默认模板库不应为空");

        // 工作区项目不会自动套模板
        let project = add_project_to(&mut state, ws).unwrap();
        assert!(project.commands.is_empty());

        let ids: Vec<String> = state
            .command_templates
            .iter()
            .map(|t| t.id.clone())
            .collect();

        let added = import_templates(&mut state, &project.id, &ids).unwrap();
        assert_eq!(added, ids.len(), "应导入全部选中模板");

        // 幂等：重复导入不新增
        let again = import_templates(&mut state, &project.id, &ids).unwrap();
        assert_eq!(again, 0, "重复导入应被去重");

        // 只导入部分
        let one = vec![ids[0].clone()];
        let partial = import_templates(&mut state, &project.id, &one).unwrap();
        assert_eq!(partial, 0, "已存在的模板仍应去重");
    }

    #[test]
    fn single_project_does_not_auto_apply_global_templates() {
        let path = r"D:\demo\code\flutter\library\projects\today";
        if !std::path::Path::new(path).join("pubspec.yaml").exists() {
            eprintln!("跳过：单应用测试素材不存在");
            return;
        }

        let mut state = State::default();
        let project = add_project_to(&mut state, path).unwrap();

        assert_eq!(project.kind, "single");
        // v5：内置的 Debug / Build * 模板已退役，只剩全局模板（Pub Get），
        // 而全局模板不进项目 → 新项目命令为空，能力改由「平台 → 动作」派生
        assert!(
            state
                .command_templates
                .iter()
                .all(|t| t.scope.as_deref() == Some("global")),
            "默认模板库现在只应包含全局模板"
        );
        assert!(
            project.commands.is_empty(),
            "不应再把全局模板塞进项目：{:?}",
            project.commands.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn custom_command_resolves_flutter_and_carries_env() {
        let Some(ws) = fixture() else {
            eprintln!("跳过：测试素材不存在");
            return;
        };

        let mut state = State::default();
        let project = add_project_to(&mut state, ws).unwrap();

        let mut cmd = Command {
            id: "cmd-custom-test".into(),
            name: "Pub Get".into(),
            kind: "custom".into(),
            program: Some("%FLUTTER%".into()),
            cwd: None,
            flutter_mode: None,
            args: vec!["pub".into(), "get".into()],
            env: std::collections::HashMap::from([(
                "FLUTTER_SUPPRESS_ANALYTICS".to_string(),
                "true".to_string(),
            )]),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("manual".into()),
            scope: Some("global".into()),
        };

        let plan = build_plan_for(&state, &project, &cmd, None).unwrap();

        assert!(
            plan.env
                .iter()
                .any(|(k, v)| k == "FLUTTER_SUPPRESS_ANALYTICS" && v == "true"),
            "环境变量应进入执行计划"
        );
        assert_eq!(
            &plan.args[plan.args.len() - 2..],
            &["pub".to_string(), "get".to_string()],
            "自定义参数应原样传递"
        );

        // %FLUTTER% 解析出的 .bat 必须走 cmd 包装（/d /c <bat> <args>）
        if plan.program == "cmd.exe" {
            assert_eq!(plan.args[0], "/d");
            assert_eq!(plan.args[1], "/c");
            assert!(plan.args[2].to_lowercase().ends_with("flutter.bat"));
        } else {
            assert_eq!(plan.args, vec!["pub".to_string(), "get".to_string()]);
        }

        // 自定义命令缺程序应报错
        cmd.program = Some("   ".into());
        assert!(build_plan_for(&state, &project, &cmd, None).is_err());

        // 工作区项目不带任何环境变量
        if let Some(rc) = project.commands.first() {
            let rp = build_plan_for(&state, &project, rc, None).unwrap();
            assert!(rp.env.is_empty());
        }
    }

    #[test]
    fn workspace_root_resolution_accepts_file_dir_and_vscode() {
        let tmp = std::env::temp_dir().join("fla_root_probe");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".vscode")).unwrap();
        std::fs::write(tmp.join(".vscode").join("launch.json"), "{}").unwrap();

        let root = tmp.display().to_string();
        let expect = std::fs::canonicalize(&tmp).unwrap();

        // 直接给工作区目录
        let a = resolve_workspace_root(&root).unwrap();
        assert_eq!(std::fs::canonicalize(&a).unwrap(), expect);

        // 给 .vscode 目录
        let b = resolve_workspace_root(&format!("{root}\\.vscode")).unwrap();
        assert_eq!(std::fs::canonicalize(&b).unwrap(), expect);

        // 给 launch.json 文件本身
        let c = resolve_workspace_root(&format!("{root}\\.vscode\\launch.json")).unwrap();
        assert_eq!(std::fs::canonicalize(&c).unwrap(), expect);

        // 不存在的目录
        assert!(resolve_workspace_root(&format!("{root}\\nope")).is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn import_path_validates_launch_json_before_mutating() {
        // 有 pubspec 但没有 .vscode/launch.json：应报错且**不留下半个项目**
        let tmp = std::env::temp_dir().join("fla_import_nolaunch");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("pubspec.yaml"), b"name: nolaunch\n").unwrap();

        let mut state = State::default();
        let err = import_launch_from_path(&mut state, &tmp.display().to_string()).unwrap_err();

        assert!(
            err.contains("launch.json"),
            "错误信息应指出缺 launch.json：{err}"
        );
        assert!(
            err.contains("添加 Flutter 项目"),
            "有 pubspec 时应引导用正确入口：{err}"
        );
        assert!(
            state.projects.is_empty(),
            "校验失败不应改动状态，实际有 {} 个项目",
            state.projects.len()
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn import_path_picks_kind_by_pubspec() {
        let tmp = std::env::temp_dir().join("fla_import_kind");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".vscode")).unwrap();
        std::fs::write(
            tmp.join(".vscode").join("launch.json"),
            r#"{"version":"0.2.0","configurations":[
                 {"name":"Demo","type":"dart","request":"launch","program":"lib/main.dart"}
               ]}"#,
        )
        .unwrap();

        // 没有 pubspec → 命令集
        let mut state = State::default();
        let (p, outcome, created) =
            import_launch_from_path(&mut state, &tmp.display().to_string()).unwrap();
        assert!(created);
        assert_eq!(p.kind, "workspace", "无 pubspec 应作为命令集");
        assert_eq!(outcome.imported, 1);
        assert_eq!(state.projects.len(), 1);

        // 再导一次：不重复添加，只刷新命令
        let (p2, _, created2) =
            import_launch_from_path(&mut state, &tmp.display().to_string()).unwrap();
        assert!(!created2, "同一目录不应重复添加");
        assert_eq!(p2.id, p.id);
        assert_eq!(state.projects.len(), 1);

        // 加上 pubspec → 同一个目录应变成 Flutter 项目
        std::fs::write(tmp.join("pubspec.yaml"), b"name: demo\n").unwrap();
        let mut state2 = State::default();
        let (p3, outcome3, _) =
            import_launch_from_path(&mut state2, &tmp.display().to_string()).unwrap();
        assert_eq!(p3.kind, "single", "有 pubspec 应作为普通 Flutter 项目");
        assert_eq!(outcome3.imported, 1);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn corrupted_state_is_backed_up() {
        let tmp = std::env::temp_dir().join("fla_m1_corrupt.json");
        fs::write(&tmp, "{ this is not json").unwrap();

        let state = store::load_from(&tmp);
        assert!(state.projects.is_empty(), "损坏文件应回退为默认状态");

        let bak = tmp.with_file_name("state.corrupt.json");
        assert!(bak.exists(), "应留下损坏文件备份");
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(&bak);
    }
}



