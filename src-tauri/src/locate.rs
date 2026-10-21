//! 把终端里出现的"位置"文本解析成磁盘上的真实文件。
//!
//! 支持三种形态（都是 `flutter run` / 构建输出里真实出现的）：
//! - `package:tao996/src/translation/translation.dart:119:7`
//! - `C:/Users/me/jbook\screenshots\a.png`（斜杠混用是真实存在的）
//! - `lib/main.dart:12:5`（相对 cwd）
//!
//! `package:` 的解析依据是 `.dart_tool/package_config.json`，
//! 从 cwd 逐级向上找——Flutter 自己也是这么定位的。

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub raw: String,
    /// 解析出的绝对路径（解析失败为 None）
    pub path: Option<String>,
    pub exists: bool,
    /// 源码类：用编辑器打开并跳到行列；否则交给系统默认程序
    pub code: bool,
    pub line: Option<u32>,
    pub col: Option<u32>,
}

/// 视为"源码"的扩展名：跳转、用编辑器打开
const CODE_EXT: &[&str] = &[
    "dart", "yaml", "yml", "json", "jsonc", "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go",
    "py", "kt", "kts", "java", "gradle", "xml", "properties", "toml", "ini", "cfg", "sh", "bat",
    "cmd", "ps1", "psm1", "sql", "html", "css", "scss", "md", "lock", "env", "txt", "log",
];

/// 解析一段位置文本。返回 None 表示"看起来不像位置"。
pub fn resolve(cwd: &Path, text: &str) -> Option<Location> {
    let raw = text.trim().to_string();
    if raw.is_empty() {
        return None;
    }

    // 去掉行尾可能粘上的标点（终端里常见 `path.txt,` `path.dart)`）
    let cleaned = raw.trim_end_matches([',', ';', '.', ')', ']', '}', '。', '，', '）']);
    let cleaned = cleaned.trim();

    // 拆尾部的 :行[:列]
    let (target, line, col) = split_line_col(cleaned);

    let path = resolve_path(cwd, target)?;
    let exists = path.is_file();
    let code = is_code_path(&path);

    Some(Location {
        raw,
        path: Some(path.display().to_string()),
        exists,
        code,
        line,
        col,
    })
}

/// `a.dart:12:5` → ("a.dart", Some(12), Some(5))
fn split_line_col(text: &str) -> (&str, Option<u32>, Option<u32>) {
    // 从尾部往前拆两段数字，注意不要吃掉 Windows 盘符的 `C:`
    let bytes = text.as_bytes();
    let mut end = bytes.len();
    let mut nums: Vec<u32> = Vec::new();

    for _ in 0..2 {
        // 跳过尾部数字
        let mut start = end;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start == end || start == 0 || bytes[start - 1] != b':' {
            break;
        }
        // 盘符（单个字母 + 冒号）不能当行号
        if start >= 2 && bytes[start - 2].is_ascii_alphabetic() && (start < 3 || bytes[start - 3] == b'/')
        {
            break;
        }
        let Ok(n) = text[start..end].parse::<u32>() else {
            break;
        };
        nums.push(n);
        end = start - 1; // 跳过冒号
    }

    let head = &text[..end];
    match nums.len() {
        0 => (head, None, None),
        1 => (head, Some(nums[0]), None),
        _ => (head, Some(nums[1]), Some(nums[0])),
    }
}

fn resolve_path(cwd: &Path, target: &str) -> Option<PathBuf> {
    if let Some(rest) = target.strip_prefix("package:") {
        return resolve_package(cwd, rest);
    }

    let normalized = target.replace('/', "\\");

    // 绝对路径：盘符 或 UNC
    if is_absolute(&normalized) {
        return Some(PathBuf::from(normalized));
    }

    // 相对路径：相对 cwd
    Some(cwd.join(normalized))
}

fn is_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\') || p.starts_with("\\\\")
}

/// `package:foo/lib/bar.dart` 的 `rest` 是 `foo/lib/bar.dart`
fn resolve_package(cwd: &Path, rest: &str) -> Option<PathBuf> {
    let (name, sub) = rest.split_once('/')?;
    let config = find_package_config(cwd)?;
    let root = package_root(&config, name)?;
    Some(root.join("lib").join(sub.replace('/', "\\")))
}

