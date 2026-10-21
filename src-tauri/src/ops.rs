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
    // 生态挂在命令上，所以这四种都算"项目"
    let has_package = pb.join("package.json").exists();
    let has_compose = crate::docker::find_compose(&pb).is_some();
    if !has_pubspec && !has_launch && !has_package && !has_compose {
        return Err(
            "这个目录不是 Flutter 项目（无 pubspec.yaml）、工作区（无 .vscode/launch.json）、\
             前端项目（无 package.json）或 Compose 项目（无 docker-compose.yml）"
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
/// 导入 package.json：解析 scripts 生成/同步命令。
///
/// 与 launch.json 一致：同路径项目复用（追加命令），否则新建。
/// 返回 (项目, 合并结果, 是否新建, 包管理器)。
/// 导入 docker-compose：按 service 生成命令（启动 / 日志 / 全部停止）。
///
/// 项目根 = compose 文件所在目录，所以命令的 cwd 为空、`-f` 只带文件名。
pub fn import_compose_from_path(
    state: &mut State,
    raw: &str,
) -> Result<(Project, crate::docker::MergeOutcome, bool, usize), String> {
    let (dir, file) = resolve_compose(raw)?;
    let compose = crate::docker::read(&file)?;
    let count = compose.services.len();

    let docker = state
        .settings
        .docker
        .docker_path
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "docker".to_string());
    let style = state.settings.docker.compose_style.as_deref();

    // **先校验再改状态**
    let fresh = crate::docker::commands_for(&compose, "", &docker, style);

    let root = normalize(&dir.display().to_string());
    let existing = state
        .projects
        .iter()
        .find(|p| normalize(&p.path).eq_ignore_ascii_case(&root))
        .map(|p| p.id.clone());

    let (id, created) = match existing {
        Some(id) => (id, false),
        None => {
            let p = add_project_to(state, &root)?;
            (p.id, true)
        }
    };

    let project = state
        .projects
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let outcome = crate::docker::merge_into(project, fresh);
    Ok((project.clone(), outcome, created, count))
}

/// 定位 compose 文件：可以选文件（.yml/.yaml）或目录（自动找常见文件名）
fn resolve_compose(raw: &str) -> Result<(PathBuf, PathBuf), String> {
    let p = PathBuf::from(raw.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".to_string());
    }

    if p.is_file() {
        let dir = p
            .parent()
            .map(|x| x.to_path_buf())
            .ok_or_else(|| "路径无效".to_string())?;
        return Ok((dir, p));
    }

    if p.is_dir() {
        let f = crate::docker::find_compose(&p).ok_or_else(|| {
            format!(
                "{} 下没有 docker-compose.yml / docker-compose.yaml / compose.yml / compose.yaml",
                p.display()
            )
        })?;
        return Ok((p, f));
    }

    Err(format!("路径不存在：{}", p.display()))
}

pub fn import_package_from_path(
    state: &mut State,
    raw: &str,
) -> Result<(Project, crate::npm::MergeOutcome, bool, crate::npm::Manager), String> {
    let root = resolve_package_root(raw)?;
    let pkg = PathBuf::from(&root).join("package.json");

    // **先校验再改状态**（同 launch.json 的做法）
    let scripts = crate::npm::read_scripts(&pkg)?;
    if scripts.is_empty() {
        return Err(format!("{} 里没有任何 scripts", pkg.display()));
    }

    let manager = crate::npm::detect_manager(
        &PathBuf::from(&root),
        state.settings.npm.manager.as_deref(),
    );

    let existing = state
        .projects
        .iter()
        .find(|p| normalize(&p.path).eq_ignore_ascii_case(&normalize(&root)))
        .map(|p| p.id.clone());

    let (id, created) = match existing {
        Some(id) => (id, false),
        None => {
            let p = add_project_to(state, &root)?;
            (p.id, true)
        }
    };

    let project = state
        .projects
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "项目不存在".to_string())?;

    let outcome = crate::npm::merge_into(project, &scripts, manager);
    Ok((project.clone(), outcome, created, manager))
}

