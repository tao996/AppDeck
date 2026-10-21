//! 默认终端：从系统探测，或由用户指定可执行文件。
//!
//! 「在终端中打开」的意义在于**注入项目环境**——鸿蒙工程需要
//! FLUTTER_STORAGE_BASE_URL / DEVECO_SDK_HOME 等变量，以及指向鸿蒙分支的
//! PATH shim。这些在普通 CMD/PowerShell 里是没有的。

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCandidate {
    pub name: String,
    pub path: String,
}

pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in ["", ".exe", ".bat", ".cmd"] {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn system32(name: &str) -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot")?;
    let p = PathBuf::from(root).join("System32").join(name);
    p.is_file().then_some(p)
}

/// 常见终端，按"体验更好"排序：pwsh > Windows Terminal > powershell > cmd > bash
pub fn detect() -> Vec<TerminalCandidate> {
    let mut out: Vec<TerminalCandidate> = Vec::new();

    let mut push = |name: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            let s = p.display().to_string();
            if !out.iter().any(|c| c.path.eq_ignore_ascii_case(&s)) {
                out.push(TerminalCandidate {
                    name: name.to_string(),
                    path: s,
                });
            }
        }
    };

    push("PowerShell 7 (pwsh)", which("pwsh"));
    push("Windows Terminal", which("wt"));
    push("Windows PowerShell", which("powershell").or_else(|| system32("WindowsPowerShell\\v1.0\\powershell.exe")));
    push("命令提示符 (cmd)", which("cmd").or_else(|| system32("cmd.exe")));
    push("Git Bash", which("bash"));

    out
}

/// 解析出该用的终端：设置优先，其次自动探测，最后退回 cmd.exe
pub fn resolve(configured: Option<&str>) -> PathBuf {
    if let Some(c) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(c);
        if p.is_file() {
            return p;
        }
    }

    if let Some(first) = detect().into_iter().next() {
        return PathBuf::from(first.path);
    }

    PathBuf::from("cmd.exe")
}

/// 终端的启动参数：PowerShell 需要 `-NoLogo` 之类才能干净地进入交互
pub fn args_for(exe: &Path) -> Vec<String> {
    let name = exe
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    match name.as_str() {
        // -NoLogo 少一行横幅；-NoExit 保证交互窗口不立即退出
        "pwsh" | "powershell" => vec!["-NoLogo".to_string()],
        _ => Vec::new(),
    }
}

/// 哨兵：命令结束时打印 `__FLA_RUN_END__:<退出码>`。
///
/// 前后用 `ESC[2K\r` 抹掉整行，**用户看不见**，但原始字节流里能解析到——
/// 这样才知道 `flutter run` 什么时候退出（shell 本身不会退）。
pub const RUN_END_MARKER: &str = "__FLA_RUN_END__";

