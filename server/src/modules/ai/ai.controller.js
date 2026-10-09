import * as service from './ai.service.js';
import * as sessions from './ai.sessions.js';
import * as indexer from './ai.indexer.js';
import * as embeddings from './ai.embeddings.js';
import * as retrieval from './ai.retrieval.js';
import { suggestForNote } from './ai.suggestions.js';
import { generateDigest as createDigest } from './ai.digest.js';
// 文件操作的处理函数直接来自 ai.operations（service 层只是转发）；
// execute 语义与 SQL 无关，为免静态扫描误判，导入时起名为 runFileActions
import { preview as previewFileActions, execute as runFileActions, history as listAuditLog } from './ai.operations.js';
import { loadServerSettings, maskServerSettings, mergeSettingsPatch, saveServerSettings } from './ai.settings.js';
import { warmupMcpConnections } from './ai.mcp.js';
import { applyAiPrincipal } from './ai.auth.js';
import { NotFoundError } from '../../lib/errors.js';
import { listJobs } from '../../lib/jobs.js';

function principal(req, body) {
  return applyAiPrincipal(req, body);
}

export async function chat(req, res) {
  // 客户端提前断开（如点了「停止生成」）时中止对外部模型的上游调用，避免白白消耗 Token
  const upstreamAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort();
  });
  res.json({ data: await service.chat(principal(req, req.valid.body), { signal: upstreamAbort.signal }) });
}

/**
 * MCP 预热（前端打开 AI 面板时调用）。不等待连接建立：spawn 进程 + listTools
 * 可能耗时数秒到 20 秒，调用方拿到 202 即可，预热结果不回传（失败时正式对话
 * 仍会按原路径自行连接，行为与未预热完全一致）。
 */
export function warmupMcp(req, res) {
  // viewer 只读边界约束进程拉起：stdio MCP 等效于执行任意命令（与 chat 侧同款校验）
  const { role } = applyAiPrincipal(req, req.valid.body ?? {});
  if (role === 'viewer' && (req.valid.body.mcpServers ?? []).length) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'viewer 角色不允许调用 MCP 工具' } });
    return;
  }
  void warmupMcpConnections(req.valid.body.mcpServers ?? []);
  res.status(202).json({ data: { started: true } });
}

/**
 * 流式对话（SSE）。事件序列：
 *   meta  → 上游已确定
 *   delta → 增量文本（可出现多次）
 *   done  → 最终结构化结果（引用/建议/动作）
 *   error → 上游失败（连接随后关闭）
 */
export async function chatStream(req, res) {
  const upstreamAbort = new AbortController();
  let finished = false;
  let errorSent = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      res.end();
    }
  };
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort();
  });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  const send = (event) => {
    if (finished) return;
    if (event?.type === 'error') errorSent = true;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // 连接已断，交给 close 分支中止上游
    }
  };

  try {
    await service.chatStream(principal(req, req.valid.body), {
      signal: upstreamAbort.signal,
      onEvent: send,
    });
  } catch (error) {
    // service 层失败时已发过 error 事件；这里只兜底补发一次，避免客户端收到重复错误
    if (!errorSent) send({ type: 'error', message: error?.message ?? 'AI 调用失败' });
  } finally {
    finish();
  }
}

export async function test(req, res) {
  const { kind = 'chat', provider } = req.valid.body;
  const result = kind === 'embedding'
    ? await service.testEmbedding({ provider })
    : await service.testProvider({ provider });
  res.json({ data: result });
}

// ── 写作助手 ─────────────────────────────────────────────────────────

export async function write(req, res) {
  const upstreamAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort();
  });
  const body = principal(req, req.valid.body);
  try {
    const result = await service.writeAssist({ ...body, signal: upstreamAbort.signal });
    res.json({ data: result });
  } catch (error) {
    if (error?.code === 'MODEL_NOT_CONFIGURED') {
      res.status(409).json({ error: { code: 'MODEL_NOT_CONFIGURED', message: error.message } });
      return;
    }
    throw error;
  }
}

/** 写作助手流式端点（SSE）：delta 逐段文本，done/error 收尾 */
export async function writeStream(req, res) {
  const upstreamAbort = new AbortController();
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      res.end();
    }
  };
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort();
  });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 1000\n\n');

  const send = (event) => {
    if (finished) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // 连接已断，交给 close 分支中止上游
    }
  };

  const body = principal(req, req.valid.body);
  try {
    const result = await service.writeAssist({ ...body, signal: upstreamAbort.signal, onDelta: (text) => send({ type: 'delta', text }) });
    send({ type: 'done', text: result.text, meta: result.meta });
  } catch (error) {
    if (error?.code === 'MODEL_NOT_CONFIGURED') {
      send({ type: 'error', code: 'MODEL_NOT_CONFIGURED', message: error.message });
    } else if (error?.name === 'AbortError' || /已取消/.test(error?.message ?? '')) {
      send({ type: 'done', text: '', cancelled: true });
    } else {
      send({ type: 'error', message: error?.message ?? '写作助手调用失败' });
    }
  } finally {
    finish();
  }
}

