//! docker-compose 导入：解析 `services` → 每个服务生成命令。
//!
//! 与 npm 的差异：一条 compose 文件里有**多个 service**，所以不是"一条脚本一条命令"，
//! 而是每个服务生成 2 条（up / logs），整份文件再加 1 条 down。
//!
//! 命令身份靠**确定性 id**（`make_id("docker", "{action}|{service}")`）：
//! 重新导入时按 id 判断是"已存在"还是"新增"，服务被删掉则标 stale（不删数据）。

use crate::model::{make_id, Command, Project};
use std::path::{Path, PathBuf};

/// compose 文件的常见名字，按优先级
pub const COMPOSE_NAMES: [&str; 4] = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
];

#[derive(Debug, Clone)]
pub struct Service {
    pub name: String,
    pub image: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Compose {
    pub file: PathBuf,
    pub services: Vec<Service>,
}

/// 在目录里找一个 compose 文件
pub fn find_compose(dir: &Path) -> Option<PathBuf> {
    COMPOSE_NAMES
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file())
}

/// compose 的调用前缀：v2 是 `docker compose`，v1 是 `docker-compose`
///
/// 返回 (program, 前置参数)。
pub fn compose_prefix(docker: &str, style: Option<&str>) -> (String, Vec<String>) {
    match style.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("v1") => ("docker-compose".to_string(), Vec::new()),
        Some("v2") => (docker.to_string(), vec!["compose".to_string()]),
        // auto：优先 v2（新版 Docker Desktop 都带），失败时由用户改设置
        _ => (docker.to_string(), vec!["compose".to_string()]),
    }
}

/// 读取 compose 文件里的服务（只看 `services:` 下的键，够用且不会误读 anchors）
pub fn read(compose_file: &Path) -> Result<Compose, String> {
    if !compose_file.is_file() {
        return Err(format!("文件不存在：{}", compose_file.display()));
    }
    let text = std::fs::read_to_string(compose_file).map_err(|e| format!("读取失败：{e}"))?;
    let doc: serde_yaml::Value =
        serde_yaml::from_str(&text).map_err(|e| format!("YAML 解析失败：{e}"))?;

    let services = doc
        .get("services")
        .and_then(|s| s.as_mapping())
        .ok_or_else(|| "compose 文件里没有 services".to_string())?;

    let mut out: Vec<Service> = services
        .iter()
        .filter_map(|(k, v)| {
            let name = k.as_str()?.to_string();
            let image = v
                .get("image")
                .and_then(|i| i.as_str())
                .map(|s| s.to_string());
            Some(Service { name, image })
        })
        .collect();

    out.sort_by(|a, b| a.name.cmp(&b.name));
    if out.is_empty() {
        return Err("compose 文件里 services 是空的".to_string());
    }

    Ok(Compose {
        file: compose_file.to_path_buf(),
        services: out,
    })
}

/// 生成命令集合：每个服务 up + logs，最后一条 down
pub fn commands_for(
    compose: &Compose,
    cwd: &str,
    docker: &str,
    style: Option<&str>,
) -> Vec<Command> {
    let (program, prefix) = compose_prefix(docker, style);
    let file_name = compose
        .file
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "docker-compose.yml".to_string());

    let base = |rest: &[&str]| -> Vec<String> {
        let mut a = prefix.clone();
        // 显式 -f：避免有多个 compose 文件时 Docker 自作主张挑了别的
        a.push("-f".to_string());
        a.push(file_name.clone());
        a.extend(rest.iter().map(|s| s.to_string()));
        a
    };

    let mut out = Vec::new();

    for svc in &compose.services {
        // up -d：启动后在后台，属于一次性动作
        out.push(Command {
            id: make_id("docker", &format!("up|{}", svc.name)),
            name: format!("{} · 启动", svc.name),
            kind: "custom".to_string(),
            program: Some(program.clone()),
            cwd: Some(cwd.to_string()),
            flutter_mode: None,
            args: base(&["up", "-d", &svc.name]),
            env: Default::default(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("docker".to_string()),
            scope: Some("project".to_string()),
            stale: false,
        });

        // logs -f：长时间运行
        out.push(Command {
            id: make_id("docker", &format!("logs|{}", svc.name)),
            name: format!("{} · 日志", svc.name),
            kind: "run".to_string(),
            program: Some(program.clone()),
            cwd: Some(cwd.to_string()),
            flutter_mode: None,
            args: base(&["logs", "-f", &svc.name]),
            env: Default::default(),
            tool_args: vec![],
            device_id: None,
            emulator_id: None,
            build_type: None,
            source: Some("docker".to_string()),
            scope: Some("project".to_string()),
            stale: false,
        });
    }

    // 整份文件的 down
    out.push(Command {
        id: make_id("docker", "down|*"),
        name: "全部停止".to_string(),
        kind: "custom".to_string(),
        program: Some(program),
        cwd: Some(cwd.to_string()),
        flutter_mode: None,
        args: base(&["down"]),
        env: Default::default(),
        tool_args: vec![],
        device_id: None,
        emulator_id: None,
        build_type: None,
        source: Some("docker".to_string()),
        scope: Some("project".to_string()),
        stale: false,
    });

    out
}

