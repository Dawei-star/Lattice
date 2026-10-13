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

/// frontmatter 解析结果：保留字段 + 自定义属性（对齐 Express serializeMarkdownDocument）。
#[derive(Debug, Default, Clone)]
pub struct Frontmatter {
    pub id: Option<String>,
    pub title: Option<String>,
    pub pinned: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// 其余自定义属性（保留字段之外），键名需符合 Express 的写入约束。
    pub properties: serde_json::Map<String, serde_json::Value>,
}

/// UUID v1-v5 形状校验（对齐 Express NOTE_ID_PATTERN）。
pub fn is_valid_note_id(note_id: &str) -> bool {
    let parts: Vec<&str> = note_id.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(len, part)| part.len() == *len && part.chars().all(|c| c.is_ascii_hexdigit()))
        && parts[2].starts_with(['1', '2', '3', '4', '5'])
        && parts[3].starts_with(['8', '9', 'a', 'b'])
}

/// 属性值解析（对齐 parsePropertyValue）：布尔字面量、数字、JSON 数组、其余为字符串。
fn parse_property_value(value: &str) -> serde_json::Value {
    let source = value.trim();
    match source {
        "true" => serde_json::Value::Bool(true),
        "false" => serde_json::Value::Bool(false),
        "" => serde_json::Value::Null,
        _ => {
            if let Ok(number) = source.parse::<f64>() {
                return serde_json::json!(number);
            }
            if source.starts_with('[')
                && let Ok(array) = serde_json::from_str::<serde_json::Value>(source)
            {
                return array;
            }
            serde_json::Value::String(source.to_owned())
        }
    }
}

/// 解析 frontmatter（对齐 serializeMarkdownDocument 的字段布局）。
/// 保留字段 id/title/pinned/created_at/updated_at；其余键进 properties。
pub fn parse_frontmatter(raw: &str) -> Option<Frontmatter> {
    let mut lines = raw.lines();
    let first = lines.next()?.trim_end_matches('\r').to_owned();
    if first != "---" {
        return None;
    }
    let mut frontmatter = Frontmatter::default();
    for line in lines.take(200) {
        let line = line.trim_end_matches('\r');
        if line == "---" {
            return Some(frontmatter);
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim();
        let value = value.trim();
        match key {
            "id" => {
                let trimmed = value.trim_matches(['"', '\'']);
                if is_valid_note_id(trimmed) {
                    frontmatter.id = Some(trimmed.to_owned());
                }
            }
            "title" if !value.is_empty() => frontmatter.title = Some(value.to_owned()),
            "pinned" => frontmatter.pinned = value == "true",
            "created_at" if !value.is_empty() => frontmatter.created_at = Some(value.to_owned()),
            "updated_at" if !value.is_empty() => frontmatter.updated_at = Some(value.to_owned()),
            _ => {
                if key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                    && key.len() <= 81
                    && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                {
                    frontmatter.properties.insert(key.to_owned(), parse_property_value(value));
                }
            }
        }
    }
    None
}

/// 去掉 frontmatter，返回正文（Express 的 note.content 口径不含 frontmatter）。
pub fn strip_frontmatter(raw: &str) -> &str {
    let mut lines = raw.lines();
    if !lines.next().is_some_and(|first| first.trim_end_matches('\r') == "---") {
        return raw;
    }
    let mut offset = 0usize;
    for line in raw.lines() {
        let line_end = offset + line.len();
        if line.trim_end_matches('\r') == "---" {
            // 正文从闭合栏之后开始（跳过换行符）
            return &raw[(line_end + 1).min(raw.len())..];
        }
        offset = line_end + 1;
    }
    raw
}

/// 字数统计（对齐 computeWordCount）：CJK 字符数 + 拉丁词数。
pub fn compute_word_count(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut latin_words = 0u64;
    let mut in_latin_word = false;
    for ch in text.chars() {
        let is_cjk = matches!(ch as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF);
        if is_cjk {
            cjk += 1;
        }
        let is_latin = ch.is_ascii_alphanumeric() || ch == '\'' || ch == '’' || ch == '-';
        if ch.is_ascii_alphanumeric() {
            if !in_latin_word {
                latin_words += 1;
                in_latin_word = true;
            }
        } else if !is_latin {
            in_latin_word = false;
        }
    }
    cjk + latin_words
}

/// 标题上限（对齐 Express MAX_TITLE_LENGTH）。
pub const MAX_TITLE_LENGTH: usize = 200;

/// 文件名清洗（对齐 sanitizeFilePart）：非法字符→_、尾部 ./空格 去除、
/// Windows 保留设备名前缀 _、空值回退「未命名笔记」。
pub fn sanitize_file_part(value: &str, fallback: &str) -> String {
    let cleaned: String = {
        let base = if value.is_empty() { fallback } else { value };
        base.chars()
            .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\u{1f}' | '\u{7f}') { '_' } else { c })
            .collect::<String>()
            .trim_end_matches(['.', ' '])
            .trim()
            .to_owned()
    };
    let cleaned = if cleaned.is_empty() { fallback.to_owned() } else { cleaned };
    let stem = cleaned.split('.').next().unwrap_or("").to_owned();
    let reserved: &[&str] = &[
        "CON", "PRN", "AUX", "NUL",
        "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.contains(&stem.to_uppercase().as_str()) {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

/// frontmatter 值序列化（对齐 frontmatterValue）：数组 JSON、字符串去控制字符。
fn frontmatter_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(frontmatter_value).collect();
            format!("[{}]", inner.join(","))
        }
        other => other
            .as_str()
            .unwrap_or(&other.to_string())
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect::<String>()
            .trim()
            .to_owned(),
    }
}

