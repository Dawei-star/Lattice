#!/usr/bin/env node
/**
 * Lattice MCP stdio server.
 * The Markdown Vault remains the source of truth; this process shares the
 * SQLite projection and domain services with the HTTP server.
 */
process.env.DB_FILE = process.env.DB_FILE || './data/lattice.db';
if (process.env.AUTO_MIGRATE === undefined) process.env.AUTO_MIGRATE = 'true';

const writesEnabled = ['true', '1', 'yes'].includes(
  String(process.env.LATTICE_MCP_ALLOW_WRITES ?? '').trim().toLowerCase(),
);

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = await import('zod');
const { openDatabase, closeDatabase } = await import('../../server/src/db/index.js');
const { runMigrations } = await import('../../server/src/db/migrate.js');
const { config } = await import('../../server/src/config/index.js');
const { resolveVaultDir } = await import('../../server/src/vault/config.js');
const notes = await import('../../server/src/modules/notes/notes.service.js');
const search = await import('../../server/src/modules/search/search.service.js');
const tags = await import('../../server/src/modules/tags/tags.service.js');
const { recordAudit } = await import('../../server/src/modules/ai/ai.operations.js');

openDatabase();
if (config.autoMigrate) runMigrations();
process.stderr.write(`[mcp] DB_FILE=${config.dbFile}\n[mcp] VAULT_DIR=${resolveVaultDir(config.vaultDir)}\n`);

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const asError = (error) => ({
  isError: true,
  content: [{
    type: 'text',
    text: JSON.stringify({ error: { code: error?.code ?? 'MCP_TOOL_ERROR', message: error?.message ?? String(error) } }),
  }],
});

const safeTool = (handler) => async (args) => {
  try {
    return await handler(args);
  } catch (error) {
    return asError(error);
  }
};

async function auditedMutation(action, handler) {
  try {
    const result = await handler();
    recordAudit({ actor: 'mcp', role: 'editor', source: 'mcp', action, status: 'completed' });
    return result;
  } catch (error) {
    recordAudit({ actor: 'mcp', role: 'editor', source: 'mcp', action, status: 'failed', error: error?.message ?? String(error) });
    throw error;
  }
}

function resolveNote(query) {
  const value = String(query ?? '').trim();
  if (!value) throw Object.assign(new Error('query 不能为空'), { code: 'INVALID_ARGUMENT' });
  const lowered = value.toLowerCase();
  const all = notes.index();
  const match = all.find((note) => note.id === value)
    ?? all.find((note) => note.id.toLowerCase().startsWith(lowered) && lowered.length >= 8)
    ?? all.find((note) => note.title === value)
    ?? all.find((note) => String(note.filePath ?? '').toLowerCase() === lowered)
    ?? all.find((note) => String(note.filePath ?? '').toLowerCase().endsWith(`${lowered}.md`))
    ?? all.find((note) => note.title.toLowerCase().includes(lowered));
  if (!match) throw Object.assign(new Error(`没有找到笔记：${value}`), { code: 'NOT_FOUND' });
  return match;
}

const server = new McpServer({ name: 'lattice', version: '0.1.5' }, {
  instructions: [
    '格物 Lattice 本地知识库：Markdown 双链笔记库。',
    '推荐流程：先用 get_vault_statistics 了解全库规模，再用 search_notes 找材料、read_note 读取。',
    writesEnabled
      ? '写入工具由 LATTICE_MCP_ALLOW_WRITES 开启；每次修改前必须先向用户确认。'
      : 'MCP 默认是只读模式；设置 LATTICE_MCP_ALLOW_WRITES=true 后才会暴露写入工具。',
  ].join('\n'),
});

server.tool('list_notes', '列出知识库中的笔记（按更新时间倒序）', {
  limit: z.number().int().min(1).max(100).default(20),
}, safeTool(async ({ limit }) => asText(notes.index().slice(0, limit))));

server.tool('search_notes', '全文检索笔记（支持中文子串），返回标题、路径与摘要', {
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(8),
}, safeTool(async ({ query, limit }) => {
  const result = search.search(String(query).trim(), limit);
  return asText({ strategy: result.strategy, items: result.items.map(({ id, title, excerpt }) => ({ id, title, excerpt })) });
}));

server.tool('read_note', '按 ID、标题或路径读取一篇笔记的完整 Markdown 内容', {
  query: z.string().trim().min(1).max(300),
}, safeTool(async ({ query }) => {
  const match = resolveNote(query);
  const detail = notes.getDetail(match.id);
  return asText({
    id: detail.id,
    title: detail.title,
    filePath: detail.filePath,
    tags: detail.tags.map((tag) => tag.name),
    outgoingCount: detail.outgoing.length,
    backlinkCount: detail.backlinks.length,
    content: detail.content,
  });
}));

