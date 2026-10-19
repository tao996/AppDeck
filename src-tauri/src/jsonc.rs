/// JSONC 处理：剥离注释 + 去除尾随逗号。
///
/// 必须用状态机而不是正则 —— `"args": ["--dart-define=HOST=http://x"]`
/// 里的 `//` 属于字符串内容，正则会把它连同后面全部截断。
pub fn strip(input: &str) -> String {
    let src = input.trim_start_matches('\u{feff}');
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }

        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' => match chars.peek() {
                Some('/') => {
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        if n == '\n' {
                            break;
                        }
                        chars.next();
                    }
                }
                Some('*') => {
                    chars.next();
                    let mut prev = '\0';
                    while let Some(n) = chars.next() {
                        if prev == '*' && n == '/' {
                            break;
                        }
                        prev = n;
                    }
                }
                _ => out.push(c),
            },
            _ => out.push(c),
        }
    }

    remove_trailing_commas(&out)
}

fn remove_trailing_commas(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];

        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }

        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1; // 丢弃该逗号
                continue;
            }
        }

        out.push(c);
        i += 1;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::strip;

    #[test]
    fn keeps_url_inside_string() {
        let src = r#"{"a": ["--dart-define=HOST=http://api.example.com"]}"#;
        let got = strip(src);
        assert!(got.contains("http://api.example.com"));
    }

    #[test]
    fn removes_line_and_block_comments() {
        let src = "{\n  // line\n  \"a\": 1, /* block */\n  \"b\": 2\n}";
        let got = strip(src);
        assert!(!got.contains("line"));
        assert!(!got.contains("block"));
        assert!(got.contains("\"b\": 2"));
    }

    #[test]
    fn drops_trailing_commas() {
        let src = "{\"a\": [1, 2, 3,], \"b\": 1,}";
        let got = strip(src);
        assert!(!got.contains(",]"), "数组尾逗号未去除: {got}");
        assert!(!got.contains(",}"), "对象尾逗号未去除: {got}");
        // 值之间的逗号必须保留
        assert!(got.contains("1, 2"));
    }
}