// ── 服务端模型配置 ───────────────────────────────────────────────────

export function getSettings(_req, res) {
  res.json({ data: maskServerSettings(loadServerSettings()) });
}

export function putSettings(req, res) {
  // apiKey 缺省或为掩码值时保留现值，明文 Key 不必在客户端回环
  const data = saveServerSettings(mergeSettingsPatch(req.valid.body, loadServerSettings()));
  // 配置变化的下一步就是补齐积压索引：入队所有笔记（无 embedding 配置时是安全的空操作）
  try {
    indexer.reindexAll();
  } catch {
    // 索引入队失败不影响配置保存
  }
  res.json({ data: maskServerSettings(data) });
}

// ── 会话 ─────────────────────────────────────────────────────────────

// 会话内容会在每轮对话后变化。若让 Express 对 JSON 响应做条件缓存，
// 浏览器收到 304 时没有消息体，前端就会把当前对话误还原成空会话。
function disableSessionCaching(req, res) {
  // Express decides whether to emit 304 from request headers before writing
  // the JSON body. Mark the request stale too, because no-store on the
  // response alone does not override If-None-Match: *.
  req.headers['cache-control'] = 'no-cache';
  res.setHeader('Cache-Control', 'no-store');
}

export function listSessions(req, res) {
  disableSessionCaching(req, res);
  sessions.deleteEmptySessions();
  const page = sessions.listSessionPage(req.valid.query);
  res.json({
    data: page.items,
    meta: {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore,
    },
  });
}

export function createSession(req, res) {
  const body = req.valid?.body ?? {};
  res.json({ data: sessions.createSession(body) });
}

export function sessionMessages(req, res) {
  disableSessionCaching(req, res);
  const session = sessions.getSession(req.valid.params.id);
  if (!session) throw new NotFoundError('会话不存在');
  res.json({ data: { session, messages: sessions.listMessages(session.id) } });
}

export function renameSession(req, res) {
  const session = sessions.getSession(req.valid.params.id);
  if (!session) throw new NotFoundError('会话不存在');
  sessions.renameSession(session.id, req.valid.body.title);
  res.json({ data: sessions.getSession(session.id) });
}

export function deleteSession(req, res) {
  if (!sessions.deleteSession(req.valid.params.id)) throw new NotFoundError('会话不存在');
  res.json({ data: { deleted: true } });
}

// ── 语义索引与检索 ───────────────────────────────────────────────────

export function indexStatus(_req, res) {
  const latestReindex = listJobs({ type: 'ai-reindex', limit: 1 })[0] ?? null;
  res.json({ data: { ...embeddings.indexStatus(), reindexJob: latestReindex } });
}

export function reindexAll(_req, res) {
  const job = indexer.reindexAll();
  res.status(202).json({
    data: {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      total: job.total,
    },
  });
}

export async function relatedNotes(req, res) {
  const { noteId, limit } = req.valid.query;
  try {
    res.json({ data: await retrieval.relatedNotes(noteId, { limit }) });
  } catch (error) {
    if (error?.code === 'EMBEDDING_NOT_CONFIGURED') {
      res.status(409).json({ error: { code: 'EMBEDDING_NOT_CONFIGURED', message: error.message } });
      return;
    }
    throw error;
  }
}

export async function retrievalPreview(req, res) {
  // 输入已在路由层经 zod 校验为纯文本；这里仅透传给检索调试器
  const term = String(req.valid.body.query ?? '').trim();
  try {
    res.json({ data: await retrieval.debugRetrieval(term) });
  } catch (error) {
    if (error?.code === 'EMBEDDING_NOT_CONFIGURED') {
      res.status(409).json({ error: { code: 'EMBEDDING_NOT_CONFIGURED', message: error.message } });
      return;
    }
    throw error;
  }
}

export async function suggestions(req, res) {
  const { noteId, limit } = req.valid.query;
  res.json({ data: await suggestForNote(noteId, { limit }) });
}

export async function generateDigest(_req, res) {
  res.json({ data: await createDigest() });
}

// ── 文件操作（保留自 v0.1）───────────────────────────────────────────

export function preview(req, res) {
  const body = principal(req, req.valid.body);
  res.json({ data: previewFileActions(body.actions, body) });
}

export async function execute(req, res) {
  const body = principal(req, req.valid.body);
  res.json({ data: await runFileActions(body.actions, body) });
}

export function history(req, res) {
  res.json({ data: listAuditLog(req.valid.query.limit) });
}
