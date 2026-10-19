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
    pub notes: Vec<String>,
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

pub fn detect() -> Detected {
    let mut notes = Vec::new();

    let android = detect_android(&mut notes);
    let harmony = detect_harmony(&mut notes);
    let flutter = crate::flutter::resolve(Path::new("."), None)
        .0
        .map(|p| p.display().to_string());

    let harmony_version = crate::harmony::version(&harmony);

    Detected {
        android,
        harmony,
        flutter,
        harmony_version,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::detect;

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
