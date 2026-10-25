//! package.json 导入：解析 `scripts` → 命令。
//!
//! 设计要点：
//! - **生态挂在命令上**（`source = "npm"`），不挂在项目上——
//!   同一个目录完全可能既是 Flutter 工程又是前端工程。
//! - `kind` 就是"阶段"：`run` = 长时间运行（dev），`build` = 一次性产物，
//!   `custom` = 其它一次性任务（test / lint …）。
//! - 分类是**名称启发式**，猜错很正常，所以：
//!   1) 重新导入时**不覆盖**用户改过的 `kind`；
//!   2) 脚本被删掉时只标记 `stale`，不删命令。

use crate::model::{make_id, Command, Project};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Npm,
    Pnpm,
    Yarn,
}

impl Manager {
    pub fn exe(self) -> &'static str {
        match self {
            Manager::Npm => "npm",
            Manager::Pnpm => "pnpm",
            Manager::Yarn => "yarn",
        }
    }
}

/// 决定用哪个包管理器：
/// 设置里显式指定优先；否则按 lockfile 探测（pnpm > yarn > npm）。
pub fn detect_manager(dir: &Path, preference: Option<&str>) -> Manager {
    if let Some(p) = preference.map(|s| s.trim().to_ascii_lowercase()) {
        match p.as_str() {
            "npm" => return Manager::Npm,
            "pnpm" => return Manager::Pnpm,
            "yarn" => return Manager::Yarn,
            _ => {}
        }
    }

    if dir.join("pnpm-lock.yaml").is_file() {
        return Manager::Pnpm;
    }
    if dir.join("yarn.lock").is_file() {
        return Manager::Yarn;
    }
    // package-lock.json / 其它情况都按 npm 处理
    Manager::Npm
}

/// 阶段判定：看脚本名的**第一段**（`: `前），大小写无关。
///
/// - `dev` / `start` / `serve` / `watch` … → `run`（长时间运行）
/// - `build` / `bundle` / `compile` … → `build`（一次性产物）
/// - 其它（含 test / lint / format / 未知） → `custom`
pub fn classify(script: &str) -> &'static str {
    let head = script
        .split(':')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    const DEV: [&str; 7] = [
        "dev",
        "start",
        "serve",
        "watch",
        "storybook",
        "preview",
        "hot",
    ];
    const BUILD: [&str; 6] = ["build", "bundle", "compile", "pack", "export", "dist"];

    if DEV.contains(&head.as_str()) {
        "run"
    } else if BUILD.contains(&head.as_str()) {
        "build"
    } else {
        "custom"
    }
}

/// 读取 `scripts`（按名字排序，保证多次导入顺序稳定）
pub fn read_scripts(path: &Path) -> Result<Vec<(String, String)>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取失败：{e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("package.json 解析失败：{e}"))?;

    let obj = v
        .get("scripts")
        .and_then(|s| s.as_object())
        .ok_or_else(|| "package.json 里没有 scripts 字段".to_string())?;

    let mut out: Vec<(String, String)> = obj
        .iter()
        .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// 由脚本名生成一条命令
pub fn command_for(script: &str, manager: Manager) -> Command {
    Command {
        id: make_id("npm", script),
        name: script.to_string(),
        kind: classify(script).to_string(),
        program: Some(manager.exe().to_string()),
        cwd: None,
        flutter_mode: None,
        args: vec!["run".to_string(), script.to_string()],
        env: Default::default(),
        tool_args: vec![],
        device_id: None,
        emulator_id: None,
        build_type: None,
        source: Some("npm".to_string()),
        scope: Some("project".to_string()),
        stale: false,
        group: None,
        role: None,
        category: None,
    }
}

#[derive(Debug, Default)]
pub struct MergeOutcome {
    /// 新加的命令
    pub added: Vec<String>,
    /// 已存在、只做了同步（保留用户改过的 kind）
    pub kept: Vec<String>,
    /// 脚本已从 package.json 移除，命令被标记为 stale
    pub stale: Vec<String>,
}

