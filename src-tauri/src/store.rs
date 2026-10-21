use crate::model::State;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 应用标识。TAURI 的 `app_config_dir()` 就是 `%APPDATA%\<identifier>`，
/// 所以这里必须和 `tauri.conf.json` 的 identifier 保持一致。
pub const APP_ID: &str = "cn.gu19.appdev";

/// 改 identifier 之前的老目录：首次启动时把数据搬过来，
/// 否则用户会以为"项目全丢了"（其实还在老目录里躺着）。
const LEGACY_APP_ID: &str = "com.flutterlauncher.app";

/// 老目录 → 新目录的一次性迁移。只在「新目录没有 state.json 且老目录有」时执行。
pub fn migrate_legacy_dir(app: &AppHandle) -> Option<String> {
    let new_dir = app.path().app_config_dir().ok()?;
    let old_dir = new_dir.parent()?.join(LEGACY_APP_ID);

    if new_dir == old_dir || new_dir.join("state.json").exists() {
        return None;
    }
    if !old_dir.join("state.json").exists() {
        return None;
    }

    fs::create_dir_all(&new_dir).ok()?;
    for name in ["state.json", "sessions.json", "cache.json"] {
        let from = old_dir.join(name);
        if from.is_file() {
            let _ = fs::copy(&from, new_dir.join(name));
        }
    }

    // shims 里有按项目生成的 flutter.bat，一并搬
    let old_shims = old_dir.join("shims");
    if old_shims.is_dir() {
        copy_dir(&old_shims, &new_dir.join("shims"));
    }

    Some(format!(
        "已从旧目录迁移配置：{} → {}",
        old_dir.display(),
        new_dir.display()
    ))
}

fn copy_dir(from: &Path, to: &Path) {
    let _ = fs::create_dir_all(to);
    let Ok(entries) = fs::read_dir(from) else { return };
    for entry in entries.flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir(&src, &dst);
        } else {
            let _ = fs::copy(&src, &dst);
        }
    }
}

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

/// 原子落盘：唯一临时文件 + 直接改名覆盖（不留"文件不存在"的窗口）。
pub fn save_to(path: &Path, state: &State) -> Result<(), String> {
    let data = serde_json::to_string_pretty(state).map_err(|e| format!("序列化失败: {e}"))?;
    crate::atomic::write_atomic(path, &data)
}

pub fn load(app: &AppHandle) -> Result<State, String> {
    Ok(load_from(&path_of(app)?))
}

pub fn save(app: &AppHandle, state: &State) -> Result<(), String> {
    save_to(&path_of(app)?, state)
}
