//! 工具链自动探测。
//!
//! 只做"猜常见位置 + 用已有线索反推"，猜不到就留空让用户手填；
//! 不做全盘扫描（慢且危险）。

use crate::model::{AndroidSettings, HarmonySettings};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub android: AndroidSettings,
    pub harmony: HarmonySettings,
    pub flutter: Option<String>,
    pub harmony_version: Option<String>,
    pub npm: crate::model::NpmSettings,
    pub docker: crate::model::DockerSettings,
    pub editor: crate::model::EditorSettings,
    pub notes: Vec<String>,
}

/// 默认编辑器：只认 VS Code（Code.exe，不是 PATH 里的 code.cmd 脚本）
fn detect_editor(notes: &mut Vec<String>) -> crate::model::EditorSettings {
    let mut out = crate::model::EditorSettings::default();
    match crate::editor::detect(None) {
        Some(p) => {
            out.vscode_path = Some(p.display().to_string());
            notes.push("编辑器：VS Code".to_string());
        }
        None => notes.push("未检测到 VS Code".to_string()),
    }
    out
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| p.exists())
}

fn file_str(p: &Path) -> Option<String> {
    if p.is_file() {
        Some(p.display().to_string())
    } else {
        None
    }
}

fn dir_str(p: &Path) -> Option<String> {
    if p.is_dir() {
        Some(p.display().to_string())
    } else {
        None
    }
}

/// 从 PATH 里找某个可执行文件
fn find_in_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for n in names {
            let cand = dir.join(n);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// 从 hdc.exe 反推 DevEco 根目录：
/// `<DevEco>\sdk\default\openharmony\toolchains\hdc.exe`
fn deveco_from_hdc(hdc: &Path) -> Option<PathBuf> {
    let mut cur = hdc.parent()?;
    for _ in 0..6 {
        let emu = cur.join("tools").join("emulator").join("Emulator.exe");
        if emu.is_file() {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
    None
}

fn detect_android(notes: &mut Vec<String>) -> AndroidSettings {
    let mut out = AndroidSettings::default();

    let sdk = env_path("ANDROID_HOME")
        .or_else(|| env_path("ANDROID_SDK_ROOT"))
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(|p| PathBuf::from(p).join("Android").join("Sdk"))
                .filter(|p| p.is_dir())
        });

    if let Some(sdk) = sdk {
        out.sdk_path = dir_str(&sdk);
        out.emulator_path = file_str(&sdk.join("emulator").join("emulator.exe"));
    } else {
        notes.push("未找到 Android SDK（ANDROID_HOME / %LOCALAPPDATA%\\Android\\Sdk 都不存在）".into());
    }

    if let Some(home) = std::env::var_os("USERPROFILE") {
        let avd = PathBuf::from(home).join(".android").join("avd");
        if avd.is_dir() {
            out.avd_path = dir_str(&avd);
        }
    }

    out
}

fn detect_harmony(notes: &mut Vec<String>) -> HarmonySettings {
    let mut out = HarmonySettings::default();

    // 1) 用 hdc 反推 DevEco 根目录
    let mut deveco: Option<PathBuf> = find_in_path(&["hdc.exe", "hdc"]).and_then(|h| deveco_from_hdc(&h));

    // 2) 常见安装位置
    if deveco.is_none() {
        let roots = [
            std::env::var_os("ProgramFiles").map(PathBuf::from),
            std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        ];
        'outer: for root in roots.into_iter().flatten() {
            for name in ["Huawei/DevEco Studio", "Huawei/DevEcoStudio", "DevEco Studio"] {
                let cand = root.join(name);
                if cand.join("tools").join("emulator").join("Emulator.exe").is_file() {
                    deveco = Some(cand);
                    break 'outer;
                }
            }
        }
    }

    if let Some(dev) = &deveco {
        out.emulator_path = file_str(&dev.join("tools").join("emulator").join("Emulator.exe"));
        out.sdk_path = dir_str(&dev.join("sdk"));

        // 鸿蒙 Flutter 分支通常与 DevEco 同级目录
        if let Some(parent) = dev.parent() {
            for name in ["flutter_flutter", "flutter"] {
                let cand = parent.join(name);
                if cand.join("bin").join("flutter.bat").is_file() {
                    out.flutter_path = dir_str(&cand);
                    break;
                }
            }
        }
    } else {
        notes.push("未找到 DevEco Studio（可手动指定 Emulator.exe 所在目录）".into());
    }

    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        let deployed = local.join("Huawei").join("Emulator").join("deployed");
        if deployed.is_dir() {
            out.instance_path = dir_str(&deployed);
        }
        let images = local.join("Huawei").join("Sdk");
        if images.is_dir() {
            out.image_root = dir_str(&images);
        }
    }

    out
}

