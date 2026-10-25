//! 动态发现（地基方案 §5.1）：OpenAI 兼容 `GET /v1/models` + Ollama `GET /api/tags`
//! → 归一化 `ModelDescriptor[]`；附本机 loopback 端口探测。
//!
//! 上游响应形态各异（字段名 / 包装 / 数组 vs data 数组），归一化层吸收差异；
//! 任何解析失败都返回空结果或错误文案，**永不阻塞手填配置**（UI 回退内置目录）。

use super::protocol::{apply_auth, provider_http_error};
use serde::Serialize;
use serde_json::Value;

/// 从上游发现的一个模型条目（归一化后）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDescriptor {
    pub(crate) id: String,
    pub(crate) label: Option<String>,
    pub(crate) owned_by: Option<String>,
    pub(crate) context_window_tokens: Option<u64>,
}

/// 本机运行时探测结果（loopback，免密钥）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalRuntime {
    /// ollama | lmstudio | llamacpp | vllm
    pub(crate) kind: String,
    pub(crate) endpoint: String,
    pub(crate) models: Vec<ModelDescriptor>,
}

fn bounded(value: &str, limit: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(limit).collect())
}

/// 归一化 OpenAI 兼容 `/v1/models` 载荷。
/// 兼容三种形态：`{data:[…]}`（标准）、裸数组、`{models:[…]}`（少数网关）。
pub(crate) fn normalize_models_payload(payload: &Value) -> Vec<ModelDescriptor> {
    let items = payload
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| payload.as_array())
        .or_else(|| payload.get("models").and_then(Value::as_array));
    let Some(items) = items else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let id = bounded(item.get("id")?.as_str()?, 120)?;
            let context_window_tokens = ["context_length", "context_window", "max_model_len"]
                .into_iter()
                .find_map(|key| item.get(key).and_then(Value::as_u64));
            Some(ModelDescriptor {
                id,
                label: item
                    .get("display_name")
                    .or_else(|| item.get("displayName"))
                    .and_then(Value::as_str)
                    .and_then(|value| bounded(value, 120)),
                owned_by: item
                    .get("owned_by")
                    .or_else(|| item.get("ownedBy"))
                    .and_then(Value::as_str)
                    .and_then(|value| bounded(value, 80)),
                context_window_tokens,
            })
        })
        .take(200)
        .collect()
}

/// 归一化 Ollama `GET /api/tags` 载荷（多给参数量 / 量化 / 家族元数据）。
pub(crate) fn normalize_ollama_tags(payload: &Value) -> Vec<ModelDescriptor> {
    let Some(items) = payload.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let name = bounded(item.get("name")?.as_str()?, 120)?;
            let details = item.get("details");
            let parameter_size = details
                .and_then(|value| value.get("parameter_size"))
                .and_then(Value::as_str)
                .and_then(|value| bounded(value, 20));
            let label = parameter_size.map(|size| format!("{name} · {size}"));
            Some(ModelDescriptor {
                id: name,
                label,
                owned_by: details
                    .and_then(|value| value.get("family"))
                    .and_then(Value::as_str)
                    .and_then(|value| bounded(value, 40)),
                context_window_tokens: None,
            })
        })
        .take(200)
        .collect()
}

/// 由聊天 / embedding 地址推导模型列表地址：
/// `…/v1/chat/completions` → `…/v1/models`；`…/v1` → `…/v1/models`。
pub(crate) fn models_url_from(endpoint: &str) -> Result<String, String> {
    let value = endpoint.trim();
    if value.is_empty() {
        return Err("模型地址为空".to_owned());
    }
    if !value.starts_with("http://") && !value.starts_with("https://") {
        return Err("模型地址必须使用 HTTP 或 HTTPS".to_owned());
    }
    let base = value
        .strip_suffix("/chat/completions")
        .or_else(|| value.strip_suffix("/embeddings"))
        .unwrap_or(value)
        .trim_end_matches('/');
    Ok(format!("{base}/models"))
}

/// 拉取远端模型清单（OpenAI 兼容端点几乎都支持）。
pub(crate) async fn discover_models(
    endpoint: &str,
    api_key: &str,
    auth_header: &str,
) -> Result<Vec<ModelDescriptor>, String> {
    let url = models_url_from(endpoint)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|_| "模型发现客户端初始化失败".to_owned())?;
    let builder = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json");
    let builder = apply_auth(builder, api_key, auth_header, "模型发现")?;
    let response = builder
        .send()
        .await
        .map_err(|_| "无法连接模型服务".to_owned())?;
    if !response.status().is_success() {
        return Err(provider_http_error(response, "模型发现失败").await);
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "模型发现返回了无效 JSON".to_owned())?;
    Ok(normalize_models_payload(&payload))
}

