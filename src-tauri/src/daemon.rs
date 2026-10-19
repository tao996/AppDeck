//! `flutter daemon` 客户端。
//!
//! 为什么需要它：`flutter devices --machine` 只能列出**在线**设备，
//! 未启动的模拟器完全看不到；而 `flutter emulators --machine` **不存在**
//! （实测报 "--machine 只对 --version / analyze 有效"）。
//! daemon 协议同时提供 `device.getDevices` 与 `emulator.getEmulators`，
//! 且会推送 `device.added` / `device.removed` 事件，无需轮询。

use crate::flutter;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub platform: Option<String>,
    /// flutter daemon 的真实字段（如 android-arm / web-javascript / windows-x64）
    #[serde(rename = "platformType", default)]
    pub platform_type: Option<String>,
    pub category: Option<String>,
    pub emulator: bool,
    pub sdk: Option<String>,
    pub is_connected: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EmulatorInfo {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevicesPayload {
    pub devices: Vec<DeviceInfo>,
    pub emulators: Vec<EmulatorInfo>,
}

pub struct Daemon {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
    devices: Arc<Mutex<Vec<DeviceInfo>>>,
    emulators: Arc<Mutex<Vec<EmulatorInfo>>>,
    next: AtomicU64,
    alive: Arc<AtomicBool>,
    /// 与应用同生命周期：进程退出时 Job 关闭 → daemon 连同子树被系统杀掉。
    /// 没有它，每次启动应用都会泄漏一个 `flutter daemon`。
    _job: Option<crate::pty::JobGuard>,
}

#[derive(Default)]
pub struct Daemons(pub Mutex<HashMap<String, Arc<Daemon>>>);

/// 设备变化回调（生产环境接 Tauri 事件，测试里可以是空闭包）
pub type EventSink = Arc<dyn Fn(DevicesPayload) + Send + Sync>;

#[cfg(windows)]
fn hide(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide(_cmd: &mut std::process::Command) {}

impl Daemon {
    pub fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("flutter daemon 已退出".to_string());
        }

        let id = self.next.fetch_add(1, Ordering::SeqCst).to_string();
        let (tx, rx) = mpsc::channel::<Value>();

        self.pending
            .lock()
            .map_err(|_| "daemon 锁失败".to_string())?
            .insert(id.clone(), tx);

        let mut msg = serde_json::json!({ "id": id, "method": method });
        if let Some(p) = params {
            msg["params"] = p;
        }
        let line = format!("[{}]\n", msg);

        {
            let mut w = self.stdin.lock().map_err(|_| "daemon 锁失败".to_string())?;
            w.write_all(line.as_bytes())
                .map_err(|e| format!("写入 flutter daemon 失败: {e}"))?;
            w.flush().ok();
        }

        match rx.recv_timeout(Duration::from_secs(40)) {
            Ok(v) => {
                if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                    return Err(format!("flutter daemon 返回错误: {err}"));
                }
                Ok(v.get("result").cloned().unwrap_or(Value::Null))
            }
            Err(_) => {
                if let Ok(mut m) = self.pending.lock() {
                    m.remove(&id);
                }
                // 超时视为僵死：杀掉以便下次调用重建
                self.kill();
                Err("等待 flutter daemon 响应超时".to_string())
            }
        }
    }

    pub fn snapshot(&self) -> DevicesPayload {
        DevicesPayload {
            devices: self.devices.lock().map(|d| d.clone()).unwrap_or_default(),
            emulators: self.emulators.lock().map(|e| e.clone()).unwrap_or_default(),
        }
    }

    pub fn set_devices(&self, list: Vec<DeviceInfo>) {
        if let Ok(mut d) = self.devices.lock() {
            *d = list;
        }
    }

    pub fn set_emulators(&self, list: Vec<EmulatorInfo>) {
        if let Ok(mut e) = self.emulators.lock() {
            *e = list;
        }
    }

    pub fn kill(&self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
        }
    }
}

fn upsert_device(list: &mut Vec<DeviceInfo>, dev: DeviceInfo) {
    if let Some(slot) = list.iter_mut().find(|d| d.id == dev.id) {
        *slot = dev;
    } else {
        list.push(dev);
    }
}

fn handle_item(
    item: &Value,
    pending: &Arc<Mutex<HashMap<String, Sender<Value>>>>,
    devices: &Arc<Mutex<Vec<DeviceInfo>>>,
    emulators: &Arc<Mutex<Vec<EmulatorInfo>>>,
    sink: &EventSink,
) {
    if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
        let tx = pending.lock().ok().and_then(|mut m| m.remove(id));
        if let Some(tx) = tx {
            let _ = tx.send(item.clone());
        }
        return;
    }

    let Some(event) = item.get("event").and_then(|v| v.as_str()) else {
        return;
    };
    let params = item.get("params").cloned().unwrap_or(Value::Null);

    match event {
        "device.added" => {
            if let Ok(dev) = serde_json::from_value::<DeviceInfo>(params) {
                if let Ok(mut list) = devices.lock() {
                    upsert_device(&mut list, dev);
                }
                emit_changed(sink, devices, emulators);
            }
        }
        "device.removed" => {
            if let Some(id) = params.get("id").and_then(|v| v.as_str()) {
                if let Ok(mut list) = devices.lock() {
                    list.retain(|d| d.id != id);
                }
                emit_changed(sink, devices, emulators);
            }
        }
        _ => {}
    }
}

