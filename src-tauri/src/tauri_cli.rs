//! 把 `"tauri": "tauri"` 这种"什么都没配"的脚本展开成 tauri CLI 自己的子命令。
//!
//! 光有一条 `npm run tauri` 在树里是没有意义的（它只会打印帮助）。
//! 子命令列表**从 CLI 的 `--help` 里解析**，不硬编码——tauri 升级后照样对得上。
//! 解析到的不一定都值得放进树里：`add` / `permission` / `completions` 之类
//! 属于一次性配置操作，放进去只是噪音，所以只保留日常真正会用的那几个。

use crate::model::Command;
use crate::npm::Manager;
use std::path::Path;
use std::process::Command as PCommand;

/// 一次展开的结果：一行一个命令
pub struct Expanded {
    pub label: String,
    pub args: Vec<String>,
    /// run | build | custom
    pub kind: &'static str,
}

/// 解析 `--help` 输出里的 `Commands:` 段。
///
/// clap 的格式：
/// ```text
/// Commands:
///   dev          Run your app in development mode
///   build        Build your app in release mode ...
///
/// Options:
/// ```
pub fn parse_commands(help: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut in_commands = false;

    for line in help.lines() {
        if !in_commands {
            if line.trim() == "Commands:" {
                in_commands = true;
            }
            continue;
        }

        // 空行或下一个段落 = 结束
        if line.trim().is_empty() || !line.starts_with(' ') {
            break;
        }

        let body = line.trim_start();
        let Some(name) = body.split_whitespace().next() else {
            continue;
        };
        // `help` 是 clap 自动加的自助命令，没有实际意义
        if name == "help" {
            continue;
        }
        let desc = body[name.len()..].trim().to_string();
        out.push((name.to_string(), desc));
    }

    out
}

/// 从"有哪些子命令"推出"该生成哪几条命令"。纯函数，便于测试。
pub fn plan(top: &[String], android: &[String], ios: &[String]) -> Vec<Expanded> {
    let mut out = Vec::new();
    let has = |list: &[String], name: &str| list.iter().any(|n| n == name);

    if has(top, "dev") {
        out.push(Expanded {
            label: "tauri dev".into(),
            args: vec!["dev".into()],
            kind: "run",
        });
    }

    if has(top, "build") {
        out.push(Expanded {
            label: "tauri build".into(),
            args: vec!["build".into()],
            kind: "build",
        });
        // 加 --debug 打包快得多，排查打包问题时常用
        out.push(Expanded {
            label: "tauri build (debug)".into(),
            args: vec!["build".into(), "--debug".into()],
            kind: "build",
        });
    }

    // 移动端：只有该平台命令存在时才加二级
    for (mobile, subs) in [("android", android), ("ios", ios)] {
        if !has(top, mobile) {
            continue;
        }
        for (sub, kind) in [("dev", "run"), ("build", "build")] {
            if has(subs, sub) {
                out.push(Expanded {
                    label: format!("tauri {mobile} {sub}"),
                    args: vec![mobile.into(), sub.into()],
                    kind,
                });
            }
        }
    }

    // 环境排错用（PR 反馈里最常被要求贴的就是它）
    if has(top, "info") {
        out.push(Expanded {
            label: "tauri info".into(),
            args: vec!["info".into()],
            kind: "custom",
        });
    }

    out
}

/// 在项目目录里跑 `<manager> run tauri -- [sub] --help`
fn help_text(dir: &Path, manager: Manager, sub: Option<&str>) -> Option<String> {
    let mut cmd = PCommand::new(manager.exe());
    cmd.arg("run").arg("tauri").arg("--");
    if let Some(s) = sub {
        cmd.arg(s);
    }
    cmd.arg("--help");
    cmd.current_dir(dir);
    crate::flutter::hide_console(&mut cmd);

    let out = cmd.output().ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    // npm 有时把有用信息写到 stderr，两股都拼上再解析
    Some(format!("{stdout}\n{stderr}"))
}

fn names(list: &[(String, String)]) -> Vec<String> {
    list.iter().map(|(n, _)| n.clone()).collect()
}

