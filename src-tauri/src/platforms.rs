//! 平台 → 动作 的派生层。
//!
//! 一个动作 = 平台 + 动作类型（debug / profile / build）+ 构建目标（build 时）。
//! 这些**不落盘**：能派生的东西就不要存成命令，否则跨平台就得重新配一遍。
//!
//! 可用性 = 项目有该平台目录 ∧ 宿主的 flutter 能构建该平台 ∧（运行类）有对应设备。
//! 宿主支持度由 `flutter build --help` 的目标列表推导，不硬编码。

use crate::daemon::DeviceInfo;
use crate::model::Project;
use serde::Serialize;
use std::path::Path;

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAction {
    /// debug | profile | release | build
    pub action: String,
    /// 菜单里直接显示的真实命令，如 `flutter run --debug`
    pub command: String,
    /// 中文简短说明
    pub label: String,
    /// build 时的构建目标（apk / appbundle / web / …）
    pub target: Option<String>,
    pub enabled: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformEntry {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub reason: Option<String>,
    pub actions: Vec<PlatformAction>,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlatformMatrix {
    pub platforms: Vec<PlatformEntry>,
    /// 工作区项目不提供平台菜单
    pub supported: bool,
    pub note: Option<String>,
}

struct Def {
    id: &'static str,
    label: &'static str,
    dir: &'static str,
    targets: &'static [&'static str],
}

const DEFS: &[Def] = &[
    Def {
        id: "android",
        label: "Android",
        dir: "android",
        targets: &["apk", "appbundle", "aar"],
    },
    Def {
        id: "ios",
        label: "iOS",
        dir: "ios",
        targets: &["ios", "ipa"],
    },
    Def {
        id: "web",
        label: "Web",
        dir: "web",
        targets: &["web"],
    },
    Def {
        id: "windows",
        label: "Windows",
        dir: "windows",
        targets: &["windows"],
    },
    Def {
        id: "linux",
        label: "Linux",
        dir: "linux",
        targets: &["linux"],
    },
    Def {
        id: "macos",
        label: "macOS",
        dir: "macos",
        targets: &["macos"],
    },
];

pub fn label_of(platform: &str) -> &'static str {
    DEFS.iter()
        .find(|d| d.id == platform)
        .map(|d| d.label)
        .unwrap_or("未知平台")
}

pub fn target_label(target: &str) -> &'static str {
    match target {
        "apk" => "构建 APK",
        "appbundle" => "构建 AAB",
        "aar" => "构建 AAR",
        "ios" => "构建 iOS App",
        "ipa" => "构建 IPA",
        "web" => "构建 Web",
        "windows" => "构建 Windows",
        "linux" => "构建 Linux",
        "macos" => "构建 macOS",
        _ => "构建",
    }
}

/// 把设备归到平台。优先用 daemon 的 platformType，其次 category / id 兜底。
fn classify(d: &DeviceInfo) -> Option<&'static str> {
    let mut s = String::new();
    for part in [&d.platform_type, &d.platform, &d.category] {
        if let Some(p) = part {
            s.push_str(p);
            s.push(' ');
        }
    }
    s.push_str(&d.id);
    let s = s.to_lowercase();

    if s.contains("android") {
        Some("android")
    } else if s.contains("ios") {
        Some("ios")
    } else if s.contains("web") {
        Some("web")
    } else if s.contains("windows") {
        Some("windows")
    } else if s.contains("macos") || s.contains("darwin") {
        Some("macos")
    } else if s.contains("linux") {
        Some("linux")
    } else {
        None
    }
}

/// 该平台下第一个可用设备
pub fn device_for<'a>(devices: &'a [DeviceInfo], platform: &str) -> Option<&'a DeviceInfo> {
    devices
        .iter()
        .find(|d| classify(d) == Some(platform) && d.is_connected.unwrap_or(true))
}

