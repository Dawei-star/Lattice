//! 流式 run 生命周期（地基 §4 `runtime/run_worker`，W4 自 `ai_runtime.rs` 迁入）。
//!
//! `AiRuntimeState` 持有活跃 run 集合、待恢复请求（密钥仅进程内存）与待确认写
//! 批次（W7c 确认下沉：写入正文同样只在进程内存，落盘走 sanitize）；
//! `ai_chat_stream` 认领 run 并驱动 chat 流；`ai_chat_cancel` 触发协作取消。
//! durable 队列（jobs 认领 / 事件持久化 / 恢复）仍在 lib.rs 的 run 命令层。

use super::chat::stream_provider;
use crate::ai::core::agent::PendingCall;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

/// W7c：挂起等确认的写批次。仅存进程内存（正文/凭据不入库），
/// 应用重启丢失后由前端恢复流程按「重新生成计划」路径处理。
#[derive(Clone)]
pub struct PendingWriteConfirmation {
    /// 挂起前的当前请求（含上下文/会话/模式），确认后续跑以它为底
    pub continuation_request: Value,
    /// 触发本轮的完整模型 toolCalls（确认续跑时原样回传给模型）
    pub calls: Value,
    /// 本轮已执行（读/Auto 写/拒绝）的 toolResults，先于待确认结果回传
    pub executed_results: Vec<Value>,
    /// 等待用户确认的写调用（含输入）
    pub pending: Vec<PendingCall>,
    /// 各写调用挂起时的预览 planHash（call_id → hash），执行闸门必需
    pub plan_hashes: Vec<(String, String)>,
    /// 待确认批次是否含删除（删除需二次确认）
    pub has_delete: bool,
}

#[derive(Clone, Default)]
pub struct AiRuntimeState {
    active: Arc<Mutex<HashSet<String>>>,
    pending_requests: Arc<Mutex<HashMap<String, Value>>>,
    pending_writes: Arc<Mutex<HashMap<String, PendingWriteConfirmation>>>,
    /// ai_run_confirm 已注册内核续跑请求并重新入队：ai_run_resume 据此跳过
    /// 前端请求注册与重复 resume，直接进入事件回放。
    kernel_continuations: Arc<Mutex<HashSet<String>>>,
}

impl AiRuntimeState {
    pub(crate) fn start(&self, run_id: &str) -> Result<(), String> {
        self.active
            .lock()
            .map_err(|error| error.to_string())?
            .insert(run_id.to_owned());
        Ok(())
    }

    pub(crate) fn finish(&self, run_id: &str) {
        if let Ok(mut runs) = self.active.lock() {
            runs.remove(run_id);
        }
    }

    pub(crate) fn clear_pending_request(&self, run_id: &str) {
        if let Ok(mut requests) = self.pending_requests.lock() {
            requests.remove(run_id);
        }
    }

    pub(crate) fn cancel(&self, run_id: &str) -> Result<bool, String> {
        Ok(self
            .active
            .lock()
            .map_err(|error| error.to_string())?
            .remove(run_id))
    }

    pub(crate) fn is_cancelled(&self, run_id: &str) -> bool {
        self.active
            .lock()
            .map(|runs| !runs.contains(run_id))
            .unwrap_or(true)
    }

    pub fn register_pending_request(&self, run_id: &str, request: Value) -> Result<(), String> {
        self.pending_requests
            .lock()
            .map_err(|error| error.to_string())?
            .insert(run_id.to_owned(), request);
        Ok(())
    }

    pub fn pending_request(&self, run_id: &str) -> Result<Option<Value>, String> {
        Ok(self
            .pending_requests
            .lock()
            .map_err(|error| error.to_string())?
            .get(run_id)
            .cloned())
    }

    /// W7c：保存挂起的写批次（同一 run 以最新一批为准）。
    pub fn store_pending_writes(&self, run_id: &str, pending: PendingWriteConfirmation) -> Result<(), String> {
        self.pending_writes
            .lock()
            .map_err(|error| error.to_string())?
            .insert(run_id.to_owned(), pending);
        Ok(())
    }

    /// W7c：取走挂起的写批次（一次性：确认/拒绝后不再复用）。
    pub fn take_pending_writes(&self, run_id: &str) -> Option<PendingWriteConfirmation> {
        self.pending_writes
            .lock()
            .ok()
            .and_then(|mut writes| writes.remove(run_id))
    }

    /// W7c：标记内核已注册续跑请求并重新入队（ai_run_confirm 调用）。
    pub fn mark_kernel_continuation(&self, run_id: &str) {
        if let Ok(mut set) = self.kernel_continuations.lock() {
            set.insert(run_id.to_owned());
        }
    }

    /// W7c：消费内核续跑标记；为 true 时 ai_run_resume 跳过前端请求注册与重复 resume。
    pub fn take_kernel_continuation(&self, run_id: &str) -> bool {
        self.kernel_continuations
            .lock()
            .map(|mut set| set.remove(run_id))
            .unwrap_or(false)
    }
}

#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    state: State<'_, AiRuntimeState>,
    mut request: Value,
) -> Result<Value, String> {
    let run_id = request
        .get("runId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "AI 请求缺少 runId".to_owned())?
        .to_owned();
    // E1：直连通道（非 durable 队列）同样注入专家策略——两条入口共用同一份
    // 解析逻辑，避免「面板直连时专家又不生效」的第二处断线。
    {
        let workspace_state = app.state::<crate::WorkspaceState>();
        if let Ok(workspace) = workspace_state.0.read() {
            crate::ai::core::expert::apply_request(&workspace, &mut request);
        }
    }
    state.start(&run_id)?;
    let result = stream_provider(app, state.inner().clone(), run_id.clone(), request, None).await;
    state.finish(&run_id);
    result
}

#[tauri::command]
pub fn ai_chat_cancel(state: State<'_, AiRuntimeState>, run_id: String) -> Result<bool, String> {
    state.cancel(&run_id)
}