/// 探测并展开。返回空表示"探测失败"（调用方退回到原来的裸命令）。
pub fn expand(dir: &Path, manager: Manager) -> Vec<Command> {
    let Some(top_text) = help_text(dir, manager, None) else {
        return Vec::new();
    };
    let top = parse_commands(&top_text);
    if top.is_empty() {
        return Vec::new();
    }
    let top_names = names(&top);

    let nested = |sub: &str| -> Vec<String> {
        if !top_names.iter().any(|n| n == sub) {
            return Vec::new();
        }
        help_text(dir, manager, Some(sub))
            .map(|t| names(&parse_commands(&t)))
            .unwrap_or_default()
    };

    let android = nested("android");
    let ios = nested("ios");

    plan(&top_names, &android, &ios)
        .into_iter()
        .map(|e| {
            let mut args = vec!["run".to_string(), "tauri".to_string(), "--".to_string()];
            args.extend(e.args);
            Command {
                id: crate::model::make_id("npm", &e.label),
                name: e.label,
                kind: e.kind.to_string(),
                program: Some(manager.exe().to_string()),
                cwd: None,
                flutter_mode: None,
                args,
                env: Default::default(),
                tool_args: Vec::new(),
                device_id: None,
                emulator_id: None,
                build_type: None,
                source: Some("npm".to_string()),
                scope: Some("project".to_string()),
                stale: false,
                group: None,
                role: None,
                category: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实 `npm run tauri -- --help` 的输出（含 npm 自己的前缀行）。
    /// 用原始字符串：`\` 续行会吃掉行首缩进，而解析正是靠缩进识别条目。
    const TOP: &str = r#"
> app-deck@0.1.0 tauri
> tauri --help

Command line interface for building Tauri apps

Usage: npm run tauri [OPTIONS] <COMMAND>

Commands:
  init         Initialize a Tauri project in an existing directory
  dev          Run your app in development mode
  build        Build your app in release mode and generate bundles and installers
  android      Android commands
  info         Show a concise list of information about the environment
  icon         Generate various icons for all major platforms
  help         Print this message or the help of the given subcommand(s)

Options:
  -v, --verbose...  Enables verbose logging
"#;

    const ANDROID: &str = r#"Android commands

Usage: npm run tauri android [OPTIONS] <COMMAND>

Commands:
  init   Initialize Android target in the project
  dev    Run your app in development mode on Android
  build  Build your app in release mode for Android and generate APKs and AABs
  run    Run your app in production mode on Android
  help   Print this message or the help of the given subcommand(s)

Options:
"#;

    #[test]
    fn parses_subcommands_and_skips_help() {
        let list = parse_commands(TOP);
        let got = names(&list);

        assert!(got.contains(&"dev".to_string()));
        assert!(got.contains(&"build".to_string()));
        assert!(got.contains(&"android".to_string()));
        assert!(!got.contains(&"help".to_string()), "help 是 clap 自动加的，不要");
        assert!(!got.contains(&"-v".to_string()), "Options 段不能混进来");

        // 描述要留下来（证明没把描述误当成名字）
        let dev = list.iter().find(|(n, _)| n == "dev").unwrap();
        assert_eq!(dev.1, "Run your app in development mode");
    }

    #[test]
    fn plans_core_commands_and_mobile_subcommands() {
        let top = names(&parse_commands(TOP));
        let android = names(&parse_commands(ANDROID));

        let p = plan(&top, &android, &[]);
        let labels: Vec<&str> = p.iter().map(|e| e.label.as_str()).collect();

        assert!(labels.contains(&"tauri dev"));
        assert!(labels.contains(&"tauri build"));
        assert!(labels.contains(&"tauri build (debug)"));
        assert!(labels.contains(&"tauri android dev"));
        assert!(labels.contains(&"tauri android build"));
        assert!(labels.contains(&"tauri info"));
        // Windows 上没有 ios，不该凭空造出来
        assert!(!labels.iter().any(|l| l.contains("ios")));

        // 参数要带 npm 的 `--` 分隔，否则参数会被 npm 吃掉
        let dev = p.iter().find(|e| e.label == "tauri dev").unwrap();
        assert_eq!(dev.args, vec!["dev".to_string()]);
        assert_eq!(dev.kind, "run");
    }

    #[test]
    fn no_subcommands_means_no_expansion() {
        let p = plan(&[], &[], &[]);
        assert!(p.is_empty(), "探测不到子命令时不该生成任何命令");
    }

    #[test]
    fn unknown_subcommands_are_ignored() {
        // 只认识日常会用的那几个；add / permission / completions 之类不进树
        let top = vec![
            "add".to_string(),
            "permission".to_string(),
            "completions".to_string(),
        ];
        assert!(plan(&top, &[], &[]).is_empty());
    }
}