pub fn matrix(
    project: &Project,
    host_targets: &[String],
    devices: &[DeviceInfo],
    device_error: Option<String>,
) -> PlatformMatrix {
    if project.kind != "single" {
        return PlatformMatrix {
            platforms: Vec::new(),
            supported: false,
            note: Some(
                "工作区项目由子应用决定平台；请用命令右侧的设备菜单运行，或把子应用单独添加为项目"
                    .to_string(),
            ),
        };
    }

    let root = Path::new(&project.path);
    let mut entries: Vec<(usize, PlatformEntry)> = Vec::new();

    for (idx, def) in DEFS.iter().enumerate() {
        let has_dir = root.join(def.dir).is_dir();
        let missing_dir = || format!("项目缺少 {}/ 目录", def.dir);

        let host_ok: Vec<&str> = def
            .targets
            .iter()
            .copied()
            .filter(|t| host_targets.iter().any(|h| h == t))
            .collect();
        let host_supported = !host_ok.is_empty();

        let has_device = device_for(devices, def.id).is_some();

        let mut actions: Vec<PlatformAction> = Vec::new();

        // 运行类：debug / profile / release（三种 run 模式，菜单里直接显示真实命令）
        for (act, label, command) in [
            ("debug", "调试运行", "flutter run --debug"),
            ("profile", "性能分析运行", "flutter run --profile"),
            ("release", "发布模式运行（不打包）", "flutter run --release"),
        ] {
            let (enabled, reason) = if !has_dir {
                (false, Some(missing_dir()))
            } else if !host_supported {
                (false, Some("当前宿主的 flutter 不支持该平台".to_string()))
            } else if let Some(e) = &device_error {
                (false, Some(format!("无法获取设备列表：{e}")))
            } else if !has_device {
                (false, Some("没有可用设备（可先启动模拟器）".to_string()))
            } else {
                (true, None)
            };
            actions.push(PlatformAction {
                action: act.to_string(),
                command: command.to_string(),
                label: label.to_string(),
                target: None,
                enabled,
                reason,
            });
        }

        // 构建类：每个目标一项
        for t in def.targets {
            let supported_target = host_ok.contains(t);
            let (enabled, reason) = if !has_dir {
                (false, Some(missing_dir()))
            } else if !supported_target {
                (false, Some(format!("当前宿主的 flutter 不支持 build {t}")))
            } else {
                (true, None)
            };
            actions.push(PlatformAction {
                action: "build".to_string(),
                command: format!("flutter build {t} --release"),
                label: target_label(t).to_string(),
                target: Some((*t).to_string()),
                enabled,
                reason,
            });
        }

        let enabled = actions.iter().any(|a| a.enabled);
        let reason = if enabled {
            None
        } else if !has_dir {
            Some(missing_dir())
        } else if !host_supported {
            Some("当前宿主的 flutter 不支持该平台".to_string())
        } else {
            None
        };

        entries.push((
            idx,
            PlatformEntry {
                id: def.id.to_string(),
                label: def.label.to_string(),
                enabled,
                reason,
                actions,
            },
        ));
    }

    // 可用的排前面，其余保持原顺序
    entries.sort_by_key(|(idx, e)| (!e.enabled, *idx));

    PlatformMatrix {
        platforms: entries.into_iter().map(|(_, e)| e).collect(),
        supported: true,
        note: None,
    }
}

