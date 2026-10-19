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

                // v4：新增命令模板库，老版本状态文件补一次默认模板
                if s.schema_version < crate::model::SCHEMA_VERSION {
                    if s.command_templates.is_empty() {
                        s.command_templates = crate::model::default_templates();
                    }
                    migrated = true;
                }

                // 新增字段由 serde default 兜底，版本号归一
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