server.tool('get_note_links', '查看一篇笔记的出链与反向链接', {
  query: z.string().trim().min(1).max(300),
}, safeTool(async ({ query }) => {
  const detail = notes.getDetail(resolveNote(query).id);
  return asText({
    id: detail.id,
    title: detail.title,
    outgoing: detail.outgoing.map((link) => ({ title: link.resolvedTitle ?? link.targetTitle, noteId: link.targetNoteId, resolved: link.resolved })),
    backlinks: detail.backlinks.map((link) => ({ title: link.sourceTitle, noteId: link.sourceNoteId, updatedAt: link.sourceUpdatedAt })),
  });
}));

server.tool('list_tags', '列出知识库中的全部标签及使用次数', {}, safeTool(async () => (
  asText(tags.list().map(({ name, noteCount }) => ({ name, noteCount })))
)));

server.tool('search_by_tag', '按标签筛选笔记', {
  tag: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(100).default(20),
}, safeTool(async ({ tag, limit }) => {
  const all = tags.list();
  const lowered = tag.toLowerCase();
  const exact = all.filter((item) => item.name.toLowerCase() === lowered);
  const scope = exact.length ? exact : all.filter((item) => item.name.toLowerCase().includes(lowered));
  return asText({
    tag,
    matched: exact.length > 0,
    tags: scope.map(({ name, noteCount }) => ({ name, noteCount })),
    notes: scope.flatMap((item) => tags.notesByTag(item.name)).slice(0, limit),
    suggestions: scope.length ? [] : all.slice(0, 10).map((item) => item.name),
  });
}));

server.tool('get_vault_statistics', '获取知识库概况与最近更新', {}, safeTool(async () => (
  asText({
    ...notes.statistics(),
    recentNotes: notes.index().slice(0, 5).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
  })
)));

server.tool('list_note_history', '列出一篇笔记的历史版本', {
  noteId: z.string().min(1).max(120),
}, safeTool(async ({ noteId }) => {
  const match = resolveNote(noteId);
  const history = notes.listHistory(match.id);
  return asText({ id: match.id, title: match.title, currentHash: history.currentHash, versions: history.items.map(({ version, createdAt }) => ({ version, createdAt })) });
}));

if (writesEnabled) {
  server.tool('create_note', '创建一篇新笔记', {
    title: z.string().trim().min(1).max(200),
    content: z.string().max(2_000_000).default(''),
    folderId: z.string().uuid().nullable().default(null),
  }, safeTool(async ({ title, content, folderId }) => {
    const action = { type: 'create', path: title };
    return auditedMutation(action, () => {
      const created = notes.create({ title, content, folderId });
      action.path = created.filePath;
      return asText({ id: created.id, title: created.title, filePath: created.filePath, folderId: created.folderId });
    });
  }));

  server.tool('update_note', '更新一篇笔记：replace、append 或 prepend', {
    noteId: z.string().min(1).max(120),
    content: z.string().max(2_000_000),
    mode: z.enum(['replace', 'append', 'prepend']).default('replace'),
  }, safeTool(async ({ noteId, content, mode }) => {
    const action = { type: 'update', path: noteId };
    return auditedMutation(action, () => {
      let finalContent = content;
      if (mode !== 'replace') {
        const current = notes.getDetail(noteId);
        const separator = current.content.endsWith('\n') || content.startsWith('\n') ? '\n' : '\n\n';
        finalContent = mode === 'append' ? current.content + separator + content : content + separator + current.content;
      }
      const updated = notes.update(noteId, { content: finalContent });
      action.path = updated.filePath ?? noteId;
      return asText({ id: updated.id ?? noteId, title: updated.title, filePath: updated.filePath, mode, updated: true });
    });
  }));

  server.tool('restore_note_version', '把一篇笔记恢复到指定历史版本', {
    noteId: z.string().min(1).max(120),
    version: z.string().min(1).max(120),
    expectedCurrentHash: z.string().min(1).max(120).optional(),
  }, safeTool(async ({ noteId, version, expectedCurrentHash }) => {
    const match = resolveNote(noteId);
    return auditedMutation({ type: 'restore', path: match.filePath, targetPath: version }, () => {
      const restored = notes.restoreHistory(match.id, version, { expectedCurrentHash });
      return asText({ id: restored.id, title: restored.title, restoredFrom: version, filePath: restored.filePath, restored: true });
    });
  }));
}

const transport = new StdioServerTransport();
await server.connect(transport);

function shutdown() {
  try {
    closeDatabase();
  } catch (error) {
    process.stderr.write(`[mcp] closeDatabase failed: ${error?.message ?? error}\n`);
  }
  process.exit(0);
}

process.stdin.once('end', shutdown);
process.stdin.once('close', shutdown);
transport.onclose = shutdown;
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
