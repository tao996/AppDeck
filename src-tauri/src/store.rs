use crate::model::State;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn path_of(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("state.json"))
}

pub fn location(app: &AppHandle) -> String {
    path_of(app)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| e)
}

/// 读取状态。缺失 → 默认值；损坏 → 备份为 state.corrupt.json 后重置，绝不静默清空。
pub fn load_from(path: &Path) -> State {
    if !path.exists() {
        return State::default();
    }
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<State>(&raw) {
            Ok(mut s) => {
                let mut migrated = false;
                let from = s.schema_version;

                // v4：老文件补默认模板库（当前默认只剩 Pub Get）
                if from < 4 && s.command_templates.is_empty() {
                    s.command_templates = crate::model::default_templates();
                    migrated = true;
                }

                // v5：Debug / Build APK / Build Windows / Build Web 退役——
                // 它们改由「项目右键 → 平台 → 动作」动态派生，不再占项目命令。
                //
                // **幂等**：只要还残留就清理，不依赖版本号。实测踩过坑：开发期
                // `tauri dev` 自动重启，用"已升版本但还没写清理逻辑"的中间版本
                // 写过一次 state.json，导致按版本号判断的迁移永久跳过。
                let before_tpl = s.command_templates.len();
                s.command_templates
                    .retain(|t| !crate::model::RETIRED_TEMPLATE_IDS.contains(&t.id.as_str()));

                let mut pruned_cmds = 0usize;
                for p in s.projects.iter_mut() {
                    let before = p.commands.len();
                    p.commands.retain(|c| {
                        let auto = c.source.as_deref() == Some("template");
                        let retired =
                            crate::model::RETIRED_COMMAND_NAMES.contains(&c.name.as_str());
                        // 只清理由模板生成且未改名的命令；用户自己建的不受影响
                        !(auto && retired)
                    });
                    pruned_cmds += before - p.commands.len();
                }

                if s.command_templates.len() != before_tpl || pruned_cmds > 0 {
                    migrated = true;
                    eprintln!(
                        "[migrate] 退役模板 {} 条，清理项目命令 {} 条",
                        before_tpl - s.command_templates.len(),
                        pruned_cmds
                    );
                }

                s.schema_version = crate::model::SCHEMA_VERSION;

                // 迁移结果落盘，避免每次启动都重新推断（也让 state.json 版本号如实反映）
                if migrated {
                    if let Ok(text) = serde_json::to_string_pretty(&s) {
                        let _ = fs::write(path, text);
                    }
                }

                s
            }
            Err(_) => {
                let _ = fs::copy(path, path.with_file_name("state.corrupt.json"));
                State::default()
            }
        },
        Err(_) => State::default(),
    }
}

/// 原子落盘：先写临时文件，再替换。
pub fn save_to(path: &Path, state: &State) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    // 临时文件名按目标派生，避免多文件/并行写入互相覆盖
    let tmp = path.with_extension("tmp");
    let data = serde_json::to_string_pretty(state).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&tmp, data).map_err(|e| format!("写入临时文件失败: {e}"))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("落盘失败: {e}"))?;
    Ok(())
}

pub fn load(app: &AppHandle) -> Result<State, String> {
    Ok(load_from(&path_of(app)?))
}

pub fn save(app: &AppHandle, state: &State) -> Result<(), String> {
    save_to(&path_of(app)?, state)
}