/// Node / 包管理器：只填 node 目录，管理器本身保持 auto（按项目的 lockfile 决定）
fn detect_npm(notes: &mut Vec<String>) -> crate::model::NpmSettings {
    let mut out = crate::model::NpmSettings::default();

    if let Some(node) = crate::terminal::which("node") {
        if let Some(dir) = node.parent() {
            out.node_path = Some(dir.display().to_string());
        }
    }

    let found: Vec<&str> = ["npm", "pnpm", "yarn"]
        .iter()
        .copied()
        .filter(|n| crate::terminal::which(n).is_some())
        .collect();
    if found.is_empty() {
        notes.push("未检测到 npm / pnpm / yarn".to_string());
    } else {
        notes.push(format!("包管理器：{}", found.join(" / ")));
    }

    out
}

/// Docker：填 docker.exe 路径 + 推断 compose 风格
fn detect_docker(notes: &mut Vec<String>) -> crate::model::DockerSettings {
    let mut out = crate::model::DockerSettings::default();

    if let Some(p) = crate::terminal::which("docker") {
        // which 可能返回无扩展名的脚本（Docker Desktop 的 bin 里就有一个），
        // 必须解析成真正的 docker.exe，否则 CreateProcess 会报 os error 193
        let exe = crate::terminal::resolve_executable(&p.display().to_string());
        let looks_exe = exe.to_ascii_lowercase().ends_with(".exe");
        out.docker_path = Some(exe.clone());

        // `docker compose version` 能跑通就是 v2
        if looks_exe && compose_v2_available(&exe) {
            out.compose_style = Some("v2".to_string());
            notes.push("Docker：compose v2".to_string());
        } else if crate::terminal::which("docker-compose").is_some() {
            out.compose_style = Some("v1".to_string());
            notes.push("Docker：旧版 docker-compose".to_string());
        } else {
            notes.push("Docker：未确认 compose 能力".to_string());
        }
    } else {
        notes.push("未检测到 docker".to_string());
    }

    out
}

/// 静默跑一次 `docker compose version`（不弹控制台窗口），**最多等 3 秒**。
///
/// Docker Desktop 有时会卡住（连 `docker ps --filter label=...` 都能挂住），
/// 这里必须自带超时，否则「自动检测」会把设置页冻住。
fn compose_v2_available(docker_exe: &str) -> bool {
    let mut cmd = std::process::Command::new(docker_exe);
    cmd.args(["compose", "version"]);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let Ok(mut child) = cmd.spawn() else {
        return false;
    };

    for _ in 0..30 {
        match child.try_wait() {
            Ok(Some(s)) => return s.success(),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => return false,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    false
}

pub fn detect() -> Detected {
    let mut notes = Vec::new();

    let android = detect_android(&mut notes);
    let harmony = detect_harmony(&mut notes);
    let npm = detect_npm(&mut notes);
    let docker = detect_docker(&mut notes);
    let editor = detect_editor(&mut notes);
    let flutter = crate::flutter::resolve(Path::new("."), None)
        .0
        .map(|p| p.display().to_string());

    let harmony_version = crate::harmony::version(&harmony);

    Detected {
        android,
        harmony,
        flutter,
        harmony_version,
        npm,
        docker,
        editor,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::detect;

/// 本机若有 docker，探测结果必须给到真实 .exe（而不是同名的无扩展名脚本）
    #[test]
    fn docker_detection_prefers_real_exe() {
        let d = super::detect();
        if crate::terminal::which("docker").is_none() {
            eprintln!("跳过：本机没有 docker");
            return;
        }
        let path = d.docker.docker_path.expect("应探测到 docker 路径");
        assert!(
            path.to_ascii_lowercase().ends_with(".exe"),
            "必须解析成 .exe，实际: {path}"
        );
    }

    /// 打印本机探测结果；同时验证不会 panic、关键路径能命中。
    #[test]
    fn detects_toolchains_on_this_machine() {
        let d = detect();

        println!("flutter          = {:?}", d.flutter);
        println!("android.sdk      = {:?}", d.android.sdk_path);
        println!("android.emulator = {:?}", d.android.emulator_path);
        println!("android.avd      = {:?}", d.android.avd_path);
        println!("harmony.emulator = {:?}", d.harmony.emulator_path);
        println!("harmony.instance = {:?}", d.harmony.instance_path);
        println!("harmony.image    = {:?}", d.harmony.image_root);
        println!("harmony.flutter  = {:?}", d.harmony.flutter_path);
        println!("harmony.version  = {:?}", d.harmony_version);
        println!("notes            = {:?}", d.notes);

        // 本机装了 Android SDK，应能识别出 emulator.exe
        if let Some(sdk) = &d.android.sdk_path {
            assert!(
                d.android.emulator_path.is_some(),
                "有 SDK 却没找到 emulator.exe: {sdk}"
            );
        }

        // 若找到了 DevEco，就应能推出 Emulator.exe
        if d.harmony.emulator_path.is_some() {
            let p = std::path::Path::new(d.harmony.emulator_path.as_ref().unwrap());
            assert!(p.is_file(), "Emulator.exe 路径不存在");
        }
    }
}




