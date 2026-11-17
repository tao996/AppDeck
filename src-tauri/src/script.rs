//! 「从脚本导入命令」：把 .ps1 / .bat / .sh / .py … 变成一条可直接运行的命令。
//!
//! 规则（与 `ops::shell_line_for` 的执行方式配套）：
//!
//! - `.ps1` / `.bat` / `.cmd`：直接以脚本为 program，后端已经会用
//!   PowerShell（含 ExecutionPolicy Bypass）或 cmd 包装，不需要再套解释器。
//! - `.sh` / `.bash` / `.zsh`：`bash <脚本>`（Windows 上通常是 Git Bash / WSL）。
//! - `.py`：**优先用虚拟环境里的 python.exe**，而不是 `activate` 之后再跑。
//!   直接调用 venv 解释器与"先 activate 再 python"等价（`sys.prefix` 指向 venv），
//!   而且不依赖当前 shell 里残留的环境，换终端/重跑都一致。
//! - `.js` / `.rb` / `.pl` / `.php`：对应解释器 + 脚本。
//! - 其它扩展名：当作可执行文件直接跑。
//!
//! 工作目录一律是**脚本所在目录**：用项目内相对路径保存（项目搬家不失效），
//! 项目外则用绝对路径。

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VenvOption {
    /// 显示名（如 `.venv`）
    pub label: String,
    /// venv 根目录
    pub dir: String,
    /// 该 venv 里的 python 可执行文件
    pub python: String,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScriptCommand {
    pub name: String,
    /// 固定为 custom：脚本命令都按「程序 + 参数」直接执行
    pub kind: String,
    pub program: String,
    pub args: Vec<String>,
    /// 脚本所在目录（项目内 → 相对项目根；项目外 → 绝对路径）
    pub cwd: Option<String>,
    /// 给对话框显示的说明（用了哪个解释器 / 虚拟环境）
    pub note: String,
    /// 识别到的虚拟环境（仅 .py 有意义）
    pub venv: Option<String>,
    /// 可选的虚拟环境列表（给对话框的下拉用）
    pub venvs: Vec<VenvOption>,
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 把目录表示成「相对项目根」或绝对路径。
/// 项目根本身 → None（命令的 cwd 留空就是项目根）。
fn cwd_value(dir: &Path, root: Option<&Path>) -> Option<String> {
    let dir_s = dir.display().to_string();
    let Some(root) = root else {
        return Some(dir_s);
    };
    let root_s = crate::ops::normalize(&root.display().to_string());
    let norm = crate::ops::normalize(&dir_s);

    let (a, b) = (norm.to_lowercase(), root_s.to_lowercase());
    if a == b {
        return None;
    }
    // Windows 路径大小写不敏感：用统一大小写后的前缀判断
    let sep = if a.starts_with(&b) {
        a[b.len()..].chars().next()
    } else {
        None
    };
    if sep == Some('\\') || sep == Some('/') {
        let rel = &norm[b.len() + 1..];
        if !rel.is_empty() {
            return Some(rel.to_string());
        }
    }
    Some(dir_s)
}

fn which_or_name(name: &str) -> String {
    crate::terminal::which(name)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| name.to_string())
}

/// venv 里的 python：Windows 是 Scripts\python.exe，类 Unix 是 bin/python；
/// conda 环境的 python.exe 直接在根目录。
fn venv_python(venv: &Path) -> Option<PathBuf> {
    for cand in [
        venv.join("Scripts").join("python.exe"),
        venv.join("python.exe"),
        venv.join("bin").join("python"),
    ] {
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn is_venv_dir(dir: &Path) -> bool {
    dir.join("pyvenv.cfg").is_file() || dir.join("conda-meta").is_dir()
}

/// 从脚本目录往上找虚拟环境（最多 6 层），同时看常见目录名。
fn find_venvs(script_dir: &Path) -> Vec<VenvOption> {
    let mut out: Vec<VenvOption> = Vec::new();
    let mut dir = Some(script_dir);

    for _ in 0..6 {
        let Some(cur) = dir else { break };

        let mut candidates: Vec<PathBuf> = Vec::new();
        for name in [".venv", "venv", "env", ".env"] {
            candidates.push(cur.join(name));
        }
        candidates.push(cur.to_path_buf()); // 脚本目录本身可能就是 venv

        for cand in candidates {
            if !is_venv_dir(&cand) {
                continue;
            }
            let Some(py) = venv_python(&cand) else {
                continue;
            };
            let dir_s = cand.display().to_string();
            if out.iter().any(|v| v.dir.eq_ignore_ascii_case(&dir_s)) {
                continue;
            }
            let label = cand
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| dir_s.clone());
            out.push(VenvOption {
                label,
                dir: dir_s,
                python: py.display().to_string(),
            });
        }

        dir = cur.parent();
    }

    out
}

/// 生成「导入脚本」的结果（不落盘，前端拿去填表单）。
///
/// `mode`：
/// - `"project"`（默认）：项目命令，.ps1 / .bat 直接以脚本为 program（后端会套 shell）
/// - `"global"`：顶部「自定义命令」直接 CreateProcess，.ps1 必须显式套 PowerShell，
///   .bat / .cmd 不支持（与 `custom_cmd` 的既有约束一致）
pub fn preview(
    path: &str,
    project_root: Option<&Path>,
    mode: Option<&str>,
    powershell: Option<&Path>,
) -> Result<ScriptCommand, String> {
    let global = mode == Some("global");
    let script = PathBuf::from(path.trim());
    if !script.is_file() {
        return Err(format!("脚本不存在：{}", script.display()));
    }

    let dir = script
        .parent()
        .ok_or_else(|| "无法确定脚本所在目录".to_string())?
        .to_path_buf();

    let name = script
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| script.display().to_string());

    let script_s = script.display().to_string();
    let mut out = ScriptCommand {
        name,
        kind: "custom".to_string(),
        program: script_s.clone(),
        args: Vec::new(),
        cwd: cwd_value(&dir, project_root),
        note: String::new(),
        venv: None,
        venvs: Vec::new(),
    };

    match ext_of(&script).as_str() {
        "ps1" => {
            if global {
                // 顶部「自定义命令」不经过 shell，必须显式用 PowerShell 跑 -File
                out.program = powershell
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| which_or_name("powershell"));
                out.args = vec![
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-File".to_string(),
                    script_s.clone(),
                ];
                out.note = "用 PowerShell -File 执行（全局自定义命令不经过 shell，必须显式套解释器）"
                    .to_string();
            } else {
                out.note = "用 PowerShell 执行（自动带 -ExecutionPolicy Bypass）".to_string();
            }
        }
        "bat" | "cmd" => {
            if global {
                return Err(
                    "全局自定义命令不支持 .bat / .cmd（会弹出系统控制台）；\
                     请改用项目命令，或用快捷方式指向 exe"
                        .to_string(),
                );
            }
            out.note = "用 cmd.exe 执行".to_string();
        }
        "sh" | "bash" | "zsh" => {
            out.program = which_or_name("bash");
            out.args = vec![script_s.clone()];
            out.note = "用 bash 执行（Windows 需要 Git Bash / WSL 提供的 bash 在 PATH 里）".to_string();
        }
        "py" => {
            let venvs = find_venvs(&dir);
            out.venvs = venvs.clone();

            match venvs.first() {
                Some(v) => {
                    out.program = v.python.clone();
                    out.args = vec![script_s.clone()];
                    out.venv = Some(v.dir.clone());
                    out.note = format!(
                        "使用虚拟环境 {} 里的 python.exe（等价于先 activate，再跑脚本）",
                        v.dir
                    );
                }
                None => {
                    out.program = which_or_name("python");
                    out.args = vec![script_s.clone()];
                    out.note =
                        "没发现虚拟环境，使用 PATH 里的 python；有 .venv / venv 时建议把「程序」指向其中的 python.exe"
                            .to_string();
                }
            }
        }
        "js" | "mjs" | "cjs" => {
            out.program = which_or_name("node");
            out.args = vec![script_s.clone()];
            out.note = "用 node 执行".to_string();
        }
        "rb" => {
            out.program = which_or_name("ruby");
            out.args = vec![script_s.clone()];
            out.note = "用 ruby 执行".to_string();
        }
        "pl" => {
            out.program = which_or_name("perl");
            out.args = vec![script_s.clone()];
            out.note = "用 perl 执行".to_string();
        }
        "php" => {
            out.program = which_or_name("php");
            out.args = vec![script_s.clone()];
            out.note = "用 php 执行".to_string();
        }
        _ => {
            out.note = "按可执行文件直接运行（没有识别到解释器扩展名）".to_string();
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{cwd_value, find_venvs, preview};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("fla_script_{tag}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn cwd_is_relative_inside_project_and_absolute_outside() {
        let root = temp_dir("cwd");
        let sub = root.join("tools");
        std::fs::create_dir_all(&sub).unwrap();

        assert_eq!(cwd_value(&root, Some(&root)), None);
        assert_eq!(
            cwd_value(&sub, Some(&root)).as_deref(),
            Some("tools"),
            "项目内应存相对路径"
        );

        let outside = std::env::temp_dir().join("fla_script_outside");
        std::fs::create_dir_all(&outside).unwrap();
        assert_eq!(
            cwd_value(&outside, Some(&root)).as_deref(),
            Some(outside.display().to_string().as_str()),
            "项目外应存绝对路径"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn ps1_and_bat_point_at_the_script() {
        let root = temp_dir("ps1");
        let ps1 = root.join("build.ps1");
        std::fs::write(&ps1, "Write-Host hi").unwrap();
        let bat = root.join("run.bat");
        std::fs::write(&bat, "echo hi").unwrap();

        let a = preview(&ps1.display().to_string(), Some(&root), None, None).unwrap();
        assert_eq!(a.program, ps1.display().to_string());
        assert!(a.args.is_empty());
        assert_eq!(a.cwd, None);

        let b = preview(&bat.display().to_string(), Some(&root), None, None).unwrap();
        assert_eq!(b.program, bat.display().to_string());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn global_ps1_is_wrapped_with_powershell_file() {
        let root = temp_dir("ps1_global");
        let ps1 = root.join("build.ps1");
        std::fs::write(&ps1, "Write-Host hi").unwrap();

        let ps = std::path::PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        let got = preview(
            &ps1.display().to_string(),
            None,
            Some("global"),
            Some(&ps),
        )
        .unwrap();

        assert_eq!(got.program, ps.display().to_string());
        assert_eq!(got.args.first().map(String::as_str), Some("-NoLogo"));
        assert!(got.args.iter().any(|a| a == "-File"), "{:?}", got.args);
        assert_eq!(got.args.last(), Some(&ps1.display().to_string()));

        // 全局命令不经过 shell，.bat/.cmd 明确不支持
        let bat = root.join("run.bat");
        std::fs::write(&bat, "echo hi").unwrap();
        let err = preview(&bat.display().to_string(), None, Some("global"), None).unwrap_err();
        assert!(err.contains(".bat"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sh_uses_bash_plus_script() {
        let root = temp_dir("sh");
        let sh = root.join("deploy.sh");
        std::fs::write(&sh, "echo hi").unwrap();

        let got = preview(&sh.display().to_string(), Some(&root), None, None).unwrap();
        assert!(got.program.to_ascii_lowercase().contains("bash"));
        assert_eq!(got.args, vec![sh.display().to_string()]);
        assert!(got.venv.is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn py_prefers_venv_python() {
        let root = temp_dir("py");
        let script = root.join("app.py");
        std::fs::write(&script, "print(1)").unwrap();

        // 造一个 .venv：pyvenv.cfg + Scripts/python.exe
        let venv = root.join(".venv");
        std::fs::create_dir_all(venv.join("Scripts")).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "home = x").unwrap();
        let py = venv.join("Scripts").join("python.exe");
        std::fs::write(&py, b"x").unwrap();

        let venvs = find_venvs(&root);
        assert_eq!(venvs.len(), 1, "应只识别出一个 venv: {venvs:?}");
        assert_eq!(venvs[0].label, ".venv");

        let got = preview(&script.display().to_string(), Some(&root), None, None).unwrap();
        assert_eq!(got.program, py.display().to_string());
        assert_eq!(got.args, vec![script.display().to_string()]);
        assert_eq!(got.venv.as_deref(), Some(venv.display().to_string().as_str()));

        // 脚本在子目录里也要能找到上层的 .venv
        let sub = root.join("jobs");
        std::fs::create_dir_all(&sub).unwrap();
        let nested = sub.join("job.py");
        std::fs::write(&nested, "print(2)").unwrap();
        let got2 = preview(&nested.display().to_string(), Some(&root), None, None).unwrap();
        assert_eq!(got2.program, py.display().to_string());
        assert_eq!(got2.cwd.as_deref(), Some("jobs"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn py_without_venv_falls_back_to_path_python() {
        let root = temp_dir("py_novenv");
        let script = root.join("tool.py");
        std::fs::write(&script, "print(1)").unwrap();

        let got = preview(&script.display().to_string(), Some(&root), None, None).unwrap();
        assert_eq!(got.venvs.len(), 0);
        assert!(got.program.to_ascii_lowercase().contains("python"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_script_is_an_error() {
        let err = preview(r"C:\definitely\not\here\x.py", None, None, None).unwrap_err();
        assert!(err.contains("脚本不存在"), "{err}");
    }

    #[test]
    fn name_is_script_stem() {
        let root = temp_dir("name");
        let p = root.join("release_check.py");
        std::fs::write(&p, "").unwrap();
        assert_eq!(
            preview(&p.display().to_string(), None, None, None).unwrap().name,
            "release_check"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
