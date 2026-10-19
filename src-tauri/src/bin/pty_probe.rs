//! 临时探针：验证 ConPTY 在本机能否正常工作。
//! 运行：cargo run --bin pty_probe

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() {
    let pty = native_pty_system();
    let pair = match pty.openpty(PtySize {
        rows: 24,
        cols: 100,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            println!("openpty 失败: {e}");
            std::process::exit(2);
        }
    };

    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.args(["/d", "/c", "echo", "HELLO-CONPTY"]);
    cmd.cwd(std::env::current_dir().unwrap_or_default());

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            println!("spawn 失败: {e}");
            std::process::exit(3);
        }
    };
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("读端失败");
    let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("写端失败")));

    println!("[probe] 已创建 ConPTY，等待输出...");

    let w = writer.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    println!("[chunk {n}] {text:?}");

                    // ConPTY 启动时会发 DSR(ESC[6n) 查询光标位置，
                    // 必须应答，否则它会一直等下去。真实终端（xterm.js）会自动应答。
                    if text.contains("\u{1b}[6n") {
                        println!("[probe] 收到 DSR，回复位置");
                        if let Ok(mut wr) = w.lock() {
                            let _ = wr.write_all(b"\x1b[1;1R");
                            let _ = wr.flush();
                        }
                    }

                    if text.contains("HELLO-CONPTY") {
                        println!("[probe] MATCH");
                        std::process::exit(0);
                    }
                }
                Err(e) => {
                    println!("[read err] {e}");
                    break;
                }
            }
        }
    });

    std::thread::sleep(Duration::from_secs(10));
    let _ = child.try_wait();
    println!("[probe] 超时未匹配");
    std::process::exit(1);
}
