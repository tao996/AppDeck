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

fn resolve_flutter_exe(
    state: &State,
    project: &Project,
    cwd: &std::path::Path,
) -> Result<PathBuf, String> {
    let custom = project
        .flutter_tool
        .as_ref()
        .and_then(|f| f.custom_path.clone())
        .or_else(|| state.settings.flutter_tool.custom_path.clone());

    // FVM 的 junction 通常挂在子应用目录下，先查 cwd 再查项目根
    let mut resolved = crate::flutter::resolve(cwd, custom.as_deref());
    if resolved.0.is_none() {
        resolved = crate::flutter::resolve(&PathBuf::from(&project.path), custom.as_deref());
    }
    resolved.0.ok_or_else(|| {
        "未找到 flutter 可执行文件（PATH 中没有，项目也没有 .fvm/flutter_sdk）".to_string()
    })
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

    let env: Vec<(String, String)> = command
        .env
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let (program, args) = match command.kind.as_str() {
        "custom" => {
            let raw = command.program.as_deref().unwrap_or("").trim();
            if raw.is_empty() {
                return Err("自定义命令必须填写程序（可执行文件路径，或 %FLUTTER%）".to_string());
            }

            let prog = if raw.eq_ignore_ascii_case("%FLUTTER%") {
                resolve_flutter_exe(state, project, &cwd)?
                    .display()
                    .to_string()
            } else {
                raw.to_string()
            };

            wrap_batch(prog, command.args.clone())
        }
        kind => {
            let exe = resolve_flutter_exe(state, project, &cwd)?;
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

            wrap_batch(exe.display().to_string(), flutter_args)
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

    let exe = resolve_flutter_exe(state, project, &cwd)?;
    let (program, args) = wrap_batch(exe.display().to_string(), args);

    Ok(Plan {
        program,
        args,
        cwd,
        title,
        device: "—".to_string(),
        env: Vec::new(),
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
        // .bat 经 cmd.exe /d /c 启动（不能带 /s）
        assert_eq!(plan.program, "cmd.exe");
        assert_eq!(plan.args[0], "/d");
        assert_eq!(plan.args[1], "/c");
        assert!(
            plan.args[2].to_ascii_lowercase().ends_with("flutter.bat")
                || plan.args[2].to_ascii_lowercase().ends_with("flutter"),
            "应指向 flutter 可执行文件，实际: {}",
            plan.args[2]
        );
        // flutter 子命令与参数
        assert!(plan.args.contains(&"run".to_string()));
        assert!(!plan.args.contains(&"--release".to_string()), "run 不该带 --release");
        assert!(
            plan.args.iter().any(|a| a == "--dart-define=APP_CHANNEL=cn"),
            "应保留自定义 args"
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