fn shell_name(exe: &Path) -> String {
    exe.file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 把一个命令包成「shell + 命令 + 哨兵」，shell 保持交互（命令结束后不退出）。
///
/// 返回 (program, args)。
pub fn wrap_run(exe: &Path, command: &str) -> (String, Vec<String>) {
    let name = shell_name(exe);
    let program = exe.display().to_string();

    match name.as_str() {
        // PowerShell：`-NoExit` 让命令跑完继续停在提示符
        "pwsh" | "powershell" => {
            let script = format!(
                "{command}; Write-Host \"`e[2K`r{RUN_END_MARKER}:$LASTEXITCODE`e[2K`r\" -NoNewline"
            );
            (
                program,
                vec![
                    "-NoLogo".to_string(),
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    script,
                ],
            )
        }
        // cmd：`/k` 同理；cmd 没有便捷的抹行手段，哨兵会留在屏幕上
        "cmd" => {
            let script = format!("{command} & echo {RUN_END_MARKER}:%ERRORLEVEL%");
            (program, vec!["/k".to_string(), script])
        }
        // bash 等：printf 抹行
        _ => {
            let script = format!(
                "{command}; printf '\\033[2K\\r{RUN_END_MARKER}:%s\\033[2K\\r' $?"
            );
            (program, vec!["-i".to_string(), "-c".to_string(), script])
        }
    }
}

/// 把裸程序名解析成**真正的可执行文件**。
///
/// Windows 上这步是必须的：`CreateProcessW("docker")` 会先命中
/// `C:\Program Files\Docker\Docker\resources\bin\docker` 那个没有扩展名的脚本，
/// 报 os error 193（不是有效的 Win32 应用程序）。`npm` 同理（真正该跑的是 npm.cmd）。
///
/// 规则：按 PATH 依次找 `<name>.exe` → `<name>.cmd` → `<name>.bat`；
/// 带路径的输入在缺扩展名时补 `.exe`；找不到就原样返回，让错误如实暴露。
pub fn resolve_executable(program: &str) -> String {
    let raw = program.trim();
    if raw.is_empty() {
        return program.to_string();
    }

    let p = Path::new(raw);
    let looks_like_path = p.is_absolute() || raw.contains('\\') || raw.contains('/');

    if looks_like_path {
        // 无扩展名时**先找 .exe**：Docker Desktop 的 bin 里同时躺着
        // `docker`（shell 脚本）和 `docker.exe`，直接返回前者就会 os error 193
        if p.extension().is_none() {
            let exe = format!("{raw}.exe");
            if Path::new(&exe).is_file() {
                return exe;
            }
        }
        // 有扩展名（或确实没有 .exe）就原样用
        return raw.to_string();
    }

    // 裸名：自己查 PATH（.exe 优先于 .cmd/.bat）
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for ext in ["exe", "cmd", "bat"] {
                let cand = dir.join(format!("{raw}.{ext}"));
                if cand.is_file() {
                    return cand.display().to_string();
                }
            }
        }
    }

    raw.to_string()
}

/// 选一个 PowerShell 来执行 .ps1：

/// 设置里的终端若是 pwsh/powershell 就用它，否则依次退回 pwsh → 系统 powershell。
pub fn powershell_for(configured: Option<&str>) -> PathBuf {
    if let Some(c) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(c);
        let n = shell_name(&p);
        if n == "pwsh" || n == "powershell" {
            return p;
        }
    }

    if let Some(p) = which("pwsh") {
        return p;
    }
    system32(r"WindowsPowerShell\v1.0\powershell.exe")
        .or_else(|| which("powershell"))
        .unwrap_or_else(|| PathBuf::from("powershell.exe"))
}

/// 用 PowerShell 执行脚本：`-NoLogo -ExecutionPolicy Bypass -File "<script>" <args>`
///
/// `-ExecutionPolicy Bypass` 是必要的：系统策略若为 Restricted，脚本会被直接拒绝。
/// 它只作用于本次进程，不改动用户机器的全局策略。
pub fn wrap_ps1(powershell: &Path, script: &str, args: &[String]) -> (String, Vec<String>) {
    let mut a = vec![
        "-NoLogo".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-File".to_string(),
        script.to_string(),
    ];
    a.extend(args.iter().cloned());
    (powershell.display().to_string(), a)
}

/// PowerShell 单引号字面量：内部单引号翻倍，`$` 不会被展开
pub fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 拼一条可在 PowerShell 里执行的命令行：`& 'prog' 'a1' 'a2'`
pub fn ps_command_line(program: &str, args: &[String]) -> String {
    let mut out = format!("& {}", ps_quote(program));
    for a in args {
        out.push(' ');
        out.push_str(&ps_quote(a));
    }
    out
}