fn emit_changed(
    sink: &EventSink,
    devices: &Arc<Mutex<Vec<DeviceInfo>>>,
    emulators: &Arc<Mutex<Vec<EmulatorInfo>>>,
) {
    let payload = DevicesPayload {
        devices: devices.lock().map(|d| d.clone()).unwrap_or_default(),
        emulators: emulators.lock().map(|e| e.clone()).unwrap_or_default(),
    };
    sink(payload);
}

pub fn spawn(exe: &Path, sink: EventSink) -> Result<Daemon, String> {
    let mut cmd = flutter::build_command(exe, &["daemon"]);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 flutter daemon 失败: {e}"))?;

    // 关键：daemon 常驻，必须挂到 Job Object 上，否则应用退出后会变成孤儿进程
    let job = crate::pty::JobGuard::assign(child.id());

    let stdin = child.stdin.take().ok_or("无法获取 daemon stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取 daemon stdout")?;

    // stderr 必须有人读，否则管道写满会阻塞 daemon
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut r = BufReader::new(stderr);
            let mut s = String::new();
            let _ = r.read_to_string(&mut s);
        });
    }

    let pending: Arc<Mutex<HashMap<String, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
    let devices: Arc<Mutex<Vec<DeviceInfo>>> = Arc::new(Mutex::new(Vec::new()));
    let emulators: Arc<Mutex<Vec<EmulatorInfo>>> = Arc::new(Mutex::new(Vec::new()));
    let alive = Arc::new(AtomicBool::new(true));

    let p2 = pending.clone();
    let d2 = devices.clone();
    let e2 = emulators.clone();
    let a2 = alive.clone();
    let sink2 = sink.clone();

    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();

        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let raw = String::from_utf8_lossy(&buf);
                    let line = raw.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    for item in items {
                        handle_item(&item, &p2, &d2, &e2, &sink2);
                    }
                }
            }
        }

        a2.store(false, Ordering::SeqCst);
        if let Ok(mut m) = p2.lock() {
            m.clear();
        }
        sink2(DevicesPayload::default());
    });

    Ok(Daemon {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending,
        devices,
        emulators,
        next: AtomicU64::new(1),
        alive,
        _job: job,
    })
}

/// 取得（必要时启动）对应 Flutter 可执行文件的 daemon。
pub fn get_or_start(
    reg: &Daemons,
    exe: &Path,
    sink: EventSink,
) -> Result<Arc<Daemon>, String> {
    let key = exe.display().to_string();

    {
        let map = reg.0.lock().map_err(|_| "daemon 注册表锁失败".to_string())?;
        if let Some(d) = map.get(&key) {
            if d.alive.load(Ordering::SeqCst) {
                return Ok(d.clone());
            }
        }
    }

    let daemon = Arc::new(spawn(exe, sink)?);
    reg.0
        .lock()
        .map_err(|_| "daemon 注册表锁失败".to_string())?
        .insert(key, daemon.clone());

    Ok(daemon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 真实链路：启动 flutter daemon → device.getDevices + emulator.getEmulators。
    /// 无 flutter 的机器上自动跳过。
    #[test]
    fn daemon_lists_devices_and_emulators() {
        let Some(exe) = crate::flutter::resolve(Path::new("."), None).0 else {
            eprintln!("跳过：本机无 flutter");
            return;
        };

        let sink: EventSink = Arc::new(|_p: DevicesPayload| {});
        let d = match spawn(&exe, sink) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("跳过：daemon 启动失败 {e}");
                return;
            }
        };

        let v = d
            .request("device.getDevices", None)
            .expect("device.getDevices 应有响应");
        let devices: Vec<DeviceInfo> = serde_json::from_value(v).expect("设备列表应可解析");
        assert!(!devices.is_empty(), "至少应有 windows / chrome 之一");

        let v2 = d
            .request("emulator.getEmulators", None)
            .expect("emulator.getEmulators 应有响应");
        let emulators: Vec<EmulatorInfo> =
            serde_json::from_value(v2).expect("模拟器列表应可解析");

        println!(
            "devices = {:?}",
            devices.iter().map(|d| d.id.as_str()).collect::<Vec<_>>()
        );
        println!(
            "emulators = {:?}",
            emulators.iter().map(|e| e.id.as_str()).collect::<Vec<_>>()
        );

        d.kill();
    }
}
