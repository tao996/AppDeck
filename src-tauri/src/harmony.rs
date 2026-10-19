//! HarmonyOS（DevEco）模拟器客户端。
//!
//! DevEco 的 `Emulator.exe` 提供完整 CLI（实测 26.0.0.402）：
//!   Emulator -list          列出实例名（每行一个）
//!   Emulator -list -details JSON 详情
//!   Emulator -start <name>  启动
//!   Emulator -stop <name>   停止
//!   Emulator -version

use crate::model::HarmonySettings;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HarmonyEmulator {
    pub name: String,
    pub detail: String,
}

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide(_cmd: &mut Command) {}

/// 解析配置：允许填 Emulator.exe 本身，或它所在的目录
pub fn exe_of(s: &HarmonySettings) -> Option<PathBuf> {
    let raw = s.emulator_path.as_ref()?.trim();
    if raw.is_empty() {
        return None;
    }
    let p = PathBuf::from(raw);
    if p.is_file() {
        return Some(p);
    }
    let cand = p.join("Emulator.exe");
    if cand.is_file() {
        Some(cand)
    } else {
        None
    }
}

pub fn list(s: &HarmonySettings) -> Result<Vec<HarmonyEmulator>, String> {
    let exe = exe_of(s).ok_or_else(|| "未配置 HarmonyOS 模拟器路径".to_string())?;

    let mut cmd = Command::new(&exe);
    cmd.arg("-list")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide(&mut cmd);

    let out = cmd
        .output()
        .map_err(|e| format!("调用 Emulator.exe 失败: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();

    if !out.status.success() && text.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Emulator.exe -list 失败: {}", err.trim()));
    }

    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains("HarmonyOS Emulator"))
        .map(|l| HarmonyEmulator {
            name: l.to_string(),
            detail: "HarmonyOS".to_string(),
        })
        .collect())
}

pub fn start(s: &HarmonySettings, name: &str) -> Result<(), String> {
    let exe = exe_of(s).ok_or_else(|| "未配置 HarmonyOS 模拟器路径".to_string())?;

    let mut cmd = Command::new(&exe);
    cmd.arg("-start").arg(name);

    if let Some(p) = s.instance_path.as_ref().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        cmd.arg("-instancePath").arg(p);
    }
    if let Some(p) = s.image_root.as_ref().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        cmd.arg("-imageRoot").arg(p);
    }

    cmd.stdin(Stdio::null());
    hide(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动鸿蒙模拟器失败: {e}"))?;

    // 模拟器进程常驻，不阻塞调用方
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(())
}

pub fn version(s: &HarmonySettings) -> Option<String> {
    let exe = exe_of(s)?;
    let mut cmd = Command::new(exe);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
