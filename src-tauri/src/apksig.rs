//! 解析 APK Signing Block（V2 / V3），取出签名证书 DER。
//!
//! **为什么需要自己解析**：`apksigner --print-certs` 只输出指纹（MD5/SHA1/SHA256）
//! 与 DN，**不输出公钥**；而备案要的"应用公钥"必须是 SPKI 的 Base64。
//! `keytool` 又只认 keystore、不认 V2-only 的 APK，于是只能自己读签名块。
//!
//! 结构（`apksigv2` 规范）：
//!
//! ```text
//! APK 文件： ... [APK Signing Block] [ZIP Central Directory] [EOCD]
//!
//! Signing Block:
//!   uint64  size（不含本字段）
//!   ( pair )*           // 每个 pair: uint64 len（含 id）, uint32 id, value
//!   uint64  size（同上）
//!   16 字节  "APK Sig Block 42"
//! ```
//!
//! V2 的 id 是 `0x7109871a`，V3 是 `0xf05368c0`。两者的**前缀结构一致**：
//! `signers(lp) → signer[0].signed_data(lp) → digests(lp) → certificates(lp)`，
//! 差异只在其后（V3 多了 minSdk/maxSdk）。因此只读到证书列表即可，
//! 不必区分版本——这也是本实现保持简单的原因。
//!
//! 拿到 DER 后，MD5 与公钥都能自算，且可与 `apksigner` 的 MD5 交叉校验。

use base64::Engine as _;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MAGIC: &[u8; 16] = b"APK Sig Block 42";
const ID_V2: u32 = 0x7109_871a;
const ID_V3: u32 = 0xf053_68c0;
const ID_V3_1: u32 = 0x1b93_ad61;

#[derive(Clone, Debug)]
pub struct SigningCert {
    /// 证书 DER（X.509）
    pub der: Vec<u8>,
    /// 命中的签名块版本："V2" / "V3"
    pub scheme: &'static str,
}

fn u32_at(b: &[u8], p: usize) -> Option<usize> {
    let s = b.get(p..p + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}

fn u64_at(b: &[u8], p: usize) -> Option<u64> {
    let s = b.get(p..p + 8)?;
    let mut a = [0u8; 8];
    a.copy_from_slice(s);
    Some(u64::from_le_bytes(a))
}

/// EOCD 签名 `PK\x05\x06` 的偏移（从文件尾向前扫）
fn find_eocd(tail: &[u8]) -> Option<usize> {
    if tail.len() < 22 {
        return None;
    }
    let mut i = tail.len() - 22;
    loop {
        if tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06] {
            return Some(i);
        }
        if i == 0 {
            return None;
        }
        i -= 1;
    }
}

/// 从 V2/V3 块的值里取第一个签名证书。
///
/// 层级（实测字节级确认）：
/// ```text
/// u32 signers_len
///   u32 signer_len
///     u32 signed_data_len
///       u32 digests_len
///       digests
///       u32 certs_len
///         u32 cert_len + DER          ← 要的就是这里
///         ...
///       u32 attrs_len
/// ```
fn first_cert(value: &[u8]) -> Option<Vec<u8>> {
    let mut p = 0usize;

    let signers_len = u32_at(value, p)?;
    p += 4;
    if signers_len == 0 {
        return None;
    }

    // 第一个 signer（这一层最初被我漏掉，导致后续全部错位）
    let _signer_len = u32_at(value, p)?;
    p += 4;

    let signed_len = u32_at(value, p)?;
    p += 4;
    let signed_end = p.checked_add(signed_len)?;
    if signed_end > value.len() {
        return None;
    }

    // signed data 内：digests（长度前缀）→ certificates（长度前缀的序列）
    let digests_len = u32_at(value, p)?;
    p += 4 + digests_len;

    let certs_len = u32_at(value, p)?;
    p += 4;
    if certs_len == 0 {
        return None;
    }

    let cert_len = u32_at(value, p)?;
    p += 4;

    value.get(p..p.checked_add(cert_len)?).map(|s| s.to_vec())
}