/// 把 scripts 合并进项目：
/// - 已有同名命令 → 只同步 program 与 stale 标记，**不动 kind / 名字**
/// - 新脚本 → 追加
/// - 已消失的脚本 → 标记 stale（不删除）
///
/// `expanded`：某些脚本本身只是个"转发器"（典型是 `"tauri": "tauri"`），
/// 单独一条命令毫无意义。这类脚本由调用方预先探测出子命令列表，
/// 这里用它替换掉那条裸命令。
pub fn merge_into(
    project: &mut Project,
    scripts: &[(String, String)],
    manager: Manager,
    expanded: &HashMap<String, Vec<Command>>,
) -> MergeOutcome {
    let mut out = MergeOutcome::default();

    for (name, _) in scripts {
        // 展开型脚本：生成它的子命令，而不是一条"npm run tauri"
        if let Some(cmds) = expanded.get(name) {
            for c in cmds {
                match project.commands.iter_mut().find(|x| x.id == c.id) {
                    Some(existing) => {
                        existing.program = c.program.clone();
                        existing.args = c.args.clone();
                        existing.stale = false;
                        out.kept.push(c.name.clone());
                    }
                    None => {
                        project.commands.push(c.clone());
                        out.added.push(c.name.clone());
                    }
                }
            }

            // 清掉历史遗留的裸命令（只认当初自动生成的那条原始形态）
            if let Some(i) = project
                .commands
                .iter()
                .position(|c| is_script_command(c, name))
            {
                project.commands.remove(i);
            }
            continue;
        }

        let found = project
            .commands
            .iter_mut()
            .find(|c| is_script_command(c, name));

        match found {
            Some(c) => {
                c.program = Some(manager.exe().to_string());
                c.stale = false;
                out.kept.push(name.clone());
            }
            None => {
                project.commands.push(command_for(name, manager));
                out.added.push(name.clone());
            }
        }
    }

    // 子命令集合随 tauri 版本变化：这次没探测到的旧展开项标为失效
    if !expanded.is_empty() {
        let alive_ids: std::collections::HashSet<&str> = expanded
            .values()
            .flatten()
            .map(|c| c.id.as_str())
            .collect();
        for c in project.commands.iter_mut() {
            if !is_expansion(c) || alive_ids.contains(c.id.as_str()) {
                continue;
            }
            if !c.stale {
                c.stale = true;
                out.stale.push(c.name.clone());
            }
        }
    }

    let alive: Vec<&str> = scripts.iter().map(|(n, _)| n.as_str()).collect();
    for c in project.commands.iter_mut() {
        if c.source.as_deref() != Some("npm") {
            continue;
        }
        let Some(script) = c.args.get(1).cloned() else {
            continue;
        };
        if alive.contains(&script.as_str()) {
            continue;
        }
        if !c.stale {
            c.stale = true;
            out.stale.push(script);
        }
    }

    out
}

/// 是不是"展开型"命令（`npm run tauri -- <子命令>...`）
fn is_expansion(c: &Command) -> bool {
    c.source.as_deref() == Some("npm")
        && c.args.len() > 3
        && c.args[0] == "run"
        && c.args[1] == "tauri"
        && c.args[2] == "--"
}

