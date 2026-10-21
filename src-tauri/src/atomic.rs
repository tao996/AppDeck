//! 原子写文件：先写唯一临时文件，再改名覆盖。

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 把 `data` 原子地写到 `path`。
///
/// 两个要点：
///
/// 1. **临时文件名带 pid + 纳秒**。原来固定叫 `xxx.tmp`，两个实例（或并行测试）
///    同时保存会写同一个临时文件，互相截断。
/// 2. **直接 rename 覆盖，不要"先删后改名"**。Rust 的 `fs::rename` 在 Windows 上
///    走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，本身就能替换已存在的目标；
///    先 `remove_file` 再 `rename` 会留下"目标文件不存在"的窗口，
///    这期间断电/崩溃就把配置丢了（只剩一个 .tmp）。
pub fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("tmp-{}-{stamp}", std::process::id()));

    fs::write(&tmp, data).map_err(|e| format!("写入临时文件失败: {e}"))?;

    if let Err(e) = fs::rename(&tmp, path) {
        // 失败别把临时文件留在目录里
        let _ = fs::remove_file(&tmp);
        return Err(format!("落盘失败: {e}"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::write_atomic;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn overwrites_in_place_without_leaving_temp_files() {
        let dir = tmp_dir("fla_atomic");
        let target = dir.join("state.json");

        write_atomic(&target, "{\"v\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"v\":1}");

        // 覆盖写入：目标始终存在（不存在"先删后改名"的空窗）
        write_atomic(&target, "{\"v\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"v\":2}");

        // 目录里只应该剩下目标文件，临时文件都被改名走了
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "state.json")
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writes_do_not_clobber_each_other() {
        let dir = tmp_dir("fla_atomic_parallel");
        let target = dir.join("state.json");

        let mut handles = Vec::new();
        for i in 0..8 {
            let t = target.clone();
            handles.push(std::thread::spawn(move || {
                for _ in 0..20 {
                    write_atomic(&t, &format!("{{\"i\":{i}}}")).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        // 最终内容必须是某一次完整写入的结果，不能是半个 JSON
        let raw = std::fs::read_to_string(&target).unwrap();
        assert!(
            raw.starts_with("{\"i\":") && raw.ends_with('}'),
            "内容被截断: {raw}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
