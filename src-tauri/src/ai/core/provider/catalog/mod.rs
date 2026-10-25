//! 模型目录（地基方案 §5.1）：模型目录是**数据**不是代码。
//!
//! 内置 `models.json` 随版本发布；`<Vault>/.lattice/models.json` 同结构整份覆盖
//! （与 PromptRegistry 同一套覆盖机制）。顶级模型上架 / 改价 = 改一份 JSON，
//! 不改编排主干；覆盖文件损坏时回退内置目录，不阻塞任何流程。

use super::capabilities::ModelCapabilities;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub(crate) const BUILTIN_CATALOG: &str = include_str!("models.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogModel {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(flatten)]
    pub(crate) capabilities: ModelCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogService {
    pub(crate) key: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) endpoint: String,
    #[serde(default)]
    pub(crate) key_url: Option<String>,
    #[serde(default)]
    pub(crate) hint: Option<String>,
    /// 本机运行时（loopback、免密钥）——UI 徽标「本机 · 数据不出机器」
    #[serde(default)]
    pub(crate) local: bool,
    #[serde(default)]
    pub(crate) models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCatalog {
    pub(crate) version: String,
    pub(crate) services: Vec<CatalogService>,
}

impl ModelCatalog {
    /// 内置目录（随版本发布）。解析失败不该拖垮启动：降级为空目录并打日志，
    /// 由单测保证内置数据始终可解析。
    pub fn builtin() -> Self {
        Self::parse(BUILTIN_CATALOG).unwrap_or_else(|error| {
            log::error!("内置模型目录解析失败，降级为空目录：{error}");
            Self::empty()
        })
    }

    pub fn empty() -> Self {
        Self {
            version: String::new(),
            services: Vec::new(),
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let catalog: ModelCatalog =
            serde_json::from_str(raw).map_err(|error| format!("模型目录损坏：{error}"))?;
        if catalog.services.is_empty() {
            return Err("模型目录 services 不能为空".to_owned());
        }
        Ok(catalog)
    }

    /// 用覆盖文件替换内置目录（同结构整份替换，版本号以覆盖文件为准）。
    /// 文件不存在 / 解析失败 / 空服务 一律回退内置。
    pub fn merged_with_override(&self, override_path: &Path) -> Self {
        let Ok(raw) = std::fs::read_to_string(override_path) else {
            return self.clone();
        };
        match Self::parse(&raw) {
            Ok(catalog) => catalog,
            Err(error) => {
                log::warn!("模型目录覆盖文件不可用（{error}），回退内置目录");
                self.clone()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BUILTIN_CATALOG, ModelCatalog};

    #[test]
    fn builtin_catalog_parses_and_covers_top_open_models() {
        let catalog = ModelCatalog::parse(BUILTIN_CATALOG).expect("内置目录必须可解析");
        assert!(!catalog.version.is_empty());
        let deepseek = catalog
            .services
            .iter()
            .find(|service| service.key == "deepseek")
            .expect("内置目录应有 DeepSeek");
        assert!(deepseek.models.len() >= 3);
        let flash = deepseek
            .models
            .iter()
            .find(|model| model.id == "DeepSeek-V4.1-Flash")
            .expect("应含 DeepSeek-V4.1-Flash");
        assert!(flash.capabilities.native_tools);
        assert!(flash.capabilities.open_weights);
        assert!(flash.capabilities.prompt_cost_per_1k_usd.is_some());
        // 本机运行时标记：Ollama 免密钥
        let ollama = catalog.services.iter().find(|service| service.key == "ollama").unwrap();
        assert!(ollama.local);
        assert!(ollama.endpoint.starts_with("http://127.0.0.1:11434"));
    }

    #[test]
    fn override_replaces_catalog_and_bad_override_falls_back() {
        let directory = tempfile::tempdir().unwrap();
        let builtin = ModelCatalog::builtin();

        // 无覆盖文件 → 原样返回
        assert_eq!(
            builtin
                .merged_with_override(&directory.path().join("models.json"))
                .version,
            builtin.version
        );

        // 合法覆盖 → 整份替换
        let override_path = directory.path().join("models.json");
        std::fs::write(
            &override_path,
            r#"{"version":"test-override","services":[{"key":"only","label":"唯一服务","endpoint":"https://example.com/v1/chat/completions","models":[]}]}"#,
        )
        .unwrap();
        let merged = builtin.merged_with_override(&override_path);
        assert_eq!(merged.version, "test-override");
        assert_eq!(merged.services.len(), 1);
        assert_eq!(merged.services[0].key, "only");

        // 覆盖文件损坏 / 空服务 → 回退内置
        std::fs::write(&override_path, "not-json").unwrap();
        assert_eq!(
            builtin.merged_with_override(&override_path).version,
            builtin.version
        );
        std::fs::write(
            &override_path,
            r#"{"version":"empty","services":[]}"#,
        )
        .unwrap();
        assert_eq!(
            builtin.merged_with_override(&override_path).version,
            builtin.version
        );
    }
}