fn is_script_command(c: &Command, script: &str) -> bool {
    c.source.as_deref() == Some("npm")
        && c.args.len() == 2
        && c.args[0] == "run"
        && c.args[1] == script
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn tmpdir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn project_at(path: &std::path::Path) -> Project {
        Project {
            id: "p".into(),
            name: "demo".into(),
            path: path.display().to_string(),
            kind: "single".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        }
    }

    #[test]
    fn classify_maps_scripts_to_stages() {
        // 开发阶段
        assert_eq!(classify("dev"), "run");
        assert_eq!(classify("dev:web"), "run");
        assert_eq!(classify("start"), "run");
        assert_eq!(classify("serve"), "run");
        assert_eq!(classify("Dev"), "run", "大小写无关");
        // 生产阶段
        assert_eq!(classify("build"), "build");
        assert_eq!(classify("build:prod"), "build");
        assert_eq!(classify("bundle"), "build");
        // 其它一次性
        assert_eq!(classify("test"), "custom");
        assert_eq!(classify("lint"), "custom");
        assert_eq!(classify("whatever"), "custom");
    }

    #[test]
    fn detect_manager_prefers_setting_then_lockfile() {
        let d = tmpdir("fla_npm_mgr");
        assert_eq!(detect_manager(&d, None), Manager::Npm, "什么都没有时用 npm");

        std::fs::write(d.join("yarn.lock"), b"").unwrap();
        assert_eq!(detect_manager(&d, None), Manager::Yarn);

        std::fs::write(d.join("pnpm-lock.yaml"), b"").unwrap();
        assert_eq!(detect_manager(&d, None), Manager::Pnpm, "pnpm 优先");

        // 设置里显式指定时压过 lockfile，auto 则回落到探测
        assert_eq!(detect_manager(&d, Some("npm")), Manager::Npm);
        assert_eq!(detect_manager(&d, Some("auto")), Manager::Pnpm);

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn read_scripts_parses_and_sorts() {
        let d = tmpdir("fla_npm_pkg");
        let pkg = d.join("package.json");
        std::fs::write(
            &pkg,
            br#"{"name":"x","scripts":{"build":"vite build","dev":"vite","test":"vitest"}}"#,
        )
        .unwrap();

        let scripts = read_scripts(&pkg).unwrap();
        assert_eq!(
            scripts.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            vec!["build", "dev", "test"],
            "应按名字排序"
        );

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn read_scripts_rejects_missing_field() {
        let d = tmpdir("fla_npm_noscripts");
        let pkg = d.join("package.json");
        std::fs::write(&pkg, br#"{"name":"x"}"#).unwrap();
        let err = read_scripts(&pkg).unwrap_err();
        assert!(err.contains("scripts"), "错误应说明缺 scripts：{err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn merge_adds_keeps_user_kind_and_marks_stale() {
        let d = tmpdir("fla_npm_merge");
        let mut p = project_at(&d);
        // 用户已有命令：把 dev 手工改成了 build（想让它当一次性跑）
        let mut custom = command_for("dev", Manager::Npm);
        custom.kind = "build".into();
        p.commands.push(custom);

        let scripts = vec![
            ("dev".to_string(), "vite".to_string()),
            ("build".to_string(), "vite build".to_string()),
        ];
        let out = merge_into(&mut p, &scripts, Manager::Pnpm, &HashMap::new());

        assert_eq!(out.added, vec!["build".to_string()], "只应新增 build");
        assert_eq!(out.kept, vec!["dev".to_string()]);

        let dev = p
            .commands
            .iter()
            .find(|c| c.name == "dev")
            .expect("dev 应还在");
        assert_eq!(dev.kind, "build", "用户改过的 kind 不能被覆盖");
        assert_eq!(dev.program.as_deref(), Some("pnpm"), "程序应同步为新包管理器");

        // 再导入一次，去掉 dev 脚本 → dev 应被标记 stale 而不是删除
        let scripts2 = vec![("build".to_string(), "vite build".to_string())];
        let out2 = merge_into(&mut p, &scripts2, Manager::Pnpm, &HashMap::new());
        assert_eq!(out2.stale, vec!["dev".to_string()]);
        assert!(p.commands.iter().any(|c| c.name == "dev"), "stale 命令要保留");
        assert!(
            p.commands.iter().find(|c| c.name == "dev").unwrap().stale,
            "应打上 stale 标记"
        );

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn command_for_uses_run_subcommand() {
        let c = command_for("dev:web", Manager::Yarn);
        assert_eq!(c.program.as_deref(), Some("yarn"));
        assert_eq!(c.args, vec!["run".to_string(), "dev:web".to_string()]);
        assert_eq!(c.kind, "run");
        assert_eq!(c.source.as_deref(), Some("npm"));
        assert!(!c.stale);
        let _ = HashMap::<String, String>::new();
    }

    /// 展开型脚本：裸命令要被子命令替换掉，重复导入不重复生成
    #[test]
    fn expansion_replaces_bare_script_command() {
        let d = tmpdir("fla_npm_expand");
        let mut p = project_at(&d);
        let scripts = vec![("tauri".to_string(), "tauri".to_string())];

        // 第一步：没有展开信息时，退化成一条裸命令（老行为）
        merge_into(&mut p, &scripts, Manager::Npm, &HashMap::new());
        assert!(
            p.commands
                .iter()
                .any(|c| c.source.as_deref() == Some("npm") && c.args == vec!["run", "tauri"]),
            "没有展开信息时应保留裸命令"
        );

        // 第二步：拿到展开信息 → 裸命令消失，换成一堆子命令
        let sub = |label: &str, tail: &[&str], kind: &str| Command {
            id: crate::model::make_id("npm", label),
            name: label.to_string(),
            kind: kind.to_string(),
            program: Some("npm".to_string()),
            cwd: None,
            flutter_mode: None,
            args: vec!["run", "tauri", "--"]
                .into_iter()
                .chain(tail.iter().copied())
                .map(|s| s.to_string())
                .collect(),
            env: Default::default(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("npm".to_string()),
            scope: Some("project".to_string()),
            stale: false,
            group: None,
            role: None,
            category: None,
        };
        let expanded: HashMap<String, Vec<Command>> = HashMap::from([(
            "tauri".to_string(),
            vec![
                sub("tauri dev", &["dev"], "run"),
                sub("tauri build", &["build"], "build"),
            ],
        )]);

        let out = merge_into(&mut p, &scripts, Manager::Npm, &expanded);
        assert_eq!(out.added.len(), 2);
        assert!(
            !p.commands.iter().any(|c| c.args == vec!["run", "tauri"]),
            "裸命令应被移除"
        );
        assert!(p.commands.iter().any(|c| c.name == "tauri dev"));
        assert!(p.commands.iter().any(|c| c.name == "tauri build"));

        // 再导入一次：不重复生成，也不误标 stale
        let out2 = merge_into(&mut p, &scripts, Manager::Npm, &expanded);
        assert!(out2.added.is_empty(), "第二次不该再加");
        assert!(out2.stale.is_empty(), "脚本还在，不该标失效");
        assert_eq!(
            p.commands.iter().filter(|c| c.name == "tauri dev").count(),
            1,
            "不能重复追加"
        );

        let _ = std::fs::remove_dir_all(&d);
    }
}



