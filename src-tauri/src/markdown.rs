//! Markdown 语义解析（纯函数），对齐 Express `server/src/lib/markdown.js`。
//!
//! 标签语法：`#标签`、`#标签/子标签`（正文内联 + frontmatter tags 属性）。
//! Rust regex 不支持 lookbehind，前置边界改为手动校验。

/// 围栏代码块与行内代码：解析前先剔除，避免把代码里的 # 误判为标签。
fn strip_code(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let rest = &text[index..];
        if rest.starts_with("```") || rest.starts_with("~~~") {
            // 与 JS 非贪婪正则一致：从开栏向后找最近的同款栏
            let fence = &rest[..3];
            match rest[3..].find(fence) {
                Some(close) => index += 3 + close + 3,
                None => index = bytes.len(),
            }
            result.push(' ');
            continue;
        }
        if let Some(after_backtick) = rest.strip_prefix('`') {
            // 行内代码：到下一个反引号或行尾
            if let Some(close) = after_backtick.find('`') {
                index += 1 + close + 1;
                result.push(' ');
                continue;
            }
            result.push('`');
            index += 1;
            continue;
        }
        // 逐字符拷贝（UTF-8 安全：按字符边界推进）
        let ch = rest.chars().next().unwrap();
        result.push(ch);
        index += ch.len_utf8();
    }
    result
}

/// 「行首紧跟文字的 #」（#需求、##背景）是无空格 Markdown 标题，不是标签；
/// 但带 / 的嵌套标签（#工程/前端）保留。
fn is_heading_without_space(line: &str) -> bool {
    let trimmed = line.trim_start_matches([' ', '\t']);
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return false;
    }
    let after = &trimmed[hashes..];
    match after.chars().next() {
        None => false,
        Some(first) => {
            if first.is_whitespace() || first == '#' {
                return false;
            }
            if first == '/' {
                return false;
            }
            // 首个词（到空白为止）里带 / 则是嵌套标签而非标题
            let first_word = after.split_whitespace().next().unwrap_or("");
            !first_word.contains('/')
        }
    }
}

fn is_hex_color_like(name: &str) -> bool {
    let all_hex = !name.is_empty() && name.chars().all(|c| c.is_ascii_hexdigit());
    if !all_hex {
        return false;
    }
    let has_digit = name.chars().any(|c| c.is_ascii_digit());
    if has_digit {
        name.len() == 6 || name.len() == 8
    } else {
        matches!(name.len(), 3 | 6 | 8)
    }
}

fn is_tag_start(previous: Option<char>) -> bool {
    match previous {
        None => true,
        Some(c) => !(c.is_alphanumeric() || c == '_' || c == '#' || c == '/'),
    }
}

/// 正文内联标签：`#标签`、`#标签/子标签`。
/// 前置字符不能是字母/数字/下划线/#//（对齐 Express TAG 正则的否定断言）；
/// 名称含至少一个字母/汉字；排除无空格标题行；排除十六进制色值。
pub fn extract_tags(raw_content: &str) -> Vec<String> {
    let text = strip_code(raw_content);
    let mut tags = std::collections::BTreeSet::new();
    let mut previous: Option<char> = None;
    let mut line_start = true;
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '\n' {
            line_start = true;
            previous = Some(ch);
            index += 1;
            continue;
        }
        if ch == '#' {
            let entering = previous; // TAG 正则的否定断言针对 # 的前一个字符
            // 收集候选：# 后的 [\p{L}\p{N}_-/]{1,64}
            let mut name = String::new();
            let mut cursor = index + 1;
            while cursor < chars.len() && name.chars().count() < 64 {
                let candidate = chars[cursor];
                if candidate.is_alphanumeric() || candidate == '_' || candidate == '-' || candidate == '/' {
                    name.push(candidate);
                    cursor += 1;
                } else {
                    break;
                }
            }
            let heading_line = line_start && {
                // 判断当前行是否为无空格标题：从行首到这里连续 #
                let line_head: String = chars[..index]
                    .iter()
                    .rev()
                    .take_while(|c| **c == '#' || **c == ' ' || **c == '\t')
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                is_heading_without_space(&line_head)
            };
            if !name.is_empty() && is_tag_start(entering) && !heading_line {
                let cleaned = name.trim_end_matches(['/', '-', '_']).trim().to_owned();
                if !cleaned.is_empty()
                    && cleaned.chars().any(|c| c.is_alphabetic())
                    && !is_hex_color_like(&cleaned)
                {
                    tags.insert(cleaned);
                }
            }
            if cursor == index + 1 {
                // 只消费了 # 本身（候选为空）
                previous = Some('#');
                index += 1;
            } else {
                for consumed in &chars[index + 1..cursor] {
                    previous = Some(*consumed);
                    if *consumed == '\n' {
                        line_start = true;
                    }
                }
                index = cursor;
            }
            continue;
        }
        line_start = false;
        previous = Some(ch);
        index += 1;
    }
    tags.into_iter().collect()
}

