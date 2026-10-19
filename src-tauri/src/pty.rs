//! ConPTY 会话管理。
//!
//! 每个会话 = 一个伪终端 + 一个子进程。输出经流式 UTF-8 解码后推给前端，
//! 前端按键原样写回 PTY。进程树用 Windows Job Object 兜底回收。

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct OutputPayload {
    pub id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct ExitPayload {
    pub id: String,
    pub code: Option<i32>,
}

pub struct Session {
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub pid: u32,
    /// Job 句柄：Drop 时触发 KILL_ON_JOB_CLOSE，连带杀掉整棵进程树
    _job: Option<JobGuard>,
}

#[derive(Default)]
pub struct Registry(pub Mutex<HashMap<String, Arc<Session>>>);

/* ---------------- UTF-8 流式解码 ---------------- */

/// PTY 按块返回字节，多字节字符可能被切断。
/// 必须保留不完整尾部，等下一块拼上，否则中文日志会随机乱码。
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        if let Ok(s) = std::str::from_utf8(&self.pending[..valid]) {
                            out.push_str(s);
                        }
                    }
                    match e.error_len() {
                        // 真正非法的字节：替换并跳过
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + len);
                        }
                        // 不完整的多字节序列：留到下一块
                        None => {
                            self.pending.drain(..valid);
                            break;
                        }
                    }
                }
            }
        }

        out
    }
}

/* ---------------- Job Object ---------------- */

#[cfg(windows)]
struct JobGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for JobGuard {}
#[cfg(windows)]
unsafe impl Sync for JobGuard {}

#[cfg(windows)]
impl JobGuard {
    fn assign(pid: u32) -> Option<Self> {
        use std::ptr;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

        if pid == 0 {
            return None;
        }

        unsafe {
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                return None;
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );

            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                CloseHandle(job);
                return None;
            }

            let ok = AssignProcessToJobObject(job, process);
            CloseHandle(process);

            if ok == 0 {
                CloseHandle(job);
                return None;
            }

            Some(JobGuard(job))
        }
    }
}

#[cfg(windows)]
impl Drop for JobGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
struct JobGuard;

#[cfg(not(windows))]
impl JobGuard {
    fn assign(_pid: u32) -> Option<Self> {
        None
    }
}

/* ---------------- DSR 过滤 ---------------- */

/// ConPTY 启动时会发 `ESC[6n`（设备状态报告：查询光标位置），
/// 在收到应答前不会继续输出。实测若无人应答，进程会一直卡住。
///
/// 这里由后端统一应答 `ESC[1;1R`，并把该序列从输出中**剔除**，
/// 避免 xterm.js 再回一次导致重复应答（多余的 `R` 会变成 stray input）。
#[derive(Default)]
pub struct DsrFilter {
    hold: String,
}

const DSR: &str = "\u{1b}[6n";

impl DsrFilter {
    /// 返回（可展示文本, 是否检测到 DSR）
    pub fn feed(&mut self, input: &str) -> (String, bool) {
        let mut s = std::mem::take(&mut self.hold);
        s.push_str(input);

        let chars: Vec<char> = s.chars().collect();
        let mut out = String::with_capacity(s.len());
        let mut found = false;
        let mut i = 0usize;

        while i < chars.len() {
            if chars[i] == '\u{1b}' {
                let rest: String = chars[i..chars.len().min(i + 4)].iter().collect();
                if rest == DSR {
                    found = true;
                    i += 4;
                    continue;
                }
                // 可能是被切块截断的序列，留到下一块再判断
                if rest.chars().count() < 4 && DSR.starts_with(&rest) {
                    self.hold = rest;
                    break;
                }
            }
            out.push(chars[i]);
            i += 1;
        }

        (out, found)
    }
}

