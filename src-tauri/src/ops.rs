//! 业务操作：与 Tauri 解耦，便于直接单元测试。

use crate::launch::{self, ImportOutcome};
use crate::model::{make_id, Project, State};
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

    let project = Project {
        id: make_id("proj", &p.to_lowercase()),
        name,
        path: p,
        kind: if has_pubspec {
            "single".to_string()
        } else {
            "workspace".to_string()
        },
        flutter_tool: None,
        commands: Vec::new(),
    };

    state.projects.push(project.clone());
    Ok(project)
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

/// 一次会话的执行计划：最终要执行的程序、参数、工作目录
#[derive(Debug, Clone)]
pub struct Plan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub title: String,
    pub device: String,
}

/// 把「项目 + 命令」翻译成可直接 spawn 的程序与参数。
///
/// 关键约定：
/// - 工作目录 = 项目根 + 命令的 `cwd`（工作区模式下每个命令指向自己的子应用）
/// - `.bat` 不能直接 CreateProcess，必须 `cmd.exe /d /c <bat> <args>`
///   （**不能加 `/s`**：实测 `/s` 会剥掉引号，导致含空格路径被截断）
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

    let project_root = PathBuf::from(&project.path);
    let cwd = match &command.cwd {
        Some(c) if !c.trim().is_empty() => project_root.join(c),
        _ => project_root.clone(),
    };
    if !cwd.is_dir() {
        return Err(format!("工作目录不存在：{}", cwd.display()));
    }

    let custom = project
        .flutter_tool
        .as_ref()
        .and_then(|f| f.custom_path.clone())
        .or_else(|| state.settings.flutter_tool.custom_path.clone());

    // FVM 的 junction 通常挂在子应用目录下，先查 cwd 再查项目根
    let mut resolved = crate::flutter::resolve(&cwd, custom.as_deref());
    if resolved.0.is_none() {
        resolved = crate::flutter::resolve(&project_root, custom.as_deref());
    }
    let exe = resolved.0.ok_or_else(|| {
        "未找到 flutter 可执行文件（PATH 中没有，项目也没有 .fvm/flutter_sdk）".to_string()
    })?;

    // 设备优先级：本次调用显式指定 > 命令自身配置
    let resolved_device = device_override
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| command.device_id.clone().filter(|s| !s.is_empty()));

    let mut flutter_args: Vec<String> = Vec::new();
    match command.kind.as_str() {
        "build" => {
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
        }
        _ => {
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
    }
    flutter_args.extend(command.tool_args.iter().cloned());
    flutter_args.extend(command.args.iter().cloned());

    let exe_str = exe.display().to_string();
    let is_batch = exe
        .extension()
        .map(|e| {
            let e = e.to_string_lossy().to_ascii_lowercase();
            e == "bat" || e == "cmd"
        })
        .unwrap_or(false);

    let (program, args) = if is_batch {
        let mut a = vec!["/d".to_string(), "/c".to_string(), exe_str];
        a.extend(flutter_args);
        ("cmd.exe".to_string(), a)
    } else {
        (exe_str, flutter_args)
    };

    Ok(Plan {
        program,
        args,
        cwd,
        title: format!("{}:{}", project.name, command.name),
        device: resolved_device.unwrap_or_else(|| "自动".to_string()),
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