/// 定位 package.json 所在目录：可以选文件（必须是 package.json）或目录
fn resolve_package_root(raw: &str) -> Result<String, String> {
    let p = PathBuf::from(raw.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".to_string());
    }

    let dir = if p.is_file() {
        if !p
            .file_name()
            .map(|n| n.eq_ignore_ascii_case("package.json"))
            .unwrap_or(false)
        {
            return Err("请选择 package.json 文件或它所在的目录".to_string());
        }
        p.parent()
            .map(|x| x.to_path_buf())
            .ok_or_else(|| "路径无效".to_string())?
    } else {
        p
    };

    if !dir.is_dir() {
        return Err(format!("目录不存在：{}", dir.display()));
    }
    if !dir.join("package.json").is_file() {
        return Err(format!("{} 下没有 package.json", dir.display()));
    }
    Ok(normalize(&dir.display().to_string()))
}

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

/// 模板分类：flutter | npm | docker | custom。
///
/// 显式 `category` 优先；为空时按 program/args 推断，
/// 这样老数据（没有这个字段）也能正确分组。
pub fn template_category(c: &Command) -> &'static str {
    if let Some(raw) = c.category.as_deref() {
        let v = raw.trim().to_ascii_lowercase();
        match v.as_str() {
            "flutter" => return "flutter",
            "npm" => return "npm",
            "docker" => return "docker",
            "custom" => return "custom",
            _ => {}
        }
    }

    let hay = format!(
        "{} {}",
        c.program.clone().unwrap_or_default(),
        c.args.join(" ")
    )
    .to_ascii_lowercase();

    if hay.contains("%flutter%") || hay.starts_with("flutter") || hay.contains(" flutter ") {
        "flutter"
    } else if ["npm", "pnpm", "yarn", "node"]
        .iter()
        .any(|k| hay.contains(k))
    {
        "npm"
    } else if hay.contains("docker") {
        "docker"
    } else {
        "custom"
    }
}

/// 把一条命令翻译成「在交互式 shell 里可以敲的一行」。
///
/// 用于普通命令（custom）：不再给每条命令开一个进程，
/// 而是把它打进项目常驻的终端里，跑完 shell 还在，可以接着敲。
/// 命令的 cwd 与项目根不同时，前面补一个 cd。
pub fn shell_line_for(
    state: &State,
    project: &Project,
    command: &Command,
) -> Result<String, String> {
    let project_root = PathBuf::from(&project.path);

    let cwd = match &command.cwd {
        Some(c) if !c.trim().is_empty() => {
            let expanded = expand_placeholders(c, &project_root, &project_root, None);
            let p = PathBuf::from(&expanded);
            if p.is_absolute() { p } else { project_root.join(p) }
        }
        _ => project_root.clone(),
    };

    let (program, args) = match external_program(command) {
        Some(x) => x,
        None => {
            // 自定义命令：展开占位符，.ps1 交给 PowerShell
            let raw = command.program.as_deref().unwrap_or("").trim();
            if raw.is_empty() {
                return Err("命令没有填写程序".to_string());
            }
            let flutter_exe = if raw.to_lowercase().contains("%flutter%") {
                Some(crate::flutter::ctx_for(state, project, &cwd)?.exe)
            } else {
                None
            };
            let prog = expand_placeholders(raw, &project_root, &cwd, flutter_exe.as_deref());
            let arg_list: Vec<String> = command
                .args
                .iter()
                .map(|a| expand_placeholders(a, &project_root, &cwd, flutter_exe.as_deref()))
                .collect();

            let prog = crate::terminal::resolve_executable(&prog);
            if prog.to_ascii_lowercase().ends_with(".ps1") {
                let ps = crate::terminal::powershell_for(state.settings.terminal.path.as_deref());
                let (p, a) = crate::terminal::wrap_ps1(&ps, &prog, &arg_list);
                (p, a)
            } else {
                (prog, arg_list)
            }
        }
    };

    let shell = crate::terminal::resolve(state.settings.terminal.path.as_deref());
    let line = crate::terminal::command_line(&shell, &program, &args);

    // cwd 不在项目根时先切目录（同一个 shell 是项目级共享的）
    let same_dir = cwd
        .canonicalize()
        .ok()
        .zip(project_root.canonicalize().ok())
        .map(|(a, b)| a == b)
        .unwrap_or(false);

    if same_dir {
        Ok(line)
    } else {
        let cd = crate::terminal::cd_prefix(&shell, &cwd);
        Ok(format!("{cd}{line}"))
    }
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

    let ctx = crate::flutter::ctx_for(state, project, &cwd).ok();
    let term = crate::terminal::resolve(state.settings.terminal.path.as_deref());

    // 外部程序（npm / docker）直接用自己的 program+args；只有 flutter 才需要 ctx
    let (prog, arg_list) = if let Some((p, a)) = external_program(command) {
        (p, a)
    } else {
        let c = ctx
            .as_ref()
            .ok_or_else(|| "找不到该项目的 flutter，无法生成命令".to_string())?;
        (
            c.exe.display().to_string(),
            run_args(command, command.device_id.as_deref()),
        )
    };

    let line = crate::terminal::command_line(&term, &prog, &arg_list);

    Ok((
        Plan {
            program: term.display().to_string(),
            args: crate::terminal::args_for(&term),
            cwd,
            title: format!("{} · {}", project.name, command.name),
            device: "—".to_string(),
            env: ctx.as_ref().map(|c| c.env_with_path()).unwrap_or_default(),
        },
        line,
    ))
}

