//! Prompt / 模板注册表（地基 §5.3，W5）。
//!
//! 所有发给模型的文本模板的唯一出处：内置 `templates/*.md`（include_str!，随版本发布）
//! + `<Vault>/.lattice/prompts/*.md` 覆盖（与 ModelCatalog 同一套覆盖机制）。
//! 模板 frontmatter 声明 `id / version / vars`；版本随 run 记录（W8 trace 消费）。
//!
//! 两条 fail-fast：内置模板启动时校验（frontmatter 合法 + 占位可渲染）；
//! 渲染时缺变量或残留未替换占位立即报错，绝不把 `{{var}}` 发给模型。

use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

const BUNDLED: &[(&str, &str)] = &[
    (
        "assistant.welcome",
        include_str!("templates/assistant.welcome.md"),
    ),
    ("small.intent", include_str!("templates/small.intent.md")),
    ("small.rerank", include_str!("templates/small.rerank.md")),
    ("write.polish", include_str!("templates/write.polish.md")),
];

#[derive(Debug, Clone)]
pub(crate) struct PromptTemplate {
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) vars: Vec<String>,
    pub(crate) content: String,
}

/// 一次渲染的结果：内容 + 版本（进 run 记录）+ 是否来自用户覆盖。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptInstance {
    pub(crate) content: String,
    pub(crate) version: String,
    pub(crate) overridden: bool,
}

/// 模板状态（ai_prompts_list 出口，ModelCenter「已自定义」标记消费）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptStatus {
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) overridden: bool,
}

#[derive(Debug, Clone, Default)]
pub struct PromptRegistry {
    templates: BTreeMap<String, PromptTemplate>,
    overridden: HashSet<String>,
}

fn parse_template(raw: &str, source: &str) -> Result<PromptTemplate, String> {
    let trimmed = raw.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---\n") else {
        return Err(format!("模板 {source} 缺少 frontmatter 起始行"));
    };
    let (frontmatter, content) = rest
        .split_once("\n---\n")
        .ok_or_else(|| format!("模板 {source} 缺少 frontmatter 结束行"))?;

    let mut id = String::new();
    let mut version = String::new();
    let mut vars = Vec::new();
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "id" => id = value.to_owned(),
            "version" => version = value.trim_matches('"').to_owned(),
            "vars" => {
                vars = value
                    .split(',')
                    .map(|item| item.trim().to_owned())
                    .filter(|item| !item.is_empty())
                    .collect();
            }
            _ => {}
        }
    }
    if id.is_empty() {
        return Err(format!("模板 {source} 缺少 id"));
    }
    if version.is_empty() {
        return Err(format!("模板 {source}（{id}）缺少 version"));
    }
    if vars.iter().any(|name| name.contains(|c: char| !c.is_ascii_alphanumeric() && c != '_')) {
        return Err(format!("模板 {source}（{id}）变量名只能包含字母数字与下划线"));
    }
        Ok(PromptTemplate {
            id,
            version,
            vars,
            content: content.trim().to_owned(),
        })
}

impl PromptRegistry {
    /// 内置目录：启动 fail-fast（frontmatter 合法 + 全部占位可渲染）。
    pub fn builtin() -> Result<Self, String> {
        let mut registry = Self::default();
        for (name, raw) in BUNDLED {
            let template = parse_template(raw, name)?;
            if registry.templates.contains_key(&template.id) {
                return Err(format!("模板 id 重复：{name}"));
            }
            registry.templates.insert(template.id.clone(), template);
        }
        registry.validate_placeholders()?;
        Ok(registry)
    }

    /// 启动校验：用占位值渲染每个模板，任何残留 `{{…}}` 立即失败。
    fn validate_placeholders(&self) -> Result<(), String> {
        for template in self.templates.values() {
            let placeholders: BTreeMap<String, String> = template
                .vars
                .iter()
                .map(|name| (name.clone(), "x".to_owned()))
                .collect();
            self.render(&template.id, &placeholders).map_err(|error| {
                format!("内置模板启动校验失败（{source}）：{error}", source = template.id)
            })?;
        }
        Ok(())
    }

    /// 用 `<Vault>/.lattice/prompts/*.md` 覆盖内置模板（按 frontmatter id 匹配）。
    /// 覆盖是用户文件：解析失败跳过并告警，绝不拖垮启动；未知 id 也接受（预留未来模板）。
    pub fn merged_with_override(&self, directory: &Path) -> Self {
        let mut registry = self.clone();
        let Ok(entries) = std::fs::read_dir(directory) else {
            return registry;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let source = path.file_name().and_then(|name| name.to_str()).unwrap_or("?");
            match parse_template(&raw, source) {
                Ok(template) => {
                    registry.overridden.insert(template.id.clone());
                    registry.templates.insert(template.id.clone(), template);
                }
                Err(error) => {
                    log::warn!("Prompt 覆盖文件不可用（{error}），已跳过");
                }
            }
        }
        registry
    }

