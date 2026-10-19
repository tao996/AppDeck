//! Android 模拟器：直接驱动 `emulator.exe`。
//!
//! 为什么不用 `flutter daemon` 的 `emulator.getEmulators`：它只能看到
//! **Flutter 自己找得到的** AVD（依赖 `ANDROID_HOME` 与默认 `~/.android/avd`）。
//! 用户在设置里指定了自定义 AVD 目录时，daemon 完全看不到那些实例。
//!
//! `emulator.exe -list-avds` 认可 `ANDROID_AVD_HOME`，因此这里把它注入子进程环境，
//! 让设置真正生效。

use crate::model::AndroidSettings;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulator {
    pub name: String,
    pub detail: String,
}

pub struct Resolved {
    pub exe: PathBuf,
    pub sdk_root: Option<String>,
    pub avd_home: Option<String>,
}

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide(_cmd: &mut Command) {}

fn clean(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 解析 emulator.exe 与要注入的环境变量
pub fn resolve(settings: &AndroidSettings) -> Option<Resolved> {
    let exe = settings
        .emulator_path
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| {
            // 允许只填 SDK 目录
            settings
                .sdk_path
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| {
                    PathBuf::from(s)
                        .join("emulator")
                        .join("emulator.exe")
                })
                .filter(|p| p.is_file())
        })?;

    Some(Resolved {
        exe,
        sdk_root: clean(&settings.sdk_path),
        avd_home: clean(&settings.avd_path),
    })
}

/// `ANDROID_AVD_HOME` 是让自定义 AVD 目录生效的关键
fn apply_env(cmd: &mut Command, r: &Resolved) {
    if let Some(sdk) = &r.sdk_root {
        cmd.env("ANDROID_SDK_ROOT", sdk);
        cmd.env("ANDROID_HOME", sdk);
    }
    if let Some(avd) = &r.avd_home {
        cmd.env("ANDROID_AVD_HOME", avd);
    }
}

pub fn list_avds(r: &Resolved) -> Result<Vec<AndroidEmulator>, String> {
    let mut cmd = Command::new(&r.exe);
    cmd.arg("-list-avds")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_env(&mut cmd, r);
    hide(&mut cmd);

    let out = cmd
        .output()
        .map_err(|e| format!("调用 emulator.exe 失败: {e}"))?;

    let text = String::from_utf8_lossy(&out.stdout).to_string();

    if !out.status.success() && text.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("emulator -list-avds 失败: {}", err.trim()));
    }

    Ok(text
        .lines()
        .map(str::trim)
        // 有的版本会输出 INFO/WARNING 日志行
        .filter(|l| !l.is_empty() && !l.contains(' ') && !l.starts_with("INFO"))
        .map(|l| AndroidEmulator {
            name: l.to_string(),
            detail: "Android".to_string(),
        })
        .collect())
}

/// 启动 AVD。**刻意不挂 Job**：模拟器是用户显式启动的外部工具，
/// 应当能在启动器退出后继续运行（与鸿蒙模拟器一致）。
pub fn start_avd(r: &Resolved, name: &str) -> Result<(), String> {
    let mut cmd = Command::new(&r.exe);
    cmd.arg("-avd").arg(name);
    apply_env(&mut cmd, r);
    cmd.stdin(Stdio::null());
    hide(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Android 模拟器失败: {e}"))?;

    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_exe_from_settings() {
        let s = AndroidSettings {
            sdk_path: Some(r"D:\apps\Android\SDK".into()),
            emulator_path: Some(r"D:\apps\Android\SDK\emulator\emulator.exe".into()),
            avd_path: Some(r"D:\mydata\.android\avd".into()),
            ..Default::default()
        };

        let r = resolve(&s).expect("本机应能解析出 emulator.exe");
        assert!(r.exe.is_file(), "解析出的路径应存在");
        assert_eq!(r.avd_home.as_deref(), Some(r"D:\mydata\.android\avd"));

        let avds = list_avds(&r).unwrap_or_default();
        println!("avds = {avds:?}");
    }

    #[test]
    fn empty_settings_resolve_to_none() {
        let s = AndroidSettings::default();
        assert!(resolve(&s).is_none(), "空设置不应解析出可执行文件");
    }
}