/// npm / docker 这类命令是"外部程序"，不该走 flutter 分支。
///
/// **不能用 kind 判断**：kind=run 现在表示"开发阶段（长时间运行）"，
/// flutter run 和 `npm run dev` / `docker compose logs -f` 都是 run，
/// 但后者必须直接执行 program，不能拼成 `flutter run -f ...`。
fn external_program(command: &Command) -> Option<(String, Vec<String>)> {
    let src = command.source.as_deref().unwrap_or("");
    if !matches!(src, "npm" | "docker") {
        return None;
    }
    let prog = command.program.as_deref().unwrap_or("").trim();
    if prog.is_empty() {
        return None;
    }
    Some((
        crate::terminal::resolve_executable(prog),
        command.args.clone(),
    ))
}

/// 大小写无关的字面替换（`%PROJECT%` / `%project%` 都认）

fn replace_ci(hay: &str, needle: &str, val: &str) -> String {
    let lower = hay.to_lowercase();
    let n = needle.to_lowercase();
    let mut out = String::new();
    let mut i = 0usize;

    while let Some(pos) = lower[i..].find(&n) {
        out.push_str(&hay[i..i + pos]);
        out.push_str(val);
        i += pos + n.len();
    }
    out.push_str(&hay[i..]);
    out
}

/// 展开命令里的占位符：
/// - `%PROJECT%` 项目根目录
/// - `%CWD%`     命令实际工作目录（已含项目根）
/// - `%FLUTTER%` 解析出的 flutter 可执行文件
fn expand_placeholders(
    text: &str,
    project_root: &std::path::Path,
    cwd: &std::path::Path,
    flutter: Option<&std::path::Path>,
) -> String {
    let mut out = replace_ci(text, "%PROJECT%", &project_root.display().to_string());
    out = replace_ci(&out, "%CWD%", &cwd.display().to_string());
    if let Some(f) = flutter {
        out = replace_ci(&out, "%FLUTTER%", &f.display().to_string());
    }
    out
}

