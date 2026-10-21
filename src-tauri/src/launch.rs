use crate::jsonc;
use crate::model::{make_id, Command};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct ImportOutcome {
    pub commands: Vec<Command>,
    pub total: usize,
    pub imported: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
}

fn to_string_list(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| match x {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    Value::Bool(b) => Some(b.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 解析 `<workspace>/.vscode/launch.json`。
///
/// 关键：`cwd` 相对的是**工作区根**（`.vscode` 的父目录），不是 `.vscode` 目录本身。
pub fn import(workspace: &Path) -> Result<ImportOutcome, String> {
    let file = workspace.join(".vscode").join("launch.json");
    if !file.exists() {
        return Err(format!("未找到 {}", file.display()));
    }

    let raw = fs::read_to_string(&file).map_err(|e| format!("读取 launch.json 失败: {e}"))?;
    let cleaned = jsonc::strip(&raw);
    let root: Value =
        serde_json::from_str(&cleaned).map_err(|e| format!("launch.json 解析失败: {e}"))?;

    let configs = root
        .get("configurations")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    let total = configs.len();
    let mut commands: Vec<Command> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut skipped = 0usize;

    for cfg in configs {
        let ty = cfg.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if ty != "dart" {
            skipped += 1;
            continue;
        }
        let req = cfg
            .get("request")
            .and_then(|x| x.as_str())
            .unwrap_or("launch");
        if req != "launch" {
            skipped += 1;
            continue;
        }

        let name = cfg
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("未命名")
            .to_string();

        let cwd_raw = cfg.get("cwd").and_then(|x| x.as_str());
        let cwd = cwd_raw.map(|s| s.replace('/', "\\"));

        let key = format!("{}|{}", name, cwd.clone().unwrap_or_default());
        if !seen.insert(key.clone()) {
            continue;
        }

        // 校验 cwd 指向的确实是一个 Flutter 应用
        match &cwd {
            Some(c) => {
                let dir = workspace.join(c);
                if !dir.is_dir() {
                    warnings.push(format!("「{name}」的 cwd 目录不存在：{c}"));
                } else if !dir.join("pubspec.yaml").exists() {
                    warnings.push(format!("「{name}」的 cwd 缺少 pubspec.yaml：{c}"));
                }
            }
            None => warnings.push(format!("「{name}」未指定 cwd，将使用工作区根目录")),
        }

        let env = cfg
            .get("env")
            .and_then(|e| e.as_object())
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect::<HashMap<String, String>>()
            })
            .unwrap_or_default();

        commands.push(Command {
            id: make_id("cmd", &key),
            name,
            kind: "run".to_string(),
            program: cfg
                .get("program")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            cwd,
            flutter_mode: cfg
                .get("flutterMode")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            args: cfg.get("args").map(to_string_list).unwrap_or_default(),
            env,
            tool_args: cfg.get("toolArgs").map(to_string_list).unwrap_or_default(),
            device_id: cfg
                .get("deviceId")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            emulator_id: cfg
                .get("emulatorId")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            build_type: None,
            source: Some("launch-json".to_string()),
            scope: Some("project".to_string()),
            stale: false,
            group: None,
            role: None,
        });
    }

    let imported = commands.len();
    Ok(ImportOutcome {
        commands,
        total,
        imported,
        skipped,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::import;
    use std::path::Path;

    /// 针对真实 monorepo 工作区的集成校验（素材不存在时自动跳过）。
    /// 该 launch.json 含大量行注释、块注释与中文，是 JSONC 解析的最好试金石。
    #[test]
    fn imports_real_monorepo_workspace() {
        let ws = Path::new(r"D:\demo\code\flutter\library");
        if !ws.join(".vscode").join("launch.json").exists() {
            eprintln!("跳过：测试素材不存在");
            return;
        }

        let out = import(ws).expect("导入应成功");

        // 该文件有 15 个配置对象，其中生效的 dart launch 配置为 9 个
        assert!(out.imported >= 9, "应导入至少 9 条，实际 {}", out.imported);
        assert_eq!(out.skipped, 0, "不应有被跳过的非 dart 配置");

        // 每条命令的 cwd 都应指向真实存在且含 pubspec.yaml 的目录 → 无告警
        assert!(
            out.warnings.is_empty(),
            "不应有告警，实际：{:?}",
            out.warnings
        );

        // cwd 必须相对「工作区根」解析
        let days = out
            .commands
            .iter()
            .find(|c| c.name == "days")
            .expect("应包含 days");
        assert_eq!(days.cwd.as_deref(), Some(r"projects\days"));
        assert!(ws.join(days.cwd.clone().unwrap()).join("pubspec.yaml").exists());

        // 带 flutterMode / args 的配置应被保留
        let cn = out
            .commands
            .iter()
            .find(|c| c.name == "jbook (国内 APK)")
            .expect("应包含 jbook (国内 APK)");
        assert_eq!(cn.flutter_mode.as_deref(), Some("release"));
        assert_eq!(cn.args, vec!["--dart-define=APP_CHANNEL=cn"]);

        // 同名不同参数的配置不能被去重掉
        assert!(out.commands.iter().any(|c| c.name == "jbook (Mock Play)"));
        assert!(out.commands.iter().any(|c| c.name == "jbook (Google Play)"));
    }
}