/// frontmatter `tags:` 属性：YAML 块列表 / 逗号分隔（对齐 Express extractNoteTags）。
pub fn extract_frontmatter_tags(raw: &str) -> Vec<String> {
    let mut lines = raw.lines();
    let first = match lines.next() {
        Some(first) => first,
        None => return Vec::new(),
    };
    if first.trim_end_matches('\r') != "---" {
        return Vec::new();
    }
    let mut tags = Vec::new();
    let mut in_tags_block = false;
    for line in lines.take(200) {
        let line = line.trim_end_matches('\r');
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("tags:") {
            let value = value.trim();
            if value.is_empty() {
                in_tags_block = true;
            } else {
                // 行内数组 [a, b] 或逗号分隔
                for item in value.trim_start_matches('[').trim_end_matches(']').split([',', '，', '、']) {
                    push_tag(&mut tags, item);
                }
                in_tags_block = false;
            }
            continue;
        }
        if in_tags_block && (line.starts_with("  - ") || line.starts_with("- ")) {
            push_tag(&mut tags, line.trim_start_matches([' ', '-']));
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('-') {
            in_tags_block = false;
        }
    }
    tags
}

fn push_tag(tags: &mut Vec<String>, item: &str) {
    let name = item
        .trim()
        .trim_matches(['"', '\''])
        .trim_start_matches('#')
        .trim_end_matches(['/', '-', '_'])
        .trim()
        .to_owned();
    if !name.is_empty() {
        tags.push(name);
    }
}

/// 完整标签集合 = 正文内联 + frontmatter tags（去重）。
pub fn extract_note_tags(content: &str) -> Vec<String> {
    let mut merged = std::collections::BTreeSet::new();
    for tag in extract_tags(content) {
        merged.insert(tag);
    }
    for tag in extract_frontmatter_tags(content) {
        merged.insert(tag);
    }
    merged.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::{extract_frontmatter_tags, extract_note_tags, extract_tags};

    #[test]
    fn inline_tags_support_chinese_and_nested() {
        let tags = extract_tags("这是 #深度学习 和 #工程/前端 的笔记，#带下划线_x 也算。");
        assert_eq!(tags, vec!["工程/前端", "带下划线_x", "深度学习"]);
    }

    #[test]
    fn ignores_code_blocks_headings_and_colors() {
        assert!(extract_tags("```\n#codeblock\n```").is_empty());
        assert!(extract_tags("`#inline`").is_empty());
        assert!(extract_tags("##背景").is_empty(), "无空格标题不是标签");
        assert_eq!(extract_tags("## 背景"), Vec::<String>::new(), "标准标题不是标签");
        assert!(extract_tags("#ffffff").is_empty(), "六位色值不是标签");
        assert!(extract_tags("#fff").is_empty(), "三位色值不是标签");
        assert_eq!(extract_tags("#2024"), Vec::<String>::new(), "纯数字不是标签");
    }

    #[test]
    fn heading_style_tag_with_slash_is_kept() {
        assert_eq!(extract_tags("#工程/前端"), vec!["工程/前端"], "行首嵌套标签保留");
    }

    #[test]
    fn trailing_separators_are_trimmed() {
        assert_eq!(extract_tags("#标签/"), vec!["标签"]);
        assert_eq!(extract_tags("这里 #abcd-"), vec!["abcd"]);
        // #abc/#fff 是十六进制色值（纯字母 3/6/8 位），被排除
        assert_eq!(extract_tags("这里 #abc-"), Vec::<String>::new());
        // # 前是汉字/字母/数字时不算标签（对齐 Express TAG 正则的否定断言）
        assert_eq!(extract_tags("看这个#abc-"), Vec::<String>::new());
    }

    #[test]
    fn frontmatter_tags_support_block_list_and_inline() {
        let yaml = "---\ntitle: t\ntags:\n  - 读书\n  - 笔记/方法\n---\n正文";
        assert_eq!(extract_frontmatter_tags(yaml), vec!["读书", "笔记/方法"]);
        let inline = "---\ntags: [a, b、c]\n---\n正文";
        assert_eq!(extract_frontmatter_tags(inline), vec!["a", "b", "c"]);
        let comma = "---\ntags: x，y\n---\n正文";
        assert_eq!(extract_frontmatter_tags(comma), vec!["x", "y"]);
    }

    #[test]
    fn note_tags_merge_body_and_frontmatter_deduped() {
        let raw = "---\ntags: [读书]\n---\n#读书笔记 #读书";
        assert_eq!(extract_note_tags(raw), vec!["读书", "读书笔记"]);
    }
}