pub fn build_plan_for(
    state: &State,
    project: &Project,
    command: &Command,
    device_override: Option<&str>,
) -> Result<Plan, String> {
    let project_root = PathBuf::from(&project.path);

    // cwd 先展开占位符（%PROJECT% 等），再决定要不要拼到项目根下
    let cwd = match &command.cwd {
        Some(c) if !c.trim().is_empty() => {
            let expanded = expand_placeholders(c, &project_root, &project_root, None);
            let p = PathBuf::from(&expanded);
            if p.is_absolute() { p } else { project_root.join(p) }
        }
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

    // npm / docker 是"外部程序"：必须按 program+args 直接执行。
    // **不能只看 kind**——kind=run 表示"开发阶段"，flutter run 与 npm run dev / docker logs -f
    // 都是 run，但后者拼进 flutter 命令行就成了 `flutter run -f ...`（实测踩过）。
    let (program, args) = if let Some((prog, list)) = external_program(command) {
        wrap_batch(prog, list)
    } else {
        match command.kind.as_str() {
        "custom" => {
            let raw = command.program.as_deref().unwrap_or("").trim();
            if raw.is_empty() {
                return Err(
                    "自定义命令必须填写程序（可执行文件路径，%FLUTTER% / %PROJECT% / %CWD%）"
                        .to_string(),
                );
            }

            // 展开占位符：%FLUTTER%（按需解析） / %PROJECT% / %CWD%
            let flutter_exe = if raw.to_lowercase().contains("%flutter%") {
                Some(need_flutter()?)
            } else {
                None
            };
            let prog = expand_placeholders(
                raw,
                &project_root,
                &cwd,
                flutter_exe.as_deref(),
            );

            // 参数里也可能有占位符（例如 `-ScanDir %PROJECT%`）
            let arg_list: Vec<String> = command
                .args
                .iter()
                .map(|a| expand_placeholders(a, &project_root, &cwd, flutter_exe.as_deref()))
                .collect();

            // .ps1 不能直接 CreateProcess，交给 PowerShell
            let prog = crate::terminal::resolve_executable(&prog);

            if prog.to_ascii_lowercase().ends_with(".ps1") {
                let ps =
                    crate::terminal::powershell_for(state.settings.terminal.path.as_deref());
                crate::terminal::wrap_ps1(&ps, &prog, &arg_list)
            } else {
                wrap_batch(prog, arg_list)
            }
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
            path.unwrap().contains(crate::store::APP_ID),
            "PATH 应包含 shim 目录（跟随 APP_ID）"
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
    fn npm_and_docker_commands_do_not_go_through_flutter() {
        let root = std::env::temp_dir().join("fla_ext_dispatch");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let state = State::default();
        let project = Project {
            id: "p-ext".into(),
            name: "demo".into(),
            path: root.display().to_string(),
            kind: "workspace".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        };

        // docker 的 logs 也是 kind=run，但必须执行 docker 而不是 flutter
        let docker = Command {
            id: "d1".into(),
            name: "web · 日志".into(),
            kind: "run".into(),
            program: Some("docker".into()),
            cwd: None,
            flutter_mode: None,
            args: vec!["compose".into(), "logs".into(), "-f".into(), "web".into()],
            env: Default::default(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("docker".into()),
            scope: Some("project".into()),
            stale: false,
            group: Some("web".into()),
            role: Some("logs".into()),
            category: None,
        };
        let plan = build_plan_for(&state, &project, &docker, None).unwrap();
        assert!(
            plan.program.eq_ignore_ascii_case("docker") || plan.program.ends_with("docker.exe"),
            "docker 命令不该走 flutter，实际: {}",
            plan.program
        );
        assert_eq!(plan.args, vec!["compose", "logs", "-f", "web"]);

        // npm 的 dev 同理
        let npm = Command {
            id: "n1".into(),
            name: "dev".into(),
            kind: "run".into(),
            program: Some("npm".into()),
            cwd: None,
            flutter_mode: None,
            args: vec!["run".into(), "dev".into()],
            env: Default::default(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("npm".into()),
            scope: Some("project".into()),
            stale: false,
            group: None,
            role: None,
            category: None,
        };
        let plan = build_plan_for(&state, &project, &npm, None).unwrap();
        // npm 在 Windows 上是 npm.cmd → wrap_batch 会包成 cmd.exe /d /c "npm.cmd" run dev
        let joined = plan.args.join(" ");
        assert!(
            !plan.program.to_ascii_lowercase().contains("flutter")
                && !joined.to_ascii_lowercase().contains("flutter"),
            "npm 命令不该出现 flutter：{} {}",
            plan.program,
            joined
        );
        if plan.program.eq_ignore_ascii_case("cmd.exe") {
            assert!(
                joined.to_ascii_lowercase().contains("npm.cmd"),
                "应经 cmd 包装 npm.cmd，实际: {joined}"
            );
            assert!(joined.contains("run") && joined.contains("dev"));
        } else {
            assert!(
                plan.program.to_ascii_lowercase().ends_with("npm.exe"),
                "实际: {}",
                plan.program
            );
            assert_eq!(plan.args, vec!["run", "dev"]);
        }

        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn template_category_prefers_explicit_then_infers() {
        fn mk(program: &str, args: &[&str], category: Option<&str>) -> Command {
            Command {
                id: "t".into(),
                name: "t".into(),
                kind: "custom".into(),
                program: Some(program.into()),
                cwd: None,
                flutter_mode: None,
                args: args.iter().map(|s| s.to_string()).collect(),
                env: Default::default(),
                tool_args: vec![],
                device_id: None,
                emulator_id: None,
                build_type: None,
                source: Some("template".into()),
                scope: Some("global".into()),
                stale: false,
                group: None,
                role: None,
                category: category.map(|s| s.to_string()),
            }
        }

        // 没有显式分类时按 program/args 推断
        assert_eq!(template_category(&mk("%FLUTTER%", &["pub", "get"], None)), "flutter");
        assert_eq!(template_category(&mk("npm", &["run", "build"], None)), "npm");
        assert_eq!(template_category(&mk("pnpm", &["test"], None)), "npm");
        assert_eq!(template_category(&mk("docker", &["compose", "up"], None)), "docker");
        assert_eq!(template_category(&mk("bash", &["deploy.sh"], None)), "custom");

        // 显式分类优先（用户可在模板库里改）
        assert_eq!(template_category(&mk("docker", &["compose"], Some("flutter"))), "flutter");
        // 无法识别的值退回推断
        assert_eq!(template_category(&mk("docker", &["compose"], Some("乱写"))), "docker");
    }
    #[test]
    fn shell_line_for_docker_uses_resolved_exe() {
        let root = std::env::temp_dir().join("fla_shell_line");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let state = State::default();
        let project = Project {
            id: "p-sh".into(),
            name: "demo".into(),
            path: root.display().to_string(),
            kind: "workspace".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        };
        let cmd = Command {
            id: "d1".into(),
            name: "nginx · 启动".into(),
            kind: "custom".into(),
            program: Some("docker".into()),
            cwd: None,
            flutter_mode: None,
            args: vec![
                "compose".into(),
                "-f".into(),
                "docker-compose.yaml".into(),
                "up".into(),
                "-d".into(),
                "nginx".into(),
            ],
            env: Default::default(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("docker".into()),
            scope: Some("project".into()),
            stale: false,
            group: Some("nginx".into()),
            role: Some("up".into()),
            category: None,
        };

        let line = shell_line_for(&state, &project, &cmd).unwrap();

        // 必须是「可执行文件 + 参数」的一行，且带上 docker 子命令
        assert!(line.contains("compose"), "实际: {line}");
        assert!(line.contains("up") && line.contains("-d") && line.contains("nginx"), "实际: {line}");
        // 裸名 docker 已解析成 .exe（否则 CreateProcess 报 os error 193）
        if crate::terminal::which("docker").is_some() {
            assert!(
                line.to_ascii_lowercase().contains("docker.exe"),
                "应解析成 docker.exe，实际: {line}"
            );
        }
        // cwd 等于项目根时不该出现 cd 前缀
        assert!(!line.contains("Set-Location"), "不该有多余 cd：{line}");

        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn import_compose_creates_project_with_service_commands() {
        let root = std::env::temp_dir().join("fla_compose_import");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n",
        )
        .unwrap();

        let mut state = State::default();
        let (project, outcome, created, services) =
            import_compose_from_path(&mut state, &root.display().to_string()).unwrap();

        assert!(created, "只有 compose 的目录也应能建项目");
        assert_eq!(services, 2);
        assert_eq!(outcome.added.len(), 15, "2 服务 × 6 个动作 + 3 个项目级");

        let up = project.commands.iter().find(|c| c.name == "web · 启动").unwrap();
        assert_eq!(up.kind, "custom");
        assert_eq!(
            up.args,
            vec!["compose", "-f", "docker-compose.yml", "up", "-d", "web"]
        );

        let logs = project.commands.iter().find(|c| c.name == "db · 日志").unwrap();
        assert_eq!(logs.kind, "run");

        // 再导一次：不重复
        let (_, outcome2, created2, _) =
            import_compose_from_path(&mut state, &root.display().to_string()).unwrap();
        assert!(!created2);
        assert!(outcome2.added.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn import_package_creates_project_then_merges_without_duplicates() {
        let root = std::env::temp_dir().join("fla_npm_import");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("package.json"),
            br#"{"name":"demo","scripts":{"dev":"vite","build":"vite build","lint":"eslint ."}}"#,
        )
        .unwrap();
        std::fs::write(root.join("pnpm-lock.yaml"), b"").unwrap();

        let mut state = State::default();
        let (project, outcome, created, manager) =
            import_package_from_path(&mut state, &root.display().to_string()).unwrap();

        assert!(created, "首次导入应新建项目");
        assert_eq!(manager, crate::npm::Manager::Pnpm, "有 pnpm-lock 就用 pnpm");
        assert_eq!(project.commands.len(), 3);
        assert_eq!(outcome.added.len(), 3);

        let dev = project.commands.iter().find(|c| c.name == "dev").unwrap();
        assert_eq!(dev.kind, "run", "dev 属于长时间运行");
        assert_eq!(dev.program.as_deref(), Some("pnpm"));

        let build = project.commands.iter().find(|c| c.name == "build").unwrap();
        assert_eq!(build.kind, "build", "build 属于一次性产物");

        let lint = project.commands.iter().find(|c| c.name == "lint").unwrap();
        assert_eq!(lint.kind, "custom", "其余归为普通任务");

        // 再导入一次：不应重复添加
        let (project2, outcome2, created2, _) =
            import_package_from_path(&mut state, &root.display().to_string()).unwrap();
        assert!(!created2, "同一路径应复用项目");
        assert!(outcome2.added.is_empty(), "不应重复添加命令");
        assert_eq!(outcome2.kept.len(), 3);
        assert_eq!(project2.commands.len(), 3);

        // 直接传 package.json 文件路径也应能定位
        let (_, _, _, mgr) = import_package_from_path(
            &mut state,
            &root.join("package.json").display().to_string(),
        )
        .unwrap();
        assert_eq!(mgr, crate::npm::Manager::Pnpm);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn custom_ps1_runs_through_powershell_with_project_placeholder() {
        let root = std::env::temp_dir().join("fla_ps1_cmd");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("run.ps1");
        std::fs::write(&script, b"Write-Host hi\n").unwrap();

        let state = State::default();
        let project = Project {
            id: "p-ps1".into(),
            name: "demo".into(),
            path: root.display().to_string(),
            kind: "single".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        };
        let cmd = Command {
            id: "c1".into(),
            name: "脚本".into(),
            kind: "custom".into(),
            program: Some(script.display().to_string()),
            cwd: None,
            flutter_mode: None,
            args: vec!["-ScanDir".into(), "%PROJECT%".into()],
            env: Default::default(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("manual".into()),
            scope: None,
            stale: false,
            group: None,
            role: None,
            category: None,
        };

        let plan = build_plan_for(&state, &project, &cmd, None).unwrap();
        let joined = plan.args.join(" ");

        // .ps1 必须交给 PowerShell，并带执行策略
        assert!(
            plan.program.to_ascii_lowercase().contains("powershell")
                || plan.program.to_ascii_lowercase().ends_with("pwsh.exe"),
            "应由 PowerShell 执行，实际: {}",
            plan.program
        );
        assert!(joined.contains("-ExecutionPolicy"), "缺执行策略: {joined}");
        assert!(joined.contains("Bypass"), "缺 Bypass: {joined}");
        assert!(joined.contains("-File"), "缺 -File: {joined}");
        assert!(joined.contains("run.ps1"), "脚本路径没带上: {joined}");

        // %PROJECT% 展开为项目根（最后一个参数）
        assert_eq!(
            plan.args.last().map(|s| s.as_str()),
            Some(root.display().to_string().as_str()),
            "参数里的 %PROJECT% 应展开，实际: {:?}",
            plan.args
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cwd_accepts_project_placeholder() {
        let root = std::env::temp_dir().join("fla_cwd_ph");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();

        let state = State::default();
        let project = Project {
            id: "p-cwd".into(),
            name: "demo".into(),
            path: root.display().to_string(),
            kind: "single".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        };
        let cmd = Command {
            id: "c2".into(),
            name: "x".into(),
            kind: "custom".into(),
            program: Some("cmd.exe".into()),
            cwd: Some("%PROJECT%\\sub".into()),
            flutter_mode: None,
            args: vec![],
            env: Default::default(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("manual".into()),
            scope: None,
            stale: false,
            group: None,
            role: None,
            category: None,
        };

        let plan = build_plan_for(&state, &project, &cmd, None).unwrap();
        assert!(
            plan.cwd.ends_with("sub"),
            "cwd 里的 %PROJECT% 应展开，实际: {}",
            plan.cwd.display()
        );

        let _ = std::fs::remove_dir_all(&root);
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
            stale: false,
            group: None,
            role: None,
            category: None,
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



