fn cmd_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// 按目标 shell 的方言拼命令行
pub fn command_line(shell: &Path, program: &str, args: &[String]) -> String {
    if shell_name(shell) == "cmd" {
        let mut out = cmd_quote(program);
        for a in args {
            out.push(' ');
            out.push_str(&cmd_quote(a));
        }
        return out;
    }
    ps_command_line(program, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_at_least_one_terminal() {
        let list = detect();
        assert!(!list.is_empty(), "Windows 上至少应有 cmd.exe");
        assert!(
            list.iter().any(|c| c.path.to_ascii_lowercase().ends_with("cmd.exe")),
            "cmd.exe 应被探测到：{list:?}"
        );
    }

    #[test]
    fn resolve_prefers_configured_file_then_falls_back() {
        // 配置了不存在的路径 → 忽略，走自动探测
        let p = resolve(Some(r"D:\nope\terminal.exe"));
        assert!(p.is_file() || p.display().to_string().eq_ignore_ascii_case("cmd.exe"));

        // 配置了真实文件 → 直接用
        let real = std::env::var_os("SystemRoot")
            .map(|r| PathBuf::from(r).join("System32").join("cmd.exe"));
        if let Some(real) = real.filter(|p| p.is_file()) {
            let got = resolve(Some(&real.display().to_string()));
            assert_eq!(got, real);
        }
    }

#[test]
    fn bare_program_resolves_to_real_executable() {
        // 这台机器的 Docker bin 里同时有 "docker"（脚本）和 "docker.exe"，
        // 解析必须挑 .exe，否则 CreateProcess 报 os error 193
        if which("docker").is_some() {
            let r = resolve_executable("docker");
            assert!(
                r.to_ascii_lowercase().ends_with("docker.exe"),
                "应解析到 docker.exe，实际: {r}"
            );
        }

        // 带路径但缺扩展名时补 .exe
        let tmp = std::env::temp_dir().join("fla_resolve_probe");
        let _ = std::fs::create_dir_all(&tmp);
        let exe = tmp.join("mytool.exe");
        std::fs::write(&exe, b"x").unwrap();
        let input = tmp.join("mytool").display().to_string();
        assert_eq!(resolve_executable(&input), exe.display().to_string());

        // 找不到时原样返回，别假装成功
        assert_eq!(resolve_executable("no-such-tool-xyz"), "no-such-tool-xyz");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn wrap_run_keeps_shell_alive_and_appends_sentinel() {
        let (prog, args) = wrap_run(Path::new(r"C:\ps\pwsh.exe"), "& 'flutter.bat' 'run'");
        assert!(prog.ends_with("pwsh.exe"));
        let joined = args.join(" ");
        assert!(joined.contains("-NoExit"), "shell 必须保持交互：{joined}");
        assert!(joined.contains(RUN_END_MARKER), "必须带退出哨兵：{joined}");
        assert!(joined.contains("flutter.bat"), "命令要原样带上：{joined}");

        // cmd 走 /k
        let (_, args) = wrap_run(Path::new(r"C:\Windows\System32\cmd.exe"), "flutter run");
        let joined = args.join(" ");
        assert!(joined.contains("/k"));
        assert!(joined.contains(RUN_END_MARKER));
    }

    #[test]
    fn powershell_quoting_survives_spaces_and_quotes() {
        let line = ps_command_line(
            r"C:\Program Files\flutter\bin\flutter.bat",
            &[
                "run".to_string(),
                "--dart-define=A=B C".to_string(),
                "it's".to_string(),
                "$HOME".to_string(),
            ],
        );
        // 单引号包裹，内部单引号翻倍；$ 不会被展开
        assert!(line.starts_with("& 'C:\\Program Files\\flutter\\bin\\flutter.bat'"));
        assert!(line.contains("'--dart-define=A=B C'"), "含空格参数要完整包裹：{line}");
        assert!(line.contains("'it''s'"), "单引号要翻倍：{line}");
        assert!(line.contains("'$HOME'"), "$ 不能被展开：{line}");

        // cmd 方言用双引号
        let cmd_line = command_line(
            Path::new(r"C:\Windows\System32\cmd.exe"),
            r"C:\a b\flutter.bat",
            &["run".to_string()],
        );
        assert!(cmd_line.starts_with("\"C:\\a b\\flutter.bat\""), "实际: {cmd_line}");
    }

    #[test]
    fn powershell_gets_nologo() {
        assert_eq!(args_for(Path::new("C:\\ps\\pwsh.exe")), vec!["-NoLogo"]);
        assert!(args_for(Path::new("C:\\Windows\\System32\\cmd.exe")).is_empty());
    }
}