/// 探测单个本机运行时：先试 `/api/tags`（Ollama 专属、元数据更丰富），再试 `/v1/models`。
async fn probe_runtime(port: u16, kind: &'static str) -> Option<LocalRuntime> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let root = format!("http://127.0.0.1:{port}");

    if kind == "ollama" {
        if let Ok(response) = client.get(format!("{root}/api/tags")).send().await {
            if response.status().is_success() {
                if let Ok(payload) = response.json::<Value>().await {
                    let models = normalize_ollama_tags(&payload);
                    if !models.is_empty() {
                        return Some(LocalRuntime {
                            kind: kind.to_owned(),
                            endpoint: format!("{root}/v1/chat/completions"),
                            models,
                        });
                    }
                }
            }
        }
    }

    let response = client
        .get(format!("{root}/v1/models"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload = response.json::<Value>().await.ok()?;
    let models = normalize_models_payload(&payload);
    if models.is_empty() {
        return None;
    }
    Some(LocalRuntime {
        kind: kind.to_owned(),
        endpoint: format!("{root}/v1/chat/completions"),
        models,
    })
}

/// 扫描常见本机推理端口（仅 loopback，无密钥、无外部网络）。
pub(crate) async fn detect_local_runtimes() -> Vec<LocalRuntime> {
    const PROBES: &[(u16, &str)] = &[(11434, "ollama"), (1234, "lmstudio"), (8080, "llamacpp"), (8000, "vllm")];
    let handles: Vec<_> = PROBES
        .iter()
        .map(|(port, kind)| {
            let kind: &'static str = kind;
            tauri::async_runtime::spawn(probe_runtime(*port, kind))
        })
        .collect();
    let mut runtimes = Vec::new();
    for handle in handles {
        if let Ok(Some(runtime)) = handle.await {
            runtimes.push(runtime);
        }
    }
    runtimes
}

#[cfg(test)]
mod tests {
    use super::{ModelDescriptor, models_url_from, normalize_models_payload, normalize_ollama_tags};
    use serde_json::json;

    fn ids(models: &[ModelDescriptor]) -> Vec<String> {
        models.iter().map(|model| model.id.clone()).collect()
    }

    #[test]
    fn openai_models_payload_shapes_are_normalized() {
        // 标准形态：{object:"list", data:[…]}
        let standard = normalize_models_payload(&json!({
            "object": "list",
            "data": [
                { "id": "deepseek-chat", "owned_by": "deepseek", "context_length": 128000 },
                { "id": "  glm-5.3  ", "owned_by": "zhipu" }
            ]
        }));
        assert_eq!(ids(&standard), ["deepseek-chat", "glm-5.3"]);
        assert_eq!(standard[0].context_window_tokens, Some(128000));
        assert_eq!(standard[0].owned_by.as_deref(), Some("deepseek"));

        // 裸数组形态
        let bare = normalize_models_payload(&json!([{ "id": "kimi-k3" }]));
        assert_eq!(ids(&bare), ["kimi-k3"]);

        // models 包装形态 + 无效条目被跳过
        let wrapped = normalize_models_payload(&json!({
            "models": [{ "id": "qwen3:14b" }, { "no_id": true }, { "id": "" }]
        }));
        assert_eq!(ids(&wrapped), ["qwen3:14b"]);

        // 完全不认识的形状 → 空列表（不 panic、不阻塞）
        assert!(normalize_models_payload(&json!({"error": "boom"})).is_empty());
    }

    #[test]
    fn ollama_tags_payload_is_normalized_with_parameter_size() {
        let models = normalize_ollama_tags(&json!({
            "models": [
                {
                    "name": "qwen3:14b",
                    "details": { "parameter_size": "14.8B", "quantization_level": "Q4_K_M", "family": "qwen3" }
                },
                { "name": "bge-m3" }
            ]
        }));
        assert_eq!(ids(&models), ["qwen3:14b", "bge-m3"]);
        assert_eq!(models[0].label.as_deref(), Some("qwen3:14b · 14.8B"));
        assert_eq!(models[0].owned_by.as_deref(), Some("qwen3"));
        assert!(normalize_ollama_tags(&json!({})).is_empty());
    }

    #[test]
    fn models_url_is_derived_from_chat_and_embedding_endpoints() {
        assert_eq!(
            models_url_from("https://api.siliconflow.cn/v1/chat/completions").unwrap(),
            "https://api.siliconflow.cn/v1/models"
        );
        assert_eq!(
            models_url_from("http://127.0.0.1:11434/v1/embeddings").unwrap(),
            "http://127.0.0.1:11434/v1/models"
        );
        assert_eq!(
            models_url_from("https://api.example.com/v1/").unwrap(),
            "https://api.example.com/v1/models"
        );
        assert!(models_url_from("ftp://example.com").is_err());
    }
}
