//! 项目目录里"能直接编辑"的配置文件探测。
//!
//! 只看文件是否存在，不解析内容——解析是导入流程的事。
//! 右键菜单据此决定显不显示「编辑 …」。

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    pub package_json: Option<String>,
    /// compose 文件的完整路径（名字可能是 .yml / .yaml / compose.*）
    pub compose: Option<String>,
}

/// compose 文件的候选名，按优先级排列。
/// `docker compose` 2.x 官方推荐 `compose.yaml`，但老项目多是 `docker-compose.yml`。
pub const COMPOSE_NAMES: &[&str] = &[
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
];

pub fn detect(dir: &Path) -> ProjectFiles {
    let pkg = dir.join("package.json");
    let compose = COMPOSE_NAMES
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file());

    ProjectFiles {
        package_json: pkg.is_file().then(|| pkg.display().to_string()),
        compose: compose.map(|p: PathBuf| p.display().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fla_pfiles_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_both_files() {
        let dir = temp_dir("both");
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("docker-compose.yml"), "services: {}").unwrap();

        let f = detect(&dir);
        assert!(f.package_json.is_some());
        assert!(f.compose.unwrap().ends_with("docker-compose.yml"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prefers_yml_over_yaml() {
        let dir = temp_dir("prefer");
        std::fs::write(dir.join("docker-compose.yml"), "a").unwrap();
        std::fs::write(dir.join("docker-compose.yaml"), "b").unwrap();

        let f = detect(&dir);
        assert!(
            f.compose.unwrap().ends_with("docker-compose.yml"),
            "候选优先级：docker-compose.yml 在前"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn falls_back_to_compose_yaml() {
        let dir = temp_dir("compose2");
        std::fs::write(dir.join("compose.yaml"), "services: {}").unwrap();

        let f = detect(&dir);
        assert!(f.compose.unwrap().ends_with("compose.yaml"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_dir_has_nothing() {
        let dir = temp_dir("empty");
        let f = detect(&dir);
        assert!(f.package_json.is_none());
        assert!(f.compose.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
