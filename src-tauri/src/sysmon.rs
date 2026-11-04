//! 进程与端口快照 / 终止进程。
//!
//! 定位是**开发辅助**，不是系统管理：默认过滤掉 Windows 核心与服务进程，
//! 只留下当前用户会话的进程；端口表则**始终保留所有者**——否则会出现
//! “端口被占，但列表里找不到人”的困惑。
//!
//! 全部走 Win32（ToolHelp / IP Helper / Threading），不引第三方进程库：
//! 端口归属本来就必须 `GetExtendedTcpTable`，进程字段 ToolHelp 已经够用。

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub exe: Option<String>,
    pub user: Option<String>,
    pub memory_bytes: u64,
    pub cpu_percent: f32,
    pub started_at_ms: Option<u64>,
    pub critical: bool,
    /// Windows 核心 / 关键进程：默认隐藏，禁止结束
    pub system: bool,
    /// 其他会话里的第三方服务（如 Clash / MySQL 服务）：默认隐藏，但允许尝试结束
    pub service: bool,
    pub is_self: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    /// tcp | udp
    pub proto: &'static str,
    /// v4 | v6
    pub family: &'static str,
    pub local_addr: String,
    pub local_port: u16,
    pub remote_addr: Option<String>,
    pub remote_port: Option<u16>,
    /// LISTEN / ESTABLISHED / TIME_WAIT / UDP …
    pub state: &'static str,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub taken_at_ms: u64,
    pub elevated: bool,
    pub processes: Vec<ProcInfo>,
    pub ports: Vec<PortInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillReport {
    pub killed: Vec<u32>,
    pub failed: Vec<KillFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillFailure {
    pub pid: u32,
    pub error: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(windows)]
pub fn snapshot() -> Snapshot {
    win::snapshot()
}

#[cfg(not(windows))]
pub fn snapshot() -> Snapshot {
    Snapshot {
        taken_at_ms: now_ms(),
        elevated: false,
        processes: Vec::new(),
        ports: Vec::new(),
    }
}

/// 终止进程（可选连同子进程）。`expect_start_ms` 用来校验 PID 没有被复用。
#[cfg(windows)]
pub fn kill(pid: u32, expect_start_ms: Option<u64>, tree: bool) -> Result<KillReport, String> {
    win::kill(pid, expect_start_ms, tree)
}

#[cfg(not(windows))]
pub fn kill(_pid: u32, _expect_start_ms: Option<u64>, _tree: bool) -> Result<KillReport, String> {
    Err("进程管理目前只支持 Windows".to_string())
}

#[cfg(windows)]
mod win {
    use super::{now_ms, KillFailure, KillReport, PortInfo, ProcInfo, Snapshot};
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, FILETIME, HANDLE, INVALID_HANDLE_VALUE, ERROR_INSUFFICIENT_BUFFER,
    };
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_TCP_STATE_CLOSED, MIB_TCP_STATE_CLOSE_WAIT, MIB_TCP_STATE_CLOSING,
        MIB_TCP_STATE_DELETE_TCB, MIB_TCP_STATE_ESTAB, MIB_TCP_STATE_FIN_WAIT1,
        MIB_TCP_STATE_FIN_WAIT2, MIB_TCP_STATE_LAST_ACK, MIB_TCP_STATE_LISTEN,
        MIB_TCP_STATE_SYN_RCVD, MIB_TCP_STATE_SYN_SENT, MIB_TCP_STATE_TIME_WAIT,
        MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows_sys::Win32::Security::{
        GetTokenInformation, LookupAccountSidW, TokenElevation, TokenUser, PSID, TOKEN_ELEVATION,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, IsProcessCritical, OpenProcess,
        OpenProcessToken, QueryFullProcessImageNameW, TerminateProcess,
        PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        PROCESS_VM_READ,
    };

    /// 句柄的 RAII 包装：所有早退路径都能自动 CloseHandle
    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(h: HANDLE) -> Option<Self> {
            if h.is_null() || h == INVALID_HANDLE_VALUE {
                None
            } else {
                Some(Self(h))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// 系统核心进程兜底名单（session 0 / IsProcessCritical 之外再兜一层）
    const CORE_NAMES: &[&str] = &[
        "system",
        "registry",
        "memcompression",
        "smss.exe",
        "csrss.exe",
        "wininit.exe",
        "winlogon.exe",
        "services.exe",
        "lsass.exe",
        "svchost.exe",
        "dwm.exe",
        "fontdrvhost.exe",
    ];

    fn is_core_name(name: &str) -> bool {
        CORE_NAMES.contains(&name)
    }

    /// 可执行文件是否在 Windows 系统目录下（System32 / SysWOW64 / WinSxS…）
    fn is_under_windows(exe: &str) -> bool {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let root = root.trim_end_matches(['\\', '/']).to_ascii_lowercase();
        let exe = exe.to_ascii_lowercase();
        exe.starts_with(&format!("{root}\\")) || exe.starts_with(&format!("{root}/"))
    }

    fn wide_string(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    fn filetime_u64(ft: FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
    }

    /// FILETIME（1601-01-01 起，100ns）→ Unix 毫秒
    fn filetime_ms(ft: FILETIME) -> u64 {
        const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
        filetime_u64(ft)
            .saturating_sub(EPOCH_DIFF_100NS)
            .saturating_div(10_000)
    }

    fn last_error(what: &str) -> String {
        let code = unsafe { GetLastError() };
        let hint = match code {
            5 => "；该进程可能以管理员身份运行，或属于其他用户",
            _ => "",
        };
        format!("{what}（Win32 错误 {code}）{hint}")
    }

    /* ---------------- CPU 采样 ---------------- */

    #[derive(Clone, Copy)]
    struct CpuSample {
        at_ms: u64,
        cpu_100ns: u64,
    }

    fn cpu_cache() -> &'static Mutex<HashMap<(u32, u64), CpuSample>> {
        static CACHE: OnceLock<Mutex<HashMap<(u32, u64), CpuSample>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// 按「(PID, 启动时间)」做键，避免 PID 复用后把两个进程的 CPU 算串。
    fn cpu_percent(pid: u32, start_ms: u64, cpu_100ns: u64, now: u64) -> f32 {
        if cpu_100ns == 0 {
            return 0.0;
        }

        let mut cache = cpu_cache()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        // 30 秒没再出现的样本直接清掉，缓存不会无限长
        cache.retain(|_, s| now.saturating_sub(s.at_ms) < 30_000);

        let key = (pid, start_ms);
        let pct = match cache.get(&key) {
            Some(prev) if now > prev.at_ms && cpu_100ns >= prev.cpu_100ns => {
                let cpu_delta = (cpu_100ns - prev.cpu_100ns) as f64; // 100ns
                let wall_delta = (now - prev.at_ms) as f64 * 10_000.0; // ms → 100ns
                let cores = std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(1) as f64;
                (cpu_delta / wall_delta * 100.0 / cores) as f32
            }
            _ => 0.0,
        };

        cache.insert(
            key,
            CpuSample {
                at_ms: now,
                cpu_100ns,
            },
        );
        pct.clamp(0.0, 100.0)
    }

    /* ---------------- 进程 ---------------- */

    #[derive(Default)]
    struct Detail {
        exe: Option<String>,
        user: Option<String>,
        memory_bytes: u64,
        cpu_100ns: u64,
        started_at_ms: Option<u64>,
        critical: bool,
    }

    fn process_entries() -> Vec<(u32, u32, String)> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Vec::new();
            }
            let snap = match OwnedHandle::new(snap) {
                Some(h) => h,
                None => return Vec::new(),
            };

            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

            let mut out = Vec::new();
            if Process32FirstW(snap.raw(), &mut entry) != 0 {
                loop {
                    out.push((
                        entry.th32ProcessID,
                        entry.th32ParentProcessID,
                        wide_string(&entry.szExeFile),
                    ));
                    if Process32NextW(snap.raw(), &mut entry) == 0 {
                        break;
                    }
                }
            }
            out
        }
    }

    fn token_user(process: HANDLE) -> Option<String> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let token = OwnedHandle::new(token)?;

            let mut len = 0u32;
            GetTokenInformation(token.raw(), TokenUser, std::ptr::null_mut(), 0, &mut len);
            if len == 0 {
                return None;
            }

            // TOKEN_USER 里含指针，缓冲区必须按 8 字节对齐，不能用 Vec<u8>
            let mut buf = vec![0u64; (len as usize).div_ceil(8)];
            if GetTokenInformation(
                token.raw(),
                TokenUser,
                buf.as_mut_ptr() as *mut c_void,
                len,
                &mut len,
            ) == 0
            {
                return None;
            }

            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            lookup_account(user.User.Sid)
        }
    }

    fn lookup_account(sid: PSID) -> Option<String> {
        unsafe {
            let mut name = [0u16; 256];
            let mut name_len = name.len() as u32;
            let mut domain = [0u16; 256];
            let mut domain_len = domain.len() as u32;
            let mut sid_type = 0i32;

            if LookupAccountSidW(
                std::ptr::null(),
                sid,
                name.as_mut_ptr(),
                &mut name_len,
                domain.as_mut_ptr(),
                &mut domain_len,
                &mut sid_type,
            ) == 0
            {
                return None;
            }

            let n = String::from_utf16_lossy(&name[..name_len.saturating_sub(1) as usize]);
            let d = String::from_utf16_lossy(&domain[..domain_len.saturating_sub(1) as usize]);
            Some(if d.is_empty() { n } else { format!("{d}\\{n}") })
        }
    }

    fn session_of(pid: u32) -> Option<u32> {
        unsafe {
            let mut session = 0u32;
            if ProcessIdToSessionId(pid, &mut session) != 0 {
                Some(session)
            } else {
                None
            }
        }
    }

    fn is_critical(pid: u32) -> bool {
        unsafe {
            let Some(handle) =
                OwnedHandle::new(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))
            else {
                return false;
            };
            let mut critical = 0i32;
            IsProcessCritical(handle.raw(), &mut critical) != 0 && critical != 0
        }
    }

    fn start_ms_of(pid: u32) -> Option<u64> {
        unsafe {
            let handle = OwnedHandle::new(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))?;
            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            if GetProcessTimes(
                handle.raw(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            ) == 0
            {
                return None;
            }
            Some(filetime_ms(creation))
        }
    }

    fn exe_of(pid: u32) -> Option<String> {
        unsafe {
            let handle = OwnedHandle::new(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))?;
            let mut buf = [0u16; 32_768];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(handle.raw(), 0, buf.as_mut_ptr(), &mut len) == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    /// 查询单个进程的路径 / 用户 / 内存 / CPU 时间 / 启动时间 / 是否关键进程。
    ///
    /// 先用 `PROCESS_QUERY_INFORMATION | VM_READ`（能读内存），失败再退回
    /// `PROCESS_QUERY_LIMITED_INFORMATION`（路径/用户/时间通常仍可读，内存留空）。
    fn query_detail(pid: u32) -> Detail {
        let full = OwnedHandle::new(unsafe {
            OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid)
        });
        let limited = if full.is_none() {
            OwnedHandle::new(unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
            })
        } else {
            None
        };

        let (handle, can_mem) = match (&full, &limited) {
            (Some(h), _) => (h.raw(), true),
            (_, Some(h)) => (h.raw(), false),
            _ => return Detail::default(),
        };

        let mut detail = Detail::default();
        unsafe {
            let mut buf = [0u16; 32_768];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) != 0 {
                detail.exe = Some(String::from_utf16_lossy(&buf[..len as usize]));
            }

            let mut critical = 0i32;
            if IsProcessCritical(handle, &mut critical) != 0 {
                detail.critical = critical != 0;
            }

            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            if GetProcessTimes(
                handle,
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            ) != 0
            {
                detail.started_at_ms = Some(filetime_ms(creation));
                detail.cpu_100ns = filetime_u64(kernel) + filetime_u64(user);
            }

            if can_mem {
                let mut counters = PROCESS_MEMORY_COUNTERS::default();
                counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
                if GetProcessMemoryInfo(handle, &mut counters, counters.cb) != 0 {
                    detail.memory_bytes = counters.WorkingSetSize as u64;
                }
            }

            detail.user = token_user(handle);
        }
        detail
    }

    fn is_elevated() -> bool {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let Some(token) = OwnedHandle::new(token) else {
                return false;
            };

            let mut elevation = TOKEN_ELEVATION {
                TokenIsElevated: 0,
            };
            let mut len = 0u32;
            GetTokenInformation(
                token.raw(),
                TokenElevation,
                &mut elevation as *mut _ as *mut c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            ) != 0
                && elevation.TokenIsElevated != 0
        }
    }

    pub fn snapshot() -> Snapshot {
        let taken = now_ms();
        let self_pid = unsafe { GetCurrentProcessId() };
        let self_session = session_of(self_pid).unwrap_or(0);

        let mut processes = Vec::new();
        for (pid, ppid, name) in process_entries() {
            let detail = query_detail(pid);
            let session = session_of(pid).unwrap_or(0);
            let lower = name.to_ascii_lowercase();
            let core = is_core_name(&lower);
            let other_session = session != self_session;
            // System32 等系统目录 + 其他会话 = 系统服务；用户会话里的 explorer 不算
            let os_service = other_session
                && detail
                    .exe
                    .as_deref()
                    .is_some_and(is_under_windows);

            let system = pid <= 4 || detail.critical || core || os_service;
            let service = other_session && !system;
            let cpu = cpu_percent(
                pid,
                detail.started_at_ms.unwrap_or(0),
                detail.cpu_100ns,
                taken,
            );

            processes.push(ProcInfo {
                pid,
                ppid,
                name: if name.is_empty() {
                    format!("PID {pid}")
                } else {
                    name
                },
                exe: detail.exe,
                user: detail.user,
                memory_bytes: detail.memory_bytes,
                cpu_percent: cpu,
                started_at_ms: detail.started_at_ms,
                critical: detail.critical,
                // 自己永远不算“系统进程”，否则前端会把自己的终止按钮也禁掉
                system: system && pid != self_pid,
                service: service && pid != self_pid,
                is_self: pid == self_pid,
            });
        }

        processes.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
                .then(a.pid.cmp(&b.pid))
        });

        Snapshot {
            taken_at_ms: taken,
            elevated: is_elevated(),
            processes,
            ports: collect_ports(),
        }
    }

    /* ---------------- 端口 ---------------- */

    fn port(raw: u32) -> u16 {
        u16::from_be(raw as u16)
    }

    fn tcp_state(state: u32) -> &'static str {
        match state as i32 {
            MIB_TCP_STATE_CLOSED => "CLOSED",
            MIB_TCP_STATE_LISTEN => "LISTEN",
            MIB_TCP_STATE_SYN_SENT => "SYN_SENT",
            MIB_TCP_STATE_SYN_RCVD => "SYN_RCVD",
            MIB_TCP_STATE_ESTAB => "ESTABLISHED",
            MIB_TCP_STATE_FIN_WAIT1 => "FIN_WAIT1",
            MIB_TCP_STATE_FIN_WAIT2 => "FIN_WAIT2",
            MIB_TCP_STATE_CLOSE_WAIT => "CLOSE_WAIT",
            MIB_TCP_STATE_CLOSING => "CLOSING",
            MIB_TCP_STATE_LAST_ACK => "LAST_ACK",
            MIB_TCP_STATE_TIME_WAIT => "TIME_WAIT",
            MIB_TCP_STATE_DELETE_TCB => "DELETE_TCB",
            _ => "UNKNOWN",
        }
    }

    fn tcp_v4(out: &mut Vec<PortInfo>) {
        unsafe {
            let mut size = 0u32;
            let ret = GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if (ret != ERROR_INSUFFICIENT_BUFFER && ret != 0) || size == 0 {
                return;
            }

            let mut buf = vec![0u32; (size as usize).div_ceil(4)];
            if GetExtendedTcpTable(
                buf.as_mut_ptr() as *mut c_void,
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            ) != 0
            {
                return;
            }

            let count = *buf.as_ptr() as usize;
            let rows = buf.as_ptr().add(1) as *const MIB_TCPROW_OWNER_PID;
            for i in 0..count {
                let row = std::ptr::read_unaligned(rows.add(i));
                let state = tcp_state(row.dwState);
                let local_port = port(row.dwLocalPort);
                let remote_port = port(row.dwRemotePort);
                let listen = row.dwState == MIB_TCP_STATE_LISTEN as u32;

                out.push(PortInfo {
                    proto: "tcp",
                    family: "v4",
                    local_addr: Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string(),
                    local_port,
                    remote_addr: if listen || remote_port == 0 {
                        None
                    } else {
                        Some(Ipv4Addr::from(u32::from_be(row.dwRemoteAddr)).to_string())
                    },
                    remote_port: if listen || remote_port == 0 {
                        None
                    } else {
                        Some(remote_port)
                    },
                    state,
                    pid: row.dwOwningPid,
                });
            }
        }
    }

    fn tcp_v6(out: &mut Vec<PortInfo>) {
        unsafe {
            let mut size = 0u32;
            let ret = GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                AF_INET6 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if (ret != ERROR_INSUFFICIENT_BUFFER && ret != 0) || size == 0 {
                return;
            }

            let mut buf = vec![0u32; (size as usize).div_ceil(4)];
            if GetExtendedTcpTable(
                buf.as_mut_ptr() as *mut c_void,
                &mut size,
                0,
                AF_INET6 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            ) != 0
            {
                return;
            }

            let count = *buf.as_ptr() as usize;
            let rows = buf.as_ptr().add(1) as *const MIB_TCP6ROW_OWNER_PID;
            for i in 0..count {
                let row = std::ptr::read_unaligned(rows.add(i));
                let state = tcp_state(row.dwState);
                let local_port = port(row.dwLocalPort);
                let remote_port = port(row.dwRemotePort);
                let listen = row.dwState == MIB_TCP_STATE_LISTEN as u32;

                out.push(PortInfo {
                    proto: "tcp",
                    family: "v6",
                    local_addr: ipv6_text(row.ucLocalAddr, row.dwLocalScopeId),
                    local_port,
                    remote_addr: if listen || remote_port == 0 {
                        None
                    } else {
                        Some(ipv6_text(row.ucRemoteAddr, row.dwRemoteScopeId))
                    },
                    remote_port: if listen || remote_port == 0 {
                        None
                    } else {
                        Some(remote_port)
                    },
                    state,
                    pid: row.dwOwningPid,
                });
            }
        }
    }

    fn ipv6_text(addr: [u8; 16], scope: u32) -> String {
        let ip = Ipv6Addr::from(addr);
        if scope == 0 {
            ip.to_string()
        } else {
            format!("{ip}%{scope}")
        }
    }

    fn udp_v4(out: &mut Vec<PortInfo>) {
        unsafe {
            let mut size = 0u32;
            let ret = GetExtendedUdpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                AF_INET as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
            if (ret != ERROR_INSUFFICIENT_BUFFER && ret != 0) || size == 0 {
                return;
            }

            let mut buf = vec![0u32; (size as usize).div_ceil(4)];
            if GetExtendedUdpTable(
                buf.as_mut_ptr() as *mut c_void,
                &mut size,
                0,
                AF_INET as u32,
                UDP_TABLE_OWNER_PID,
                0,
            ) != 0
            {
                return;
            }

            let count = *buf.as_ptr() as usize;
            let rows = buf.as_ptr().add(1) as *const MIB_UDPROW_OWNER_PID;
            for i in 0..count {
                let row = std::ptr::read_unaligned(rows.add(i));
                out.push(PortInfo {
                    proto: "udp",
                    family: "v4",
                    local_addr: Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string(),
                    local_port: port(row.dwLocalPort),
                    remote_addr: None,
                    remote_port: None,
                    state: "UDP",
                    pid: row.dwOwningPid,
                });
            }
        }
    }

    fn udp_v6(out: &mut Vec<PortInfo>) {
        unsafe {
            let mut size = 0u32;
            let ret = GetExtendedUdpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                AF_INET6 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
            if (ret != ERROR_INSUFFICIENT_BUFFER && ret != 0) || size == 0 {
                return;
            }

            let mut buf = vec![0u32; (size as usize).div_ceil(4)];
            if GetExtendedUdpTable(
                buf.as_mut_ptr() as *mut c_void,
                &mut size,
                0,
                AF_INET6 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            ) != 0
            {
                return;
            }

            let count = *buf.as_ptr() as usize;
            let rows = buf.as_ptr().add(1) as *const MIB_UDP6ROW_OWNER_PID;
            for i in 0..count {
                let row = std::ptr::read_unaligned(rows.add(i));
                out.push(PortInfo {
                    proto: "udp",
                    family: "v6",
                    local_addr: ipv6_text(row.ucLocalAddr, row.dwLocalScopeId),
                    local_port: port(row.dwLocalPort),
                    remote_addr: None,
                    remote_port: None,
                    state: "UDP",
                    pid: row.dwOwningPid,
                });
            }
        }
    }

    fn collect_ports() -> Vec<PortInfo> {
        let mut out = Vec::new();
        tcp_v4(&mut out);
        tcp_v6(&mut out);
        udp_v4(&mut out);
        udp_v6(&mut out);
        out.sort_by(|a, b| {
            a.local_port
                .cmp(&b.local_port)
                .then(a.proto.cmp(b.proto))
                .then(a.pid.cmp(&b.pid))
        });
        out
    }

    /* ---------------- 终止 ---------------- */

    fn terminate(pid: u32) -> Result<(), String> {
        unsafe {
            let Some(handle) = OwnedHandle::new(OpenProcess(PROCESS_TERMINATE, 0, pid)) else {
                return Err(last_error("无法打开进程"));
            };
            if TerminateProcess(handle.raw(), 1) == 0 {
                return Err(last_error("终止进程失败"));
            }
            Ok(())
        }
    }

    fn refuse_reason(pid: u32, name: &str, self_session: u32) -> Option<String> {
        if pid == unsafe { GetCurrentProcessId() } {
            return Some("不能结束 AppDeck 自身".to_string());
        }
        if pid <= 4 {
            return Some("系统进程".to_string());
        }
        if is_critical(pid) {
            return Some("Windows 关键进程，结束可能导致系统不稳定".to_string());
        }
        // 其他会话里、又装在 Windows 目录下的，是操作系统服务；第三方服务
        // （Clash / MySQL…）允许尝试结束，非管理员会得到权限不足的提示。
        if session_of(pid).is_some_and(|session| session != self_session)
            && exe_of(pid).is_some_and(|exe| is_under_windows(&exe))
        {
            return Some("Windows 系统服务进程".to_string());
        }
        if is_core_name(&name.to_ascii_lowercase()) {
            return Some("系统核心进程".to_string());
        }
        None
    }

    fn collect_tree(root: u32) -> Vec<(u32, Option<u64>)> {
        let entries = process_entries();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, ppid, _) in entries {
            children.entry(ppid).or_default().push(pid);
        }

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut stack = vec![root];
        while let Some(pid) = stack.pop() {
            if !seen.insert(pid) {
                continue;
            }
            // 进程树被异常拉得很大时截断，避免一次确认杀掉半个系统
            if out.len() >= 256 {
                break;
            }
            out.push((pid, start_ms_of(pid)));
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
        out
    }

    pub fn kill(pid: u32, expect_start_ms: Option<u64>, tree: bool) -> Result<KillReport, String> {
        if pid <= 4 {
            return Err("不能结束系统进程".to_string());
        }
        if pid == unsafe { GetCurrentProcessId() } {
            return Err("不能结束 AppDeck 自身".to_string());
        }

        let names: HashMap<u32, String> = process_entries()
            .into_iter()
            .map(|(pid, _, name)| (pid, name))
            .collect();
        let self_session = session_of(unsafe { GetCurrentProcessId() }).unwrap_or(0);

        let mut targets: Vec<(u32, Option<u64>)> = if tree {
            collect_tree(pid)
        } else {
            let start = expect_start_ms.or_else(|| start_ms_of(pid));
            vec![(pid, start)]
        };
        if targets.is_empty() {
            return Err("进程不存在或已经退出".to_string());
        }
        // 先杀子进程，再杀根进程（TerminateProcess 不会级联）
        targets.reverse();

        let mut killed = Vec::new();
        let mut failed = Vec::new();

        for (target, expect) in targets {
            if target == unsafe { GetCurrentProcessId() } {
                failed.push(KillFailure {
                    pid: target,
                    error: "不能结束 AppDeck 自身".to_string(),
                });
                continue;
            }
            if target <= 4 {
                failed.push(KillFailure {
                    pid: target,
                    error: "系统进程".to_string(),
                });
                continue;
            }

            let name = names.get(&target).cloned().unwrap_or_default();
            if let Some(reason) = refuse_reason(target, &name, self_session) {
                failed.push(KillFailure {
                    pid: target,
                    error: reason,
                });
                continue;
            }

            let actual = start_ms_of(target);
            match (expect, actual) {
                (Some(want), Some(got)) if want == got => {}
                (_, None) => {
                    failed.push(KillFailure {
                        pid: target,
                        error: "进程已退出".to_string(),
                    });
                    continue;
                }
                (Some(_), Some(_)) => {
                    failed.push(KillFailure {
                        pid: target,
                        error: "PID 已被复用，已跳过".to_string(),
                    });
                    continue;
                }
                (None, Some(_)) => {}
            }

            match terminate(target) {
                Ok(()) => killed.push(target),
                Err(e) => failed.push(KillFailure {
                    pid: target,
                    error: e,
                }),
            }
        }

        if killed.is_empty() {
            let msg = failed
                .first()
                .map(|f| f.error.clone())
                .unwrap_or_else(|| "没有可结束的进程".to_string());
            return Err(msg);
        }
        Ok(KillReport { killed, failed })
    }

    /* ---------------- 测试 ---------------- */

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn state_names_cover_common_tcp_states() {
            assert_eq!(tcp_state(MIB_TCP_STATE_LISTEN as u32), "LISTEN");
            assert_eq!(tcp_state(MIB_TCP_STATE_ESTAB as u32), "ESTABLISHED");
            assert_eq!(tcp_state(999), "UNKNOWN");
        }

        #[test]
        fn ports_decode_from_network_byte_order() {
            // 127.0.0.1:8080 → dwLocalAddr 0x0100007F, dwLocalPort 0x901F
            assert_eq!(Ipv4Addr::from(u32::from_be(0x0100_007F)).to_string(), "127.0.0.1");
            assert_eq!(port(0x901F), 8080);
        }

        #[test]
        fn windows_dir_check_only_matches_system_root() {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
            assert!(is_under_windows(&format!(r"{root}\System32\svchost.exe")));
            assert!(!is_under_windows(r"D:\apps\nginx\nginx.exe"));
        }

        #[test]
        fn snapshot_includes_self() {
            let snap = snapshot();
            let self_pid = unsafe { GetCurrentProcessId() };
            let me = snap
                .processes
                .iter()
                .find(|p| p.pid == self_pid)
                .expect("快照里应包含当前测试进程");
            assert!(me.is_self);
            assert!(!me.system, "自己不应被标记成系统进程");
            assert!(me.exe.is_some(), "自己的可执行路径应可读");
        }

        /// 起一个真实监听端口，端口表里必须能按「端口 + 自己 PID」找到它。
        #[test]
        fn snapshot_maps_listening_port_to_owner() {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("绑定临时端口");
            let port = listener.local_addr().unwrap().port();
            let snap = snapshot();
            let hit = snap.ports.iter().find(|p| {
                p.proto == "tcp"
                    && p.local_port == port
                    && p.pid == unsafe { GetCurrentProcessId() }
                    && p.state == "LISTEN"
            });
            assert!(hit.is_some(), "端口 {port} 应归属当前进程且状态为 LISTEN");
            drop(listener);
        }

        #[test]
        fn kill_guards_self_and_system() {
            let self_pid = unsafe { GetCurrentProcessId() };
            assert!(kill(self_pid, None, false).is_err());
            assert!(kill(4, None, false).is_err());
            assert!(kill(0, None, false).is_err());
        }
    }
}
