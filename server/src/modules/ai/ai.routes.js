import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { forbidViewerWrite } from '../../middleware/roleGuard.js';
import { authenticateAi } from './ai.auth.js';
import * as controller from './ai.controller.js';

const role = z.enum(['viewer', 'editor', 'admin']).default('editor');
const provider = z.object({
  endpoint: z.string().url().max(500),
  apiKey: z.string().min(1).max(500),
  model: z.string().trim().max(120).optional(),
  authHeader: z.enum(['bearer', 'x-api-key']).default('bearer'),
  contextWindowTokens: z.coerce.number().int().min(8_000).max(1_000_000).optional(),
}).nullable().optional();
const context = z.object({
  // 上下文范围选择（当前笔记/项目/收件箱/全部）：restrictContextForExpert 按它
  // 收窄发给外部模型的上下文，缺失时恒按 'auto' 处理导致选择失效
  scope: z.enum(['auto', 'current', 'project', 'inbox', 'all', 'none']).optional(),
  scopeLabel: z.string().max(80).optional(),
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
  content: z.string().max(32_000),
});
// 用户在设置页启用的外部 MCP Server：随聊天请求带来，由后端拉起/连接供模型调用。
// 本地应用模型：客户端持有 provider 密钥与文件写入能力，这里的形状校验只做上限收敛。
const mcpServer = z.object({
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().max(120).optional(),
  transport: z.enum(['stdio', 'sse']).default('stdio'),
  command: z.string().trim().max(2048).optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  env: z.record(z.string(), z.string().max(4096)).optional(),
  url: z.string().trim().max(2048).optional(),
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
  expertId: z.string().trim().regex(/^[a-z0-9][a-z0-9-_]{1,79}$/).default('general'),
  routingMode: z.enum(['explicit', 'auto']).default('explicit'),
  context,
  history: z.array(historyEntry).max(2_000).optional(),
  provider,
  sessionId: z.string().trim().max(120).optional(),
  // assist：默认助手模式（读自动、写需确认）；agent：任务循环模式，模型可多轮自主执行工具
  mode: z.enum(['assist', 'agent']).default('assist'),
  // 默认会对确定性查询走本地秒答；开启后即使是搜索/检查等请求也优先调用外部模型
  preferModel: z.boolean().default(false),
  // 保留旧字段兼容客户端；服务端不会根据该字段自动批准写操作
  autoApprove: z.boolean().default(false),
  actor: z.string().trim().max(80).default('local-user'),
  role,
  // 外部 MCP 工具清单：空/缺省时不拉起任何进程，行为与旧版完全一致
  mcpServers: z.array(mcpServer).max(8).optional(),
  // 重新生成：服务端先移除会话最后一轮（上一次的 user+assistant）再执行本条
  regenerate: z.boolean().default(false),
});

export const aiRouter = Router();

aiRouter.use(authenticateAi);

// 非流式对话：CLI / 兼容入口
aiRouter.post('/chat', validate({ body: chatBody }), controller.chat);
// 流式对话（SSE）：前端主入口
aiRouter.post('/chat/stream', validate({ body: chatBody }), controller.chatStream);

// MCP 预热：打开连接并列出工具后立即返回（预热在后台继续），把冷启动移出第一条消息
aiRouter.post('/mcp/warmup', validate({ body: z.object({
  mcpServers: z.array(mcpServer).max(8).default([]),
  role,
}) }), controller.warmupMcp);

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
aiRouter.put('/settings', forbidViewerWrite, validate({ body: z.object({
  providers: z.array(z.object({
    id: z.string().max(120).optional(),
    name: z.string().max(80).optional(),
    service: z.string().max(80).optional(),
    endpoint: z.string().url().max(500),
    model: z.string().max(120).optional(),
    apiKey: z.string().max(500).optional(),
    authHeader: z.enum(['bearer', 'x-api-key']).default('bearer'),
    enabled: z.boolean().optional(),
    // 高级参数：缺省沿用服务端默认（temperature 0.2 / 不限制输出长度）
    temperature: z.coerce.number().min(0).max(2).optional(),
    maxTokens: z.coerce.number().int().min(1).max(200_000).optional(),
    contextWindowTokens: z.coerce.number().int().min(8_000).max(1_000_000).optional(),
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
aiRouter.get('/sessions', validate({ query: z.object({
  expertId: z.string().trim().regex(/^[a-z0-9][a-z0-9-_]{1,79}$/).default('general'),
  query: z.string().trim().max(120).default(''),
  searchContent: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}) }), controller.listSessions);
aiRouter.post('/sessions', validate({ body: z.object({
  title: z.string().max(120).optional(),
  id: z.string().max(120).optional(),
  expertId: z.string().trim().regex(/^[a-z0-9][a-z0-9-_]{1,79}$/).default('general'),
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
  additionalConfirmed: z.boolean().default(false),
  sensitiveConfirmed: z.boolean().default(false),
  planId: z.string().uuid().optional(),
  planHash: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional(),
}) }), controller.execute);

aiRouter.get('/history', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(250).default(80) }) }), controller.history);