    pub fn list(&self) -> Vec<PromptStatus> {
        self.templates
            .values()
            .map(|template| PromptStatus {
                id: template.id.clone(),
                version: template.version.clone(),
                overridden: self.overridden.contains(&template.id),
            })
            .collect()
    }

    /// 渲染：缺声明变量或残留未替换占位 → Err（fail-fast，不发半成品给模型）。
    pub fn render(&self, id: &str, vars: &BTreeMap<String, String>) -> Result<PromptInstance, String> {
        let template = self
            .templates
            .get(id)
            .ok_or_else(|| format!("未注册的 Prompt 模板：{id}"))?;
        for name in &template.vars {
            if !vars.contains_key(name) {
                return Err(format!("模板 {id} 缺少变量 {name} 的值"));
            }
        }
        let mut content = template.content.clone();
        for (name, value) in vars {
            content = content.replace(&format!("{{{{{name}}}}}"), value);
        }
        if let Some(rest) = content.split("{{").nth(1) {
            let token = rest.split("}}").next().unwrap_or(rest);
            if rest.contains("}}") && !token.trim().is_empty() {
                return Err(format!("模板 {id} 渲染后残留未替换占位：{{{token}}}"));
            }
        }
        Ok(PromptInstance {
            content,
            version: template.version.clone(),
            overridden: self.overridden.contains(id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::PromptRegistry;
    use std::collections::BTreeMap;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn builtin_templates_parse_and_render() {
        let registry = PromptRegistry::builtin().expect("内置模板必须可解析");
        assert!(registry.list().iter().any(|item| item.id == "assistant.welcome"));
        assert!(registry.list().iter().any(|item| item.id == "small.intent"));

        let intent = registry
            .render(
                "small.intent",
                &vars(&[
                    ("message", "帮我整理周报"),
                    ("mode", "quick"),
                    ("hasAttachments", "false"),
                ]),
            )
            .unwrap();
        assert!(intent.content.contains("帮我整理周报"));
        assert!(!intent.content.contains("{{"));
        assert_eq!(intent.version, "1.0.0");
        assert!(!intent.overridden);

        // 欢迎语无变量，直接渲染
        assert!(registry.render("assistant.welcome", &vars(&[])).unwrap().content.contains("Lattice 知识库助手"));
    }

    #[test]
    fn missing_var_and_leftover_placeholder_fail_fast() {
        let registry = PromptRegistry::builtin().unwrap();
        let error = registry.render("small.intent", &vars(&[("message", "x")])).unwrap_err();
        assert!(error.contains("缺少变量"));

        let error = registry.render("not-registered", &vars(&[])).unwrap_err();
        assert!(error.contains("未注册"));
    }

    #[test]
    fn override_replaces_template_and_marks_overridden() {
        let directory = tempfile::tempdir().unwrap();
        let prompts_dir = directory.path().join("prompts");
        std::fs::create_dir_all(&prompts_dir).unwrap();
        std::fs::write(
            prompts_dir.join("welcome-override.md"),
            "---\nid: assistant.welcome\nversion: 2.0.0\nvars:\n---\n自定义欢迎语 v2。\n",
        )
        .unwrap();
        // 损坏覆盖：跳过不拖垮
        std::fs::write(prompts_dir.join("broken.md"), "没有 frontmatter 的文件").unwrap();

        let registry = PromptRegistry::builtin()
            .unwrap()
            .merged_with_override(&prompts_dir);
        let welcome = registry.render("assistant.welcome", &vars(&[])).unwrap();
        assert_eq!(welcome.content, "自定义欢迎语 v2。");
        assert_eq!(welcome.version, "2.0.0");
        assert!(welcome.overridden);

        let status = registry.list();
        let overridden: Vec<_> = status.iter().filter(|item| item.overridden).collect();
        assert_eq!(overridden.len(), 1);
        assert_eq!(overridden[0].id, "assistant.welcome");
        // 其余模板不受影响
        assert!(registry.render("small.rerank", &vars(&[("query", "q"), ("candidates", "[]")])).is_ok());
    }

    #[test]
    fn bad_frontmatter_is_rejected() {
        let error = super::parse_template("no frontmatter", "x.md").unwrap_err();
        assert!(error.contains("frontmatter"));
        let error = super::parse_template("---\nversion: \"1\"\n---\n内容", "x.md").unwrap_err();
        assert!(error.contains("缺少 id"));
    }
}
