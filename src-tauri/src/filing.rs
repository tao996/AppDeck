//! 安卓备案信息（第一期：包名 / 应用名 / 版本 / MD5 / 指纹 / 签名方案）。
//!
//! **三条实测事实决定了取数路径**（本机 JDK 17 + build-tools 37）：
//! 1. `keytool -printcert -jarfile` 对只有 V2 签名的 APK **直接失败**
//!    （META-INF 里没有 CERT.RSA）。
//! 2. JDK 17 的 `keytool -list -v` **不再输出 MD5**，只有 SHA1/SHA256。
//! 3. `apksigner verify --print-certs` 稳定给出 MD5 / SHA1 / SHA256 / DN。
//!
//! 因此：包名等来自 `aapt2 dump badging`，指纹来自 `apksigner`。
//! 公钥不在两者的输出里，第二期通过解析 APK 签名块补齐。

use crate::model::AndroidSettings;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FilingInfo {
    pub apk: String,
    pub app_label: Option<String>,
    pub package: Option<String>,
    pub version_name: Option<String>,
    pub version_code: Option<String>,
    pub min_sdk: Option<String>,
    pub target_sdk: Option<String>,
    pub md5: Option<String>,
    pub sha1: Option<String>,
    pub sha256: Option<String>,
    pub dn: Option<String>,
    pub scheme: Option<String>,
    /// 第二期：解析签名块得到
    pub public_key: Option<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

pub struct Tools {
    pub aapt2: PathBuf,
    pub apksigner: PathBuf,
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

/// "37.0.0" → [37, 0, 0]，用于挑最高版本
fn version_key(name: &str) -> Vec<u64> {
    name.split('.').filter_map(|x| x.parse::<u64>().ok()).collect()
}

fn newest_build_tools(root: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();

    dirs.sort_by_key(|p| {
        version_key(&p.file_name().unwrap_or_default().to_string_lossy())
    });

    dirs.into_iter().rev().find(|p| {
        p.join("aapt2.exe").is_file() || p.join("aapt2").is_file()
    })
}

fn exe_in(dir: &Path, name: &str) -> Option<PathBuf> {
    for ext in ["", ".exe", ".bat"] {
        let p = dir.join(format!("{name}{ext}"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn resolve_tools(s: &AndroidSettings) -> Result<Tools, String> {
    let bt_dir = clean(&s.build_tools_path)
        .map(PathBuf::from)
        .and_then(|p| {
            if p.join("aapt2.exe").is_file() {
                Some(p)
            } else {
                newest_build_tools(&p)
            }
        })
        .or_else(|| {
            clean(&s.sdk_path)
                .map(|sdk| PathBuf::from(sdk).join("build-tools"))
                .and_then(|p| newest_build_tools(&p))
        })
        .ok_or_else(|| {
            "未找到 Android build-tools（请在设置里指定 SDK 或 build-tools 目录）".to_string()
        })?;

    let aapt2 = exe_in(&bt_dir, "aapt2")
        .ok_or_else(|| format!("{} 下没有 aapt2", bt_dir.display()))?;
    let apksigner = exe_in(&bt_dir, "apksigner")
        .ok_or_else(|| format!("{} 下没有 apksigner", bt_dir.display()))?;

    Ok(Tools { aapt2, apksigner })
}

fn run(exe: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide(&mut cmd);

    let out = cmd
        .output()
        .map_err(|e| format!("调用 {} 失败: {e}", exe.display()))?;

    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(text)
}

fn field(text: &str, key: &str) -> Option<String> {
    let pos = text.find(key)?;
    let rest = text[pos + key.len()..].trim_start_matches([' ', '=']);

    // aapt2 的值形如 name='com.example.days'
    let v = if let Some(stripped) = rest.strip_prefix('\'') {
        let end = stripped.find('\'')?;
        stripped[..end].to_string()
    } else {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        rest[..end].to_string()
    };

    let v = v.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// 从 `aapt2 dump badging` 提取元信息
pub fn parse_badging(text: &str) -> (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) {
    let pkg_line = text
        .lines()
        .find(|l| l.starts_with("package:"))
        .unwrap_or_default();

    let package = field(pkg_line, "name=");
    let version_code = field(pkg_line, "versionCode=");
    let version_name = field(pkg_line, "versionName=");

    let app_label = text
        .lines()
        .find(|l| l.starts_with("application-label:"))
        .map(|l| l["application-label:".len()..].trim().trim_matches('\'').to_string())
        .filter(|s| !s.is_empty());

    let min_sdk = text
        .lines()
        .find(|l| l.starts_with("sdkVersion:"))
        .map(|l| l["sdkVersion:".len()..].trim().trim_matches('\'').to_string())
        .filter(|s| !s.is_empty());

    let target_sdk = text
        .lines()
        .find(|l| l.starts_with("targetSdkVersion:"))
        .map(|l| l["targetSdkVersion:".len()..].trim().trim_matches('\'').to_string())
        .filter(|s| !s.is_empty());

    (package, version_name, version_code, app_label, min_sdk, target_sdk)
}

/// 十六进制指纹 → 大写冒号分隔（keytool / gradle 的显示风格）
pub fn colon_hex(v: &str) -> String {
    let clean: String = v.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let upper = clean.to_ascii_uppercase();
    upper
        .as_bytes()
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect::<Vec<_>>()
        .join(":")
}

/// 从 `apksigner verify --print-certs` 提取指纹与 DN
pub fn parse_certs(text: &str) -> (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) {
    let mut md5 = None;
    let mut sha1 = None;
    let mut sha256 = None;
    let mut dn = None;
    let mut scheme: Option<String> = None;

    for line in text.lines() {
        let low = line.to_ascii_lowercase();

        if let Some(pos) = low.find("certificate dn:") {
            dn = Some(line[pos + "certificate dn:".len()..].trim().to_string())
                .filter(|s| !s.is_empty());
        } else if let Some(pos) = low.find("certificate md5 digest:") {
            md5 = Some(colon_hex(line[pos + "certificate md5 digest:".len()..].trim()));
        } else if let Some(pos) = low.find("certificate sha-1 digest:") {
            sha1 = Some(colon_hex(line[pos + "certificate sha-1 digest:".len()..].trim()));
        } else if let Some(pos) = low.find("certificate sha-256 digest:") {
            sha256 = Some(colon_hex(line[pos + "certificate sha-256 digest:".len()..].trim()));
        }

        // "V2 Signer: ..." / "Signer #1 ..." 取最高版本
        let head = line.trim_start();
        if head.starts_with('V') && head.contains("Signer") {
            if let Some(v) = head.get(1..2) {
                let cur = scheme.clone().unwrap_or_default();
                if v > cur.as_str() {
                    scheme = Some(v.to_string());
                }
            }
        }
    }

    (md5, sha1, sha256, dn, scheme)
}

fn looks_like_apk(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("apk"))
        .unwrap_or(false)
}

pub fn inspect(apk: &str, settings: &AndroidSettings) -> FilingInfo {
    let mut info = FilingInfo {
        apk: apk.to_string(),
        ..Default::default()
    };

    let path = Path::new(apk);

    // 先判扩展名：这样 .aab 无论存不存在都能给出正确的提示
    if !looks_like_apk(path) {
        info.warnings
            .push("当前版本仅支持 .apk（不支持 .aab）".to_string());
        info.error = Some("请选择 .apk 文件".to_string());
        return info;
    }
    if !path.is_file() {
        info.error = Some(format!("文件不存在：{apk}"));
        return info;
    }

    let tools = match resolve_tools(settings) {
        Ok(t) => t,
        Err(e) => {
            info.error = Some(e);
            return info;
        }
    };

    // 1) aapt2：包名 / 版本 / 应用名 / SDK
    match run(&tools.aapt2, &["dump", "badging", apk]) {
        Ok(text) => {
            let (pkg, vn, vc, label, min_sdk, target_sdk) = parse_badging(&text);
            info.package = pkg;
            info.version_name = vn;
            info.version_code = vc;
            info.app_label = label;
            info.min_sdk = min_sdk;
            info.target_sdk = target_sdk;
        }
        Err(e) => info.warnings.push(format!("aapt2 读取失败：{e}")),
    }

    // 2) apksigner：指纹 / DN / 签名方案
    match run(&tools.apksigner, &["verify", "--print-certs", apk]) {
        Ok(text) => {
            let (md5, sha1, sha256, dn, scheme) = parse_certs(&text);
            info.md5 = md5;
            info.sha1 = sha1;
            info.sha256 = sha256;
            info.dn = dn;
            info.scheme = scheme;

            if info.md5.is_none() {
                info.warnings.push(
                    "未能读取签名指纹：该 APK 可能未签名，或签名方案不受支持".to_string(),
                );
            }
        }
        Err(e) => info.warnings.push(format!("apksigner 校验失败：{e}")),
    }

    // 3) 提示类
    if let Some(dn) = &info.dn {
        if dn.to_ascii_lowercase().contains("android debug") {
            info.warnings.push(
                "当前为调试签名（CN=Android Debug），不可用于备案——请用正式签名的发布包"
                    .to_string(),
            );
        }
    }
    info.warnings.push(
        "公钥需要解析 APK 签名块，将在第二期提供；当前可先用 keystore 方式获取".to_string(),
    );

    info
}

#[cfg(test)]
mod tests {
    use super::*;

    // 本机真实输出（build-tools 37.0.0）
    const BADGING: &str = "\
package: name='com.example.days' versionCode='1' versionName='1.0.0' platformBuildVersionName='17' platformBuildVersionCode='37' compileSdkVersion='37' compileSdkVersionCodename='17'
sdkVersion:'21'
targetSdkVersion:'36'
application-label:'days'
";

    const CERTS: &str = "\
DOES NOT VERIFY
ERROR: Missing AndroidManifest.xml
V2 Signer: certificate DN: C=US, O=Android, CN=Android Debug
V2 Signer: certificate SHA-256 digest: 331b5cdfd7435233a1662c4fb0f88cedc7924e986bf673fa3b1d163319979c96
V2 Signer: certificate SHA-1 digest: 8b71ffb6e860d6b34a89a21832b4dd3212f8599f
V2 Signer: certificate MD5 digest: d0a99cbc6b694449e2fddf722392e478
";

    #[test]
    fn parses_badging() {
        let (pkg, vn, vc, label, min, target) = parse_badging(BADGING);
        assert_eq!(pkg.as_deref(), Some("com.example.days"));
        assert_eq!(vn.as_deref(), Some("1.0.0"));
        assert_eq!(vc.as_deref(), Some("1"));
        assert_eq!(label.as_deref(), Some("days"));
        assert_eq!(min.as_deref(), Some("21"));
        assert_eq!(target.as_deref(), Some("36"));
    }

    #[test]
    fn parses_cert_fingerprints() {
        let (md5, sha1, sha256, dn, scheme) = parse_certs(CERTS);

        assert_eq!(
            md5.as_deref(),
            Some("D0:A9:9C:BC:6B:69:44:49:E2:FD:DF:72:23:92:E4:78"),
            "MD5 应转成大写冒号分隔"
        );
        assert!(sha1.as_deref().unwrap().starts_with("8B:71:FF"));
        assert!(sha256.as_deref().unwrap().starts_with("33:1B:5C"));
        assert_eq!(dn.as_deref(), Some("C=US, O=Android, CN=Android Debug"));
        assert_eq!(scheme.as_deref(), Some("2"));
    }

    #[test]
    fn colon_hex_is_stable() {
        assert_eq!(colon_hex("d0a99cbc"), "D0:A9:9C:BC");
        assert_eq!(colon_hex("D0:A9:9C:BC"), "D0:A9:9C:BC");
        assert_eq!(colon_hex(""), "");
    }

    #[test]
    fn rejects_non_apk_and_missing_file() {
        let s = AndroidSettings::default();

        let missing = inspect("D:\\nope\\x.apk", &s);
        assert!(missing.error.is_some());

        let aab = inspect("D:\\nope\\x.aab", &s);
        assert!(aab.error.is_some());
        assert!(aab.warnings.iter().any(|w| w.contains(".aab")));
    }

    #[test]
    fn picks_newest_build_tools_by_version() {
        let root = std::env::temp_dir().join("fla_bt_probe");
        let _ = std::fs::remove_dir_all(&root);
        for v in ["9.0.0", "37.0.0", "10.0.0"] {
            let d = root.join(v);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("aapt2.exe"), b"x").unwrap();
        }

        let picked = newest_build_tools(&root).unwrap();
        assert_eq!(
            picked.file_name().unwrap().to_string_lossy(),
            "37.0.0",
            "应按数值而非字典序取最高版本"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