/// 动作 → flutter 参数。返回 (args, 动作显示名, 会话 kind)
pub fn args_for(
    platform: &str,
    action: &str,
    target: Option<&str>,
    device_id: Option<&str>,
) -> Result<(Vec<String>, String, &'static str), String> {
    match action {
        "debug" | "profile" | "release" => {
            let dev = device_id.ok_or_else(|| "没有可用设备".to_string())?;
            let mut args = vec!["run".to_string()];
            let label = match action {
                "profile" => {
                    args.push("--profile".to_string());
                    "性能分析运行"
                }
                "release" => {
                    args.push("--release".to_string());
                    "发布模式运行（不打包）"
                }
                _ => {
                    args.push("--debug".to_string());
                    "调试运行"
                }
            };
            args.push("-d".to_string());
            args.push(dev.to_string());
            Ok((args, label.to_string(), "run"))
        }
        "build" => {
            let t = target.ok_or_else(|| "构建动作缺少目标".to_string())?;
            let known = DEFS
                .iter()
                .find(|d| d.id == platform)
                .map(|d| d.targets.contains(&t))
                .unwrap_or(false);
            if !known {
                return Err(format!("平台 {platform} 不支持构建目标 {t}"));
            }
            Ok((
                vec!["build".to_string(), t.to_string(), "--release".to_string()],
                target_label(t).to_string(),
                "build",
            ))
        }
        other => Err(format!("未知动作：{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Project;

    fn project(kind: &str, path: &str) -> Project {
        Project {
            id: "p1".into(),
            name: "demo".into(),
            path: path.into(),
            kind: kind.into(),
            flutter_tool: None,
            commands: vec![],
        }
    }

    fn device(id: &str, platform_type: &str) -> DeviceInfo {
        DeviceInfo {
            id: id.into(),
            name: id.into(),
            platform: None,
            platform_type: Some(platform_type.into()),
            category: None,
            emulator: false,
            sdk: None,
            is_connected: Some(true),
        }
    }

    #[test]
    fn windows_host_only_supports_android_web_windows() {
        let targets: Vec<String> = ["aar", "apk", "appbundle", "bundle", "web", "windows"]
            .iter()
            .map(|s| s.to_string())
            .collect();

        let dir = std::env::temp_dir().join("fla_platform_probe");
        for d in ["android", "ios", "web", "windows", "linux", "macos"] {
            let _ = std::fs::create_dir_all(dir.join(d));
        }

        let devices = vec![
            device("windows", "windows-x64"),
            device("chrome", "web-javascript"),
            device("emulator-5554", "android-x64"),
        ];

        let m = matrix(
            &project("single", dir.to_str().unwrap()),
            &targets,
            &devices,
            None,
        );

        assert!(m.supported);

        let get = |id: &str| m.platforms.iter().find(|p| p.id == id).unwrap();

        // 目录齐全，所以可用性完全取决于宿主
        assert!(get("android").enabled, "Windows 能构建 android");
        assert!(get("web").enabled);
        assert!(get("windows").enabled);
        assert!(!get("linux").enabled, "Windows 不能构建 linux");
        assert!(!get("ios").enabled, "Windows 不能构建 ios");
        assert!(!get("macos").enabled);

        // android 有三个构建目标
        let android_builds: Vec<_> = get("android")
            .actions
            .iter()
            .filter(|a| a.action == "build")
            .collect();
        assert_eq!(android_builds.len(), 3);

        let android_runs: Vec<_> = get("android")
            .actions
            .iter()
            .filter(|a| a.action != "build")
            .collect();
        assert_eq!(android_runs.len(), 3, "应有 debug / profile / release 三种运行");
        assert!(android_runs
            .iter()
            .any(|a| a.command == "flutter run --release"));
        assert!(android_runs
            .iter()
            .any(|a| a.command == "flutter run --debug"));
        assert!(android_builds
            .iter()
            .any(|a| a.command == "flutter build apk --release"));
        assert!(android_builds.iter().all(|a| a.enabled));

        // 没有 linux 设备 + 宿主不支持 → 全部不可用
        assert!(get("linux").actions.iter().all(|a| !a.enabled));

        // 可用平台排在前面
        let first_disabled = m.platforms.iter().position(|p| !p.enabled).unwrap();
        assert!(m.platforms[..first_disabled].iter().all(|p| p.enabled));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dir_disables_platform() {
        let dir = std::env::temp_dir().join("fla_platform_nodir");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("web")).unwrap();

        let targets: Vec<String> = ["apk", "web", "windows"].iter().map(|s| s.to_string()).collect();
        let m = matrix(
            &project("single", dir.to_str().unwrap()),
            &targets,
            &[device("chrome", "web-javascript")],
            None,
        );

        let web = m.platforms.iter().find(|p| p.id == "web").unwrap();
        assert!(web.enabled);

        let android = m.platforms.iter().find(|p| p.id == "android").unwrap();
        assert!(!android.enabled);
        assert!(
            android.reason.as_deref().unwrap_or("").contains("android/"),
            "应说明缺目录：{:?}",
            android.reason
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_has_no_platform_menu() {
        let m = matrix(&project("workspace", "D:\\nope"), &[], &[], None);
        assert!(!m.supported);
        assert!(m.platforms.is_empty());
        assert!(m.note.is_some());
    }

    #[test]
    fn builds_run_actions_and_targets() {
        let (args, label, kind) = args_for("android", "profile", None, Some("emulator-5554")).unwrap();
        assert_eq!(args, vec!["run", "--profile", "-d", "emulator-5554"]);
        assert_eq!(label, "性能分析运行");
        assert_eq!(kind, "run");

        // release 运行（不打包）——之前漏了这一项
        let (args, label, kind) = args_for("android", "release", None, Some("windows")).unwrap();
        assert_eq!(args, vec!["run", "--release", "-d", "windows"]);
        assert!(label.contains("发布模式"));
        assert_eq!(kind, "run");

        let (args, label, kind) = args_for("android", "build", Some("appbundle"), None).unwrap();
        assert_eq!(args, vec!["build", "appbundle", "--release"]);
        assert_eq!(label, "构建 AAB");
        assert_eq!(kind, "build");

        // 平台不支持的组合要报错
        assert!(args_for("web", "build", Some("apk"), None).is_err());
        assert!(args_for("android", "debug", None, None).is_err());
    }
}