/// 读取 APK 的签名证书
pub fn read_signing_cert(path: &Path) -> Result<SigningCert, String> {
    let mut file = File::open(path).map_err(|e| format!("打开 APK 失败: {e}"))?;
    let len = file
        .seek(SeekFrom::End(0))
        .map_err(|e| format!("读取大小失败: {e}"))?;

    if len < 32 {
        return Err("不是有效的 APK（文件过小）".to_string());
    }

    // 1) 读文件尾，定位 EOCD
    let tail_len = len.min(65557) as usize; // EOCD 最大 22 + 65535 注释
    let mut tail = vec![0u8; tail_len];
    file.seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|e| format!("定位 EOCD 失败: {e}"))?;
    file.read_exact(&mut tail)
        .map_err(|e| format!("读取文件尾失败: {e}"))?;

    let eocd = find_eocd(&tail).ok_or_else(|| "找不到 EOCD（不是 ZIP/APK）".to_string())?;
    let cd_offset = u32_at(&tail, eocd + 16).ok_or("EOCD 结构异常")? as u64;

    if cd_offset < 32 || cd_offset > len {
        return Err("中央目录偏移异常".to_string());
    }

    // 2) 读 Signing Block 尾部（size + magic）
    if cd_offset < 24 {
        return Err("没有 APK Signing Block（可能未签名）".to_string());
    }
    let mut footer = [0u8; 24];
    file.seek(SeekFrom::Start(cd_offset - 24))
        .map_err(|e| format!("定位签名块失败: {e}"))?;
    file.read_exact(&mut footer)
        .map_err(|e| format!("读取签名块尾部失败: {e}"))?;

    if &footer[8..24] != MAGIC {
        return Err("没有 APK Signing Block（该包可能只有 V1 签名或未签名）".to_string());
    }

    let block_size = u64_at(&footer, 0).ok_or("签名块长度异常")?;
    if block_size < 24 || block_size + 8 > cd_offset {
        return Err("签名块长度异常".to_string());
    }

    // 尾部 size 字段的值 = 块总长 − 8（不含自身），所以起点要再减 8
    let block_start = cd_offset - block_size - 8;
    let pairs_len = (block_size as usize) - 24; // 去掉首尾 size 与 magic

    // 3) 读 pairs 区（紧跟开头的 size 字段）
    let mut pairs = vec![0u8; pairs_len];
    file.seek(SeekFrom::Start(block_start + 8))
        .map_err(|e| format!("定位签名块内容失败: {e}"))?;
    file.read_exact(&mut pairs)
        .map_err(|e| format!("读取签名块内容失败: {e}"))?;

    // 4) 遍历 pair，找 V2/V3
    let mut p = 0usize;
    while p + 12 <= pairs.len() {
        let pair_len = u64_at(&pairs, p).ok_or("pair 长度异常")? as usize;
        p += 8;
        if pair_len < 4 || p + pair_len > pairs.len() {
            break;
        }

        let id = u32_at(&pairs, p).ok_or("pair id 异常")? as u32;
        let value = &pairs[p + 4..p + pair_len];

        let scheme = match id {
            ID_V2 => Some("V2"),
            ID_V3 => Some("V3"),
            ID_V3_1 => Some("V3"),
            _ => None,
        };

        if let Some(scheme) = scheme {
            if let Some(der) = first_cert(value) {
                return Ok(SigningCert { der, scheme });
            }
        }

        p += pair_len;
    }

    Err("签名块里没有找到 V2/V3 签名证书（可能只有 V1 签名）".to_string())
}

/// 证书 DER → SPKI 的 Base64（备案要的"应用公钥"）
pub fn public_key_base64(der: &[u8]) -> Result<String, String> {
    let (_, cert) =
        x509_parser::parse_x509_certificate(der).map_err(|e| format!("解析 X.509 失败: {e}"))?;

    // SubjectPublicKeyInfo 的完整 DER，正是 openssl `-pubkey` 输出的那段
    let spki = cert.public_key().raw;
    if spki.is_empty() {
        return Err("证书里没有公钥".to_string());
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(spki))
}

/// 证书 DER 的 MD5（备案口径：大写冒号分隔）
pub fn md5_of(der: &[u8]) -> String {
    use md5::{Digest, Md5};
    let digest = Md5::digest(der);

    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机真实样本（Flutter debug 包，V2 签名）
    const SAMPLE: &str = r"D:\demo\code\flutter\library\projects\days\build\app\outputs\apk\debug\app-debug.apk";
    /// apksigner 给出的 MD5，用于交叉验证
    const EXPECTED_MD5: &str = "D0:A9:9C:BC:6B:69:44:49:E2:FD:DF:72:23:92:E4:78";

    #[test]
    fn parses_real_apk_and_matches_apksigner() {
        let path = Path::new(SAMPLE);
        if !path.is_file() {
            eprintln!("跳过：样本 APK 不存在");
            return;
        }

        let cert = read_signing_cert(path).expect("应能解析签名块");
        assert_eq!(cert.scheme, "V2", "样本是 V2 签名");
        assert!(!cert.der.is_empty());

        // **核心断言**：自解析的证书 MD5 必须等于 apksigner 的 MD5
        assert_eq!(
            md5_of(&cert.der),
            EXPECTED_MD5,
            "自解析 MD5 与 apksigner 不一致，说明签名块解析有误"
        );

        let pk = public_key_base64(&cert.der).expect("应能取出公钥");
        assert!(pk.len() > 100, "公钥 Base64 长度异常: {}", pk.len());
        assert!(
            pk.starts_with("MIIB") || pk.starts_with("MIICI"),
            "公钥应以 SPKI 的 DER 头开始: {}",
            &pk[..12.min(pk.len())]
        );

        println!("scheme={} md5={} pubkey_len={}", cert.scheme, md5_of(&cert.der), pk.len());
    }

    #[test]
    fn rejects_non_zip_and_missing_files() {
        let missing = read_signing_cert(Path::new(r"D:\nope\x.apk"));
        assert!(missing.is_err());

        let tmp = std::env::temp_dir().join("fla_not_zip.apk");
        std::fs::write(&tmp, vec![0u8; 64]).unwrap();
        let bad = read_signing_cert(&tmp);
        assert!(bad.is_err());
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn md5_format_is_upper_colon() {
        assert_eq!(md5_of(b""), "D4:1D:8C:D9:8F:00:B2:04:E9:80:09:98:EC:F8:42:7E");
    }
}