#[derive(Debug, Default)]
pub struct MergeOutcome {
    pub added: Vec<String>,
    pub kept: Vec<String>,
    pub stale: Vec<String>,
}

/// 按确定性 id 合并：已存在则同步（保留用户改过的 kind 以外的一切），新增则追加，
/// 本次没生成的 docker 命令标记 stale。
pub fn merge_into(project: &mut Project, fresh: Vec<Command>) -> MergeOutcome {
    let mut out = MergeOutcome::default();
    let ids: Vec<String> = fresh.iter().map(|c| c.id.clone()).collect();

    for cmd in fresh {
        match project.commands.iter_mut().find(|c| c.id == cmd.id) {
            Some(existing) => {
                // 保持用户改过的 kind / name，只同步执行细节
                existing.program = cmd.program;
                existing.args = cmd.args;
                existing.cwd = cmd.cwd;
                existing.stale = false;
                out.kept.push(cmd.name);
            }
            None => {
                out.added.push(cmd.name.clone());
                project.commands.push(cmd);
            }
        }
    }

    for c in project.commands.iter_mut() {
        if c.source.as_deref() != Some("docker") || ids.contains(&c.id) {
            continue;
        }
        if !c.stale {
            c.stale = true;
            out.stale.push(c.name.clone());
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn project_at(p: &Path) -> Project {
        Project {
            id: "p".into(),
            name: "demo".into(),
            path: p.display().to_string(),
            kind: "workspace".into(),
            flutter_tool: None,
            commands: vec![],
            env: Default::default(),
        }
    }

    const SAMPLE: &str = r#"
services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: secret
"#;

    #[test]
    fn read_parses_service_names_and_images() {
        let d = tmpdir("fla_compose_read");
        let f = d.join("docker-compose.yml");
        std::fs::write(&f, SAMPLE).unwrap();

        let c = read(&f).unwrap();
        assert_eq!(
            c.services.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["db", "web"],
            "应按名字排序"
        );
        assert_eq!(c.services[1].image.as_deref(), Some("nginx:alpine"));

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn read_rejects_file_without_services() {
        let d = tmpdir("fla_compose_empty");
        let f = d.join("docker-compose.yml");
        std::fs::write(&f, "version: '3'\n").unwrap();
        assert!(read(&f).unwrap_err().contains("services"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn commands_cover_each_service_plus_down() {
        let d = tmpdir("fla_compose_cmds");
        let f = d.join("docker-compose.yml");
        std::fs::write(&f, SAMPLE).unwrap();
        let c = read(&f).unwrap();

        let cmds = commands_for(&c, "", "docker", None);
        // 2 个服务 × 2 条 + 1 条 down
        assert_eq!(cmds.len(), 5);

        let up_web = cmds.iter().find(|x| x.name == "web · 启动").unwrap();
        assert_eq!(up_web.kind, "custom");
        assert_eq!(
            up_web.args,
            vec!["compose", "-f", "docker-compose.yml", "up", "-d", "web"],
            "v2 风格"
        );

        let logs_db = cmds.iter().find(|x| x.name == "db · 日志").unwrap();
        assert_eq!(logs_db.kind, "run", "logs -f 是长时间运行");
        assert!(logs_db.args.contains(&"logs".to_string()));
        assert!(logs_db.args.contains(&"-f".to_string()));

        let down = cmds.iter().find(|x| x.name == "全部停止").unwrap();
        assert_eq!(down.args.last().map(|s| s.as_str()), Some("down"));

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn compose_prefix_honors_style() {
        let (p, a) = compose_prefix("docker", Some("v1"));
        assert_eq!(p, "docker-compose");
        assert!(a.is_empty());

        let (p, a) = compose_prefix(r"C:\docker\docker.exe", Some("v2"));
        assert_eq!(p, r"C:\docker\docker.exe");
        assert_eq!(a, vec!["compose".to_string()]);
    }

    #[test]
    fn merge_adds_then_marks_removed_service_stale() {
        let d = tmpdir("fla_compose_merge");
        let mut p = project_at(&d);
        let f = d.join("docker-compose.yml");
        std::fs::write(&f, SAMPLE).unwrap();

        let c = read(&f).unwrap();
        let out = merge_into(&mut p, commands_for(&c, "", "docker", None));
        assert_eq!(out.added.len(), 5);
        assert_eq!(p.commands.len(), 5);

        // 再导一次：不应重复
        let out2 = merge_into(&mut p, commands_for(&c, "", "docker", None));
        assert!(out2.added.is_empty());
        assert_eq!(p.commands.len(), 5);

        // 去掉 db → db 的两条应被标 stale
        std::fs::write(
            &f,
            "services:\n  web:\n    image: nginx\n",
        )
        .unwrap();
        let c2 = read(&f).unwrap();
        let out3 = merge_into(&mut p, commands_for(&c2, "", "docker", None));
        assert_eq!(out3.stale.len(), 2, "db 的启动/日志都该失效");
        assert!(p.commands.iter().any(|x| x.name == "db · 启动"), "命令要保留");
        assert!(
            p.commands.iter().find(|x| x.name == "db · 启动").unwrap().stale,
            "应打上 stale"
        );

        let _ = std::fs::remove_dir_all(&d);
    }
}
