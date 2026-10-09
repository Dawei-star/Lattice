import { http } from './client.js';
import { workspaceHeaders } from './workspace-auth.js';

// 与 client.js 相同的同源约定；SSE 用原生 fetch（http 封装不支持流式读取）
const RAW_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? '/api';
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');

export const aiApi = {
  // 非流式对话：CLI / 降级入口。流式主入口见 streamChat
  chat: (input, options = {}) => http.post('/ai/chat', input, { timeout: 300_000, retries: 0, ...options }),
  // 连通性测试直连上游服务商（kind: 'chat' | 'embedding'），关闭重试避免重复消耗上游额度
  test: (input, options = {}) => http.post('/ai/test', input, { timeout: 30_000, retries: 0, ...options }),
  // MCP 预热：服务端后台建连 + listTools，立即返回 202（打开面板时调用，缩短首条消息 TTFT）。
  // role 随body下发：viewer 角色在服务端被拒绝拉起 MCP 进程
  warmupMcp: (mcpServers = [], options = {}) => http.post('/ai/mcp/warmup', { mcpServers, role: options.role }, { timeout: 10_000, retries: 0, ...options }),
  preview: (input, options = {}) => http.post('/ai/operations/preview', input, options),
  // 写操作端点：关闭自动重试——超时后服务端可能已执行成功，重试会重复执行
  // 同一批文件动作（与 filesApi.execute / ai.write 同一口径）
  execute: (input, options = {}) => http.post('/ai/operations/execute', input, { retries: 0, ...options }),
  history: (options = {}) => http.get('/ai/history', options),

  // ── 服务端模型配置（Key 同步到服务端，供索引管道与 CLI 共用）─────────
  getSettings: (options = {}) => http.get('/ai/settings', options),
  putSettings: (input, options = {}) => http.put('/ai/settings', input, options),

  // ── 会话 ──────────────────────────────────────────────────────────
  // 列表仍从 data 读取数组；getFull 同时保留分页 meta 供会话历史面板使用
  listSessions: (options = {}) => http.getFull('/ai/sessions', options),
  createSession: (input = {}, options = {}) => http.post('/ai/sessions', input, options),
  sessionMessages: (sessionId, options = {}) => http.get(`/ai/sessions/${encodeURIComponent(sessionId)}/messages`, options),
  renameSession: (sessionId, title, options = {}) => http.patch(`/ai/sessions/${encodeURIComponent(sessionId)}`, { title }, options),
  deleteSession: (sessionId, options = {}) => http.delete(`/ai/sessions/${encodeURIComponent(sessionId)}`, options),

  // ── 语义索引与检索 ────────────────────────────────────────────────
  indexStatus: (options = {}) => http.get('/ai/index/status', options),
  reindex: (options = {}) => http.post('/ai/index/reindex', {}, options),
  relatedNotes: (noteId, limit = 6, options = {}) =>
    http.get(`/ai/related?noteId=${encodeURIComponent(noteId)}&limit=${limit}`, options),
  retrievalPreview: (query, options = {}) => http.post('/ai/retrieval/preview', { query }, { timeout: 60_000, retries: 0, ...options }),
  // 智能建议（双链 / 标签，只读）
  suggestions: (noteId, limit = 6, options = {}) =>
    http.get(`/ai/suggestions?noteId=${encodeURIComponent(noteId)}&limit=${limit}`, options),
  // 每日摘要：生成（或更新）今天的 Journal/每日摘要 笔记
  digest: (options = {}) => http.post('/ai/digest', {}, { timeout: 120_000, retries: 0, ...options }),

  /**
   * 写作助手（编辑器选区加工）。事件：delta / done / error。
   */
  writeStream: (input, options = {}) => postSse('/ai/write/stream', input, options),
  write: (input, options = {}) => http.post('/ai/write', input, { timeout: 300_000, retries: 0, ...options }),

  /**
   * 流式对话（SSE）。事件：meta / delta / done / error。
   * 返回最终 payload；期间通过 onEvent 逐段上报。
   */
  streamChat: (input, options = {}) => postSse('/ai/chat/stream', input, options),
};

/** 通用 SSE POST：解析 data 行事件；streamError 时抛出。
 *  空闲超时：连接建立后连续 idleTimeoutMs 没有任何数据则中断（上游 hang 住时
 *  UI 不再永远停在"生成中"）。外部 signal 取消仍原样透传。 */
async function postSse(path, input, { signal = null, onEvent = () => {}, headers = {}, idleTimeoutMs = 120_000 } = {}) {
  // 与 client.js 同款解析：同源相对路径在浏览器里可用，测试环境补上 origin
  const url = new URL(`${BASE_URL}${path}`, window.location.origin).toString();
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let idleTimer = null;
  let idleTimedOut = false;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  let response;
  try {
    armIdleTimer();
    response = await fetch(url, {
      method: 'POST',
      headers: workspaceHeaders({ 'Content-Type': 'application/json', ...headers }),
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (error) {
    if (idleTimedOut) throw new Error(`AI 已 ${Math.round(idleTimeoutMs / 1000)} 秒没有响应，连接已中断`);
    throw error;
  }
  if (!response.ok || !response.body) {
    let message = `AI 流式请求失败（${response.status}）`;
    try {
      const payload = await response.json();
      message = payload?.error?.message ?? message;
    } catch {
      // 保留默认消息
    }
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onExternalAbort);
    throw new Error(message);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let finalPayload = null;
  let streamError = null;

  const handleEvent = (event) => {
    if (event.type === 'done') finalPayload = event.payload ?? { text: event.text, meta: event.meta, cancelled: event.cancelled };
    else if (event.type === 'error') streamError = new Error(event.message ?? 'AI 调用失败');
    onEvent(event);
  };

  try {
    for await (const chunk of response.body) {
      armIdleTimer();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        try {
          handleEvent(JSON.parse(data));
        } catch {
          // 非 JSON 行（心跳等）忽略
        }
      }
    }
  } catch (error) {
    // 用户主动取消原样上抛；空闲超时给出明确原因
    if (idleTimedOut && !signal?.aborted) {
      throw new Error(`AI 已 ${Math.round(idleTimeoutMs / 1000)} 秒没有返回内容，连接已中断，请重试`);
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
  if (streamError) throw streamError;
  // 流结束却没收到 done 事件：网络抖动断流，不能让上层把 null 当成"已收到请求"
  if (!finalPayload) throw new Error('AI 连接中断，回复未完成，请重试');
  return finalPayload;
}