/// 从 cwd 逐级向上找 `.dart_tool/package_config.json`
fn find_package_config(cwd: &Path) -> Option<PathBuf> {
    let mut dir = Some(cwd.to_path_buf());
    while let Some(d) = dir {
        let candidate = d.join(".dart_tool").join("package_config.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    None
}

/// 在 package_config.json 里查这个包，返回包根目录（绝对路径）
fn package_root(config: &Path, name: &str) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(config).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let list = json.get("packages")?.as_array()?;

    for pkg in list {
        if pkg.get("name").and_then(|v| v.as_str()) != Some(name) {
            continue;
        }
        let root_uri = pkg.get("rootUri").and_then(|v| v.as_str())?;
        return Some(root_uri_to_path(config, root_uri));
    }
    None
}

/// rootUri 有两种写法：
/// - 绝对：`file:///D:/mydata/pub_cache/hosted/pub.dev/foo-1.0.0`
/// - 相对：`../../../packages/tao996`（相对 package_config.json 所在目录）
fn root_uri_to_path(config: &Path, root_uri: &str) -> PathBuf {
    let base = config.parent().unwrap_or_else(|| Path::new("."));

    if let Some(rest) = root_uri.strip_prefix("file://") {
        // file:///D:/x → D:/x（去掉前导斜杠）
        let p = rest.strip_prefix('/').unwrap_or(rest);
        return PathBuf::from(p.replace('/', "\\"));
    }

    let joined = base.join(root_uri.replace('/', "\\"));
    normalize(joined)
}

/// 消掉 `..` / `.`（不依赖文件是否存在）
fn normalize(p: PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_code_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| CODE_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fla_locate_{tag}"));
        let _ = std::fs::remove_dir_all(&root);

        // app/.dart_tool/package_config.json
        let app = root.join("app");
        std::fs::create_dir_all(app.join(".dart_tool")).unwrap();
        std::fs::create_dir_all(app.join("lib").join("src")).unwrap();
        std::fs::write(app.join("lib").join("main.dart"), "void main() {}").unwrap();
        std::fs::write(app.join("lib").join("src").join("a.dart"), "// a").unwrap();
        std::fs::create_dir_all(app.join("screenshots")).unwrap();
        std::fs::write(app.join("screenshots").join("shot.png"), "x").unwrap();

        // 相对 rootUri 的包：root/packages/mylib/lib/...（验证 ../.. 归一化）
        let pkg = root.join("packages").join("mylib");
        std::fs::create_dir_all(pkg.join("lib").join("src")).unwrap();
        std::fs::write(pkg.join("lib").join("src").join("util.dart"), "// util").unwrap();

        // 绝对 rootUri 的包
        let abs = root.join("abs_pkg");
        std::fs::create_dir_all(abs.join("lib")).unwrap();
        std::fs::write(abs.join("lib").join("api.dart"), "// api").unwrap();

        let abs_uri = format!("file:///{}", abs.display().to_string().replace('\\', "/"));
        let cfg = format!(
            r#"{{"configVersion":2,"packages":[
              {{"name":"app","rootUri":"../","packageUri":"lib/"}},
              {{"name":"mylib","rootUri":"../../packages/mylib","packageUri":"lib/"}},
              {{"name":"abs_pkg","rootUri":"{abs_uri}","packageUri":"lib/"}}
            ]}}"#
        );
        std::fs::write(app.join(".dart_tool").join("package_config.json"), cfg).unwrap();

        root
    }

    #[test]
    fn resolves_relative_package_uri_from_nested_dir() {
        let root = temp_project("pkg");
        let cwd = root.join("app");

        let loc = resolve(&cwd, "package:mylib/src/util.dart:12:5").expect("应能解析");
        assert!(loc.exists, "路径应存在: {:?}", loc.path);
        assert!(loc.code);
        assert_eq!(loc.line, Some(12));
        assert_eq!(loc.col, Some(5));
        assert!(loc.path.unwrap().ends_with("mylib\\lib\\src\\util.dart"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_absolute_file_uri_package() {
        let root = temp_project("abs");
        let cwd = root.join("app");

        let loc = resolve(&cwd, "package:abs_pkg/api.dart").expect("应能解析");
        assert!(loc.exists);
        assert_eq!(loc.line, None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_windows_path_with_mixed_slashes_and_position() {
        let root = temp_project("win");
        let app = root.join("app");

        already_done();
        let mut text = app.join("lib").join("main.dart").display().to_string();
        text = text.replace('\\', "/") + ":3:1";

        let loc = resolve(&root, &text).expect("应能解析");
        assert!(loc.exists, "路径应存在: {:?}", loc.path);
        assert_eq!(loc.line, Some(3));
        assert_eq!(loc.col, Some(1));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_path_and_missing_file() {
        let root = temp_project("rel");
        let app = root.join("app");

        let ok = resolve(&app, "lib/main.dart").expect("应能解析");
        assert!(ok.exists);

        let missing = resolve(&app, "lib/nope.dart:1:1").expect("解析出路径但文件不存在");
        assert!(!missing.exists);
        assert_eq!(missing.line, Some(1));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn image_is_not_code() {
        let root = temp_project("img");
        let app = root.join("app");
        let shot = app.join("screenshots").join("shot.png").display().to_string();

        let loc = resolve(&app, &shot).expect("应能解析");
        assert!(loc.exists);
        assert!(!loc.code, "png 不该被当成源码");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trailing_punctuation_is_stripped() {
        let root = temp_project("punct");
        let app = root.join("app");
        let shot = app.join("screenshots").join("shot.png").display().to_string();

        let loc = resolve(&app, &format!("{shot},")).expect("应能解析");
        assert!(loc.exists, "行尾逗号不该影响解析: {:?}", loc.path);

        let _ = std::fs::remove_dir_all(&root);
    }

    fn already_done() {}
}
