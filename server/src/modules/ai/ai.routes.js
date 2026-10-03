import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticateAi } from './ai.auth.js';
import * as controller from './ai.controller.js';

const role = z.enum(['viewer', 'editor', 'admin']).default('editor');
const provider = z.object({
  endpoint: z.string().url().max(500),
  apiKey: z.string().min(1).max(500),
  model: z.string().trim().max(120).optional(),
  authHeader: z.enum(['bearer', 'x-api-key']).default('bearer'),
}).nullable().optional();
const context = z.object({
  activeFile: z.string().max(2048).nullable().optional(),
  activeFileContent: z.string().max(20_000).nullable().optional(),
  project: z.object({
    name: z.string().max(200),
    path: z.string().max(2048),
    folderId: z.string().uuid().nullable().optional(),
    fileCount: z.number().int().min(0).max(100000).optional(),
  }).nullable().optional(),
  inbox: z.object({
    total: z.number().int().min(0).max(100000),
    pending: z.number().int().min(0).max(100000),
  }).nullable().optional(),
  files: z.array(z.record(z.unknown())).max(120).optional(),
  inboxFiles: z.array(z.record(z.unknown())).max(120).optional(),
  folders: z.array(z.union([z.string(), z.record(z.unknown())])).max(80).optional(),
}).default({});
const historyEntry = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(8000),
});
const action = z.object({
  id: z.string().max(100).optional(),
  type: z.enum(['read', 'create', 'update', 'delete', 'move', 'copy', 'archive']),
  path: z.string().max(2048).optional(),
  sourcePath: z.string().max(2048).optional(),
  fromPath: z.string().max(2048).optional(),
  targetPath: z.string().max(2048).optional(),
  toPath: z.string().max(2048).optional(),
  destination: z.string().max(2048).optional(),
  content: z.string().max(2_000_000).optional(),
}).passthrough();

const chatBody = z.object({
  message: z.string().trim().min(1).max(8000),
  context,
  history: z.array(historyEntry).max(12).optional(),
  provider,
  sessionId: z.string().trim().max(120).optional(),
  // assist：默认助手模式（读自动、写需确认）；agent：任务循环模式，模型可多轮自主执行工具
  mode: z.enum(['assist', 'agent']).default('assist'),
  // 默认会对确定性查询走本地秒答；开启后即使是搜索/检查等请求也优先调用外部模型
  preferModel: z.boolean().default(false),
  // agent 模式下允许服务端自动执行写操作（viewer 角色强制无效，全部动作照常审计）
  autoApprove: z.boolean().default(false),
  actor: z.string().trim().max(80).default('local-user'),
  role,
});

export const aiRouter = Router();

aiRouter.use(authenticateAi);

// 非流式对话：CLI / 兼容入口
aiRouter.post('/chat', validate({ body: chatBody }), controller.chat);
// 流式对话（SSE）：前端主入口
aiRouter.post('/chat/stream', validate({ body: chatBody }), controller.chatStream);

// 连通性测试：kind 缺省为对话模型，embedding 用于语义索引配置
aiRouter.post('/test', validate({ body: z.object({
  provider: z.object({
    endpoint: z.string().url().max(500),
    apiKey: z.string().min(1).max(500),
    model: z.string().trim().max(120).optional(),
    authHeader: z.enum(['bearer', 'x-api-key']).default('bearer'),
  }),
  kind: z.enum(['chat', 'embedding']).default('chat'),
}) }), controller.test);

// ── 服务端模型配置（Key 落地服务端，索引管道与 CLI 共用）───────────────
aiRouter.get('/settings', controller.getSettings);
aiRouter.put('/settings', validate({ body: z.object({
  providers: z.array(z.object({
    id: z.string().max(120).optional(),
    name: z.string().max(80).optional(),
    service: z.string().max(80).optional(),
    endpoint: z.string().url().max(500),
    model: z.string().max(120).optional(),
    apiKey: z.string().max(500).optional(),
    authHeader: z.enum(['bearer', 'x-api-key']).default('bearer'),
    enabled: z.boolean().optional(),
  })).max(20).default([]),
  activeProviderId: z.string().max(120).nullable().optional(),
  embedding: z.object({
    endpoint: z.string().url().max(500),
    model: z.string().max(120),
    apiKey: z.string().max(500).optional(),
    authHeader: z.enum(['bearer', 'x-api-key']).default('bearer'),
    name: z.string().max(80).optional(),
  }).nullable().optional(),
}) }), controller.putSettings);

// ── 会话 ─────────────────────────────────────────────────────────────
aiRouter.get('/sessions', controller.listSessions);
aiRouter.post('/sessions', validate({ body: z.object({
  title: z.string().max(120).optional(),
  id: z.string().max(120).optional(),
}).optional() }), controller.createSession);
aiRouter.get('/sessions/:id/messages', validate({ params: z.object({ id: z.string().max(120) }) }), controller.sessionMessages);
aiRouter.patch('/sessions/:id', validate({ params: z.object({ id: z.string().max(120) }), body: z.object({ title: z.string().max(120) }) }), controller.renameSession);
aiRouter.delete('/sessions/:id', validate({ params: z.object({ id: z.string().max(120) }) }), controller.deleteSession);

// ── 语义索引 ─────────────────────────────────────────────────────────
aiRouter.get('/index/status', controller.indexStatus);
aiRouter.post('/index/reindex', controller.reindexAll);
aiRouter.get('/related', validate({ query: z.object({
  noteId: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(12).default(6),
}) }), controller.relatedNotes);

// 检索调试视图：不调用模型，返回双路命中与融合结果
aiRouter.post('/retrieval/preview', validate({ body: z.object({
  query: z.string().trim().min(1).max(500),
}) }), controller.retrievalPreview);

// ── 写作助手（编辑器选区加工）────────────────────────────────────────
const writeBody = z.object({
  instruction: z.string().trim().min(1).max(2000),
  text: z.string().max(20_000).default(''),
  // rewrite：加工选区；continue：续写光标前文；create：从标题/指令创作全文
  mode: z.enum(['rewrite', 'continue', 'create']).default('rewrite'),
  title: z.string().max(200).optional(),
  provider,
});

aiRouter.post('/write', validate({ body: writeBody }), controller.write);
aiRouter.post('/write/stream', validate({ body: writeBody }), controller.writeStream);

// ── 智能建议（双链 / 标签，只读；写入由用户在界面上确认）──────────────
aiRouter.get('/suggestions', validate({ query: z.object({
  noteId: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(10).default(6),
}) }), controller.suggestions);

// ── 每日摘要 ─────────────────────────────────────────────────────────
aiRouter.post('/digest', controller.generateDigest);

// ── 文件操作（保留自 v0.1）───────────────────────────────────────────
aiRouter.post('/operations/preview', validate({ body: z.object({
  actions: z.array(action).min(1).max(30),
  actor: z.string().trim().max(80).default('local-user'),
  role,
  planId: z.string().uuid().optional(),
}) }), controller.preview);

aiRouter.post('/operations/execute', validate({ body: z.object({
  actions: z.array(action).min(1).max(30),
  actor: z.string().trim().max(80).default('local-user'),
  role,
  source: z.enum(['ai-chat', 'cli', 'api']).default('ai-chat'),
  confirmed: z.boolean().default(false),
  planId: z.string().uuid().optional(),
  planHash: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional(),
}) }), controller.execute);

aiRouter.get('/history', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(250).default(80) }) }), controller.history);
