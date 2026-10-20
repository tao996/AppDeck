use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command as PCommand;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlutterInfo {
    pub ok: bool,
    pub version: Option<String>,
    pub channel: Option<String>,
    pub dart: Option<String>,
    pub executable: Option<String>,
    /// fvm | custom | path | none
    pub source: String,
    /// `.fvmrc` 里声明的 flutter 版本别名（如 "harmony" / "3.24.5"）。
    /// 即使 SDK 不在 `.fvm/flutter_sdk`，也能据此在界面上标注这是 FVM 工程。
    pub fvm_version: Option<String>,
    pub error: Option<String>,
}

#[cfg(windows)]
pub fn hide_console(cmd: &mut PCommand) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_cmd: &mut PCommand) {}

fn flutter_bin_name() -> &'static str {
    if cfg!(windows) {
        "flutter.bat"
    } else {
        "flutter"
    }
}

fn is_script(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if e == "bat" || e == "cmd"
    )
}

/// PATH 中查找 flutter，优先可执行封装（.bat/.exe/.cmd）
fn which_flutter() -> Option<PathBuf> {
    let out = if cfg!(windows) {
        let mut c = PCommand::new("where");
        c.arg("flutter");
        hide_console(&mut c);
        c.output().ok()?
    } else {
        let mut c = PCommand::new("which");
        c.arg("flutter");
        hide_console(&mut c);
        c.output().ok()?
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let candidates: Vec<PathBuf> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();

    // 优先取 .bat/.cmd/.exe，避免拿到 bash 脚本
    candidates
        .iter()
        .find(|p| is_script(p) || p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")))
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

fn normalize_custom(custom: &str) -> Option<PathBuf> {
    let p = PathBuf::from(custom.trim());
    if p.is_dir() {
        let cand = p.join("bin").join(flutter_bin_name());
        if cand.exists() {
            return Some(cand);
        }
        return None;
    }
    if p.exists() {
        return Some(p);
    }
    None
}

/// 解析项目的 Flutter 可执行文件。优先级：FVM junction > 自定义 > PATH
pub fn resolve(project: &Path, custom: Option<&str>) -> (Option<PathBuf>, String) {
    let fvm = project
        .join(".fvm")
        .join("flutter_sdk")
        .join("bin")
        .join(flutter_bin_name());
    if fvm.exists() {
        return (Some(fvm), "fvm".to_string());
    }

    if let Some(c) = custom.filter(|c| !c.trim().is_empty()) {
        if let Some(p) = normalize_custom(c) {
            return (Some(p), "custom".to_string());
        }
    }

    if let Some(p) = which_flutter() {
        return (Some(p), "path".to_string());
    }

    (None, "none".to_string())
}

fn token_after<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    let i = s.find(key)?;
    let rest = &s[i + key.len()..];
    let t = rest
        .split(|c: char| c == '•' || c == '\n' || c == '\r' || c.is_whitespace())
        .find(|t| !t.is_empty())?;
    Some(t)
}

#[cfg(windows)]
fn win_quote(a: &str) -> String {
    if a.is_empty() {
        return "\"\"".to_string();
    }
    if a.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", a.replace('"', "\"\""))
    } else {
        a.to_string()
    }
}

/// 构造调用命令。
///
/// Windows 上 `CreateProcess` 无法直接执行 `.bat` / `.cmd`，必须经 `cmd.exe`。
/// 而 Rust 的 `Command` 会把参数里的引号转义成 `\"`，cmd.exe **不认**这种转义
/// （实测会报 “不是内部或外部命令”）。因此这里用 `raw_arg` 直接拼接命令尾，
/// 采用 cmd 的标准形式：`cmd.exe /d /s /c ""C:\path\flutter.bat" --args"`。
pub fn build_command(exe: &Path, args: &[&str]) -> PCommand {
    #[cfg(windows)]
    {
        if is_script(exe) {
            use std::os::windows::process::CommandExt;
            let mut c = PCommand::new("cmd.exe");
            c.arg("/d").arg("/s").arg("/c");

            let mut line = format!("\"{}\"", exe.display());
            for a in args {
                line.push(' ');
                line.push_str(&win_quote(a));
            }
            c.raw_arg(format!("\"{line}\""));
            return c;
        }
    }

    let mut c = PCommand::new(exe);
    for a in args {
        c.arg(a);
    }
    c
}

/// 读 `.fvmrc` 里声明的 flutter 版本（如 "harmony" / "3.24.5"）。
///
/// 有些工程只用 `.fvmrc` 指定版本、并不在项目内放 `.fvm/flutter_sdk`
/// （SDK 走 FVM 全局缓存），这种情况也要能标注成 FVM 工程。
pub fn fvm_declared(project: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(project.join(".fvmrc")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("flutter")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn detect(project: &Path, custom: Option<&str>) -> FlutterInfo {
    let (exe, source) = resolve(project, custom);
    let Some(exe) = exe else {
        return FlutterInfo {
            source,
            error: Some("未找到 flutter 可执行文件，请在设置中指定路径".to_string()),
            ..Default::default()
        };
    };

    let args = ["--version", "--suppress-analytics"];
    let mut cmd = build_command(&exe, &args);
    hide_console(&mut cmd);

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            return FlutterInfo {
                source,
                executable: Some(exe.display().to_string()),
                error: Some(format!("启动失败: {e}")),
                ..Default::default()
            }
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{stdout}\n{stderr}");

    if !output.status.success() && stdout.trim().is_empty() {
        return FlutterInfo {
            source,
            executable: Some(exe.display().to_string()),
            error: Some(format!("退出码 {:?}：{}", output.status.code(), stderr.trim())),
            ..Default::default()
        };
    }

    let version = token_after(&combined, "Flutter ").map(|s| s.to_string());
    let channel = token_after(&combined, "channel ").map(|s| s.to_string());
    let dart = token_after(&combined, "Dart ").map(|s| s.to_string());

    FlutterInfo {
        ok: version.is_some(),
        version,
        channel,
        dart,
        executable: Some(exe.display().to_string()),
        source,
        fvm_version: fvm_declared(project),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::detect;
    use std::path::Path;

    /// 真实环境探测：验证 PATH 解析 + `cmd /d /s /c` 调用 `.bat` + 版本解析。
    /// 无 Flutter 的机器上直接跳过。
    #[test]
    fn detects_flutter_from_path() {
        let info = detect(Path::new("."), None);

        if info.source == "none" {
            eprintln!("跳过：本机未找到 flutter");
            return;
        }

        assert!(info.ok, "探测失败：{:?}", info.error);
        let version = info.version.unwrap_or_default();
        assert!(
            version.split('.').count() >= 2,
            "版本号格式异常：{version}"
        );
        assert_eq!(info.channel.as_deref(), Some("stable"));
        assert!(info.dart.is_some(), "应解析出 Dart 版本");
    }
}