/* ---------------- 会话创建 ---------------- */

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    app: AppHandle,
    id: String,
    program: &str,
    args: &[String],
    cwd: PathBuf,
    rows: u16,
    cols: u16,
) -> Result<Arc<Session>, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(10),
            cols: cols.max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建伪终端失败: {e}"))?;

    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(&cwd);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动进程失败: {e}"))?;

    let pid = child.process_id().unwrap_or(0);
    let job = JobGuard::assign(pid);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取 PTY 读端失败: {e}"))?;
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|e| format!("获取 PTY 写端失败: {e}"))?,
    ));
    let master = pair.master;
    drop(pair.slave);

    // 输出线程（同时负责应答 ConPTY 的 DSR）
    let out_app = app.clone();
    let out_id = id.clone();
    let reply = writer.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut decoder = Utf8Stream::default();
        let mut dsr = DsrFilter::default();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = decoder.push(&buf[..n]);
                    if text.is_empty() {
                        continue;
                    }

                    let (text, need_reply) = dsr.feed(&text);
                    if need_reply {
                        if let Ok(mut w) = reply.lock() {
                            let _ = w.write_all(b"\x1b[1;1R");
                            let _ = w.flush();
                        }
                    }

                    if !text.is_empty() {
                        let _ = out_app.emit(
                            "pty://output",
                            OutputPayload {
                                id: out_id.clone(),
                                data: text,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
    });

    // 退出线程（持有 child，拿到退出码）
    let exit_app = app.clone();
    let exit_id = id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        let _ = exit_app.emit(
            "pty://exit",
            ExitPayload {
                id: exit_id,
                code,
            },
        );
    });

    Ok(Arc::new(Session {
        writer,
        master: Mutex::new(master),
        pid,
        _job: job,
    }))
}

impl Session {
    pub fn write(&self, data: &str) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|_| "写端已锁定".to_string())?;
        w.write_all(data.as_bytes())
            .map_err(|e| format!("写入终端失败: {e}"))?;
        w.flush().ok();
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|_| "PTY 已锁定".to_string())?;
        master
            .resize(PtySize {
                rows: rows.max(10),
                cols: cols.max(40),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("调整终端尺寸失败: {e}"))
    }
}

/// 关闭会话：从注册表移除 → Arc 归零 → Job Drop → 整棵进程树被杀
pub fn kill(reg: &Registry, id: &str) -> bool {
    let removed = reg
        .0
        .lock()
        .map(|mut map| map.remove(id).is_some())
        .unwrap_or(false);
    removed
}

#[cfg(test)]
mod tests {
    use super::{DsrFilter, Utf8Stream};

    #[test]
    fn decodes_split_multibyte_sequence() {
        let mut s = Utf8Stream::default();
        // “中” = E4 B8 AD，故意切成两块
        let out1 = s.push(&[0xE4, 0xB8]);
        assert_eq!(out1, "", "不完整序列不应产出字符");
        let out2 = s.push(&[0xAD]);
        assert_eq!(out2, "中");
    }

    #[test]
    fn replaces_invalid_bytes() {
        let mut s = Utf8Stream::default();
        let out = s.push(&[0x41, 0xFF, 0x42]);
        assert!(out.starts_with('A'));
        assert!(out.contains('\u{FFFD}'));
        assert!(out.ends_with('B'));
    }

    #[test]
    fn passes_plain_ascii() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(b"hello"), "hello");
    }
    #[test]
    fn dsr_detects_and_strips() {
        let mut f = DsrFilter::default();
        let (text, hit) = f.feed("\u{1b}[6nHELLO");
        assert!(hit, "应检测到 DSR");
        assert_eq!(text, "HELLO", "DSR 必须被剔除");
    }

    #[test]
    fn dsr_handles_split_sequence() {
        let mut f = DsrFilter::default();
        let (t1, h1) = f.feed("\u{1b}[6");
        assert!(!h1);
        assert_eq!(t1, "", "不完整序列应暂存，不能吐出");

        let (t2, h2) = f.feed("nOK");
        assert!(h2, "拼接后应识别出 DSR");
        assert_eq!(t2, "OK");
    }

    #[test]
    fn dsr_passes_normal_escapes() {
        let mut f = DsrFilter::default();
        let (text, hit) = f.feed("\u{1b}[32mgreen\u{1b}[0m");
        assert!(!hit);
        assert_eq!(text, "\u{1b}[32mgreen\u{1b}[0m", "普通 ANSI 不能被误伤");
    }
}