/// 属性序列化（对齐 serializeProperties）：保留字段之外的合法键按名排序。
const RESERVED_FIELDS: &[&str] = &["id", "title", "pinned", "created_at", "updated_at", "tags"];

/// Markdown 文档序列化（对齐 serializeMarkdownDocument）：
/// frontmatter（id/title/pinned/created_at/updated_at + 排序后的自定义属性）+ 正文。
pub struct MarkdownDocument<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub content: &'a str,
    pub is_pinned: bool,
    pub created_at: &'a str,
    pub updated_at: &'a str,
    pub properties: &'a serde_json::Map<String, serde_json::Value>,
}

pub fn serialize_markdown_document(note: &MarkdownDocument<'_>) -> String {
    let mut frontmatter = vec![
        "---".to_owned(),
        format!("id: {}", frontmatter_value(&serde_json::Value::String(note.id.to_owned()))),
        format!("title: {}", frontmatter_value(&serde_json::Value::String(note.title.to_owned()))),
        format!("pinned: {}", if note.is_pinned { "true" } else { "false" }),
        format!("created_at: {}", frontmatter_value(&serde_json::Value::String(note.created_at.to_owned()))),
        format!("updated_at: {}", frontmatter_value(&serde_json::Value::String(note.updated_at.to_owned()))),
    ];
    let mut keys: Vec<&String> = note
        .properties
        .keys()
        .filter(|key| {
            key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && key.len() <= 81
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                && !RESERVED_FIELDS.contains(&key.as_str())
        })
        .collect();
    keys.sort();
    for key in keys {
        frontmatter.push(format!("{}: {}", key, frontmatter_value(&note.properties[key])));
    }
    frontmatter.push("---".to_owned());
    frontmatter.push(String::new());
    format!("{}\n{}", frontmatter.join("\n"), note.content)
}

/// 标题归一化（对齐 normalizeTitle）：去控制字符、trim、空回退推断、截断 200。
pub fn normalize_title(raw_title: &str, fallback_content: &str) -> String {
    let cleaned: String = raw_title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_owned();
    let title = if cleaned.is_empty() {
        crate::vault::title_from_markdown(fallback_content, "")
    } else {
        cleaned
    };
    title.chars().take(MAX_TITLE_LENGTH).collect()
}

#[cfg(test)]
mod tests {
    use super::{compute_word_count, extract_frontmatter_tags, extract_note_tags, extract_tags, parse_frontmatter};

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

    #[test]
    fn frontmatter_parses_identity_and_custom_properties() {
        let raw = "---\nid: 019501a2-3b4c-4c5d-89ab-cdef01234567\ntitle: 测试\npinned: true\ncreated_at: 2026-10-13T00:00:00.000Z\nupdated_at: 2026-10-13T01:00:00.000Z\ntype: inbox\nstatus: pending\nrating: 3\nflags: [\"a\", \"b\"]\n---\n正文";
        let meta = parse_frontmatter(raw).unwrap();
        assert_eq!(meta.id.as_deref(), Some("019501a2-3b4c-4c5d-89ab-cdef01234567"));
        assert_eq!(meta.title.as_deref(), Some("测试"));
        assert!(meta.pinned);
        assert!(meta.created_at.is_some());
        assert_eq!(meta.properties["type"], "inbox");
        assert_eq!(meta.properties["status"], "pending");
        assert_eq!(meta.properties["rating"], 3.0);
        assert_eq!(meta.properties["flags"][0], "a");
        assert!(meta.properties.get("id").is_none(), "保留字段不进 properties");
    }

    #[test]
    fn frontmatter_rejects_non_markdown_and_bad_ids() {
        assert!(parse_frontmatter("普通文本").is_none());
        assert!(parse_frontmatter("---\nid: not-a-uuid\n---").unwrap().id.is_none());
        assert!(parse_frontmatter("---\ntitle: t\n").is_none(), "未闭合 frontmatter");
    }

    #[test]
    fn word_count_follows_express_semantics() {
        assert_eq!(compute_word_count("深度学习笔记"), 6, "CJK 按字符计");
        assert_eq!(compute_word_count("hello world"), 2, "拉丁按词计");
        assert_eq!(compute_word_count("混合 text 文本 42"), 6, "4 CJK + 2 拉丁词");
        assert_eq!(compute_word_count(""), 0);
    }
}
