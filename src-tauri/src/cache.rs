//! 轻量 JSON 缓存文件的读写。
//!
//! 平台矩阵与模拟器列表的分析成本都不低（数秒），且结果在用户主动
//! 「重新分析 / ⟳ 刷新」之前不该变化。缓存放磁盘，跨重启有效。
//!
//! 损坏时**静默当作空**：缓存丢了只是重新分析一次，不值得打断用户。

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn path_of(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("cache.json"))
}

pub fn load<T: DeserializeOwned + Default>(path: &Path) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<T>(&s).ok())
        .unwrap_or_default()
}

pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    // 临时名按目标派生，避免并发互相覆盖
    let tmp = path.with_extension("tmp");
    let data = serde_json::to_string(value).map_err(|e| format!("序列化缓存失败: {e}"))?;
    fs::write(&tmp, data).map_err(|e| format!("写入缓存失败: {e}"))?;

    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("缓存落盘失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Serialize, Deserialize, Default, PartialEq, Debug)]
    struct Sample {
        a: u32,
        b: Vec<String>,
    }

    #[test]
    fn roundtrip_and_corruption_is_empty() {
        let path = std::env::temp_dir().join("fla_cache_probe.json");
        let _ = fs::remove_file(&path);

        let v = Sample {
            a: 7,
            b: vec!["x".into()],
        };
        save(&path, &v).unwrap();
        assert_eq!(load::<Sample>(&path), v);

        // 损坏 → 返回默认值，不 panic
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load::<Sample>(&path), Sample::default());

        let _ = fs::remove_file(&path);
    }
}
