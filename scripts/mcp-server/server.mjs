#!/usr/bin/env node
/**
 * 格物 Lattice 知识库 MCP Server（stdio 传输）。
 *
 * 让 Claude Desktop / 其他支持 MCP 的 Agent 直接读写你的笔记库：
 *   检索读取：search_notes / read_note / list_notes
 *   关系探索：get_note_links / list_tags / get_vault_statistics
 *   写入维护：create_note / update_note（支持 append / prepend）/ restore_note_version
 *   安全回溯：list_note_history
 *
 * 数据底座与主服务完全一致（同一 SQLite 投影 + Markdown 真源），
 * 通过环境变量 DB_FILE / VAULT_DIR 指向同一数据目录即可双端共用。
 *
 * Claude Desktop 配置示例（claude_desktop_config.json）：
 * {
 *   "mcpServers": {
 *     "lattice": {
 *       "command": "node",
 *       "args": ["D:/path/to/lattice/scripts/mcp-server/server.mjs"],
 *       "env": { "DB_FILE": "D:/path/to/data/lattice.db", "VAULT_DIR": "D:/path/to/data/vault" }
 *     }
 *   }
 * }
 */

// config 模块在导入时读取环境变量（fail-fast），
// 因此默认值必须在动态 import 之前就位
process.env.DB_FILE = process.env.DB_FILE || './data/lattice.db';
if (process.env.AUTO_MIGRATE === undefined) process.env.AUTO_MIGRATE = 'true';

const MCP_WRITE_ENABLED = ['true', '1', 'yes'].includes(
  String(process.env.LATTICE_MCP_ALLOW_WRITES ?? '').trim().toLowerCase(),
);

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = await import('zod');

const { openDatabase, closeDatabase } = await import('../../server/src/db/index.js');
const { runMigrations } = await import('../../server/src/db/migrate.js');
const { resolveVaultDir } = await import('../../server/src/vault/config.js');
const { config } = await import('../../server/src/config/index.js');
const notesService = await import('../../server/src/modules/notes/notes.service.js');
const searchService = await import('../../server/src/modules/search/search.service.js');
const tagsService = await import('../../server/src/modules/tags/tags.service.js');
const linksService = await import('../../server/src/modules/links/links.service.js');
const { recordAudit } = await import('../../server/src/modules/ai/ai.operations.js');

openDatabase();
runMigrations();
resolveVaultDir(config.vaultDir);

function asText(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

/** Keep domain failures inside the MCP response so one bad tool call cannot tear down stdio. */
function asError(error) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: {
          code: error?.code ?? 'MCP_TOOL_ERROR',
          message: error?.message ?? String(error),
        },
      }),
    }],
  };
}

function safeTool(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return asError(error);
    }
  };
}

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

/**
 * 按 ID / 标题 / 路径把参数解析成一篇笔记。
 * 优先精确 ID，其次标题、路径，最后标题子串兜底。
 */
function resolveNote(query) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) {
    const error = new Error('query 不能为空');
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  const all = notesService.index();
  const lowered = trimmed.toLowerCase();
  const match = all.find((note) => note.id === trimmed)
    ?? all.find((note) => note.id.toLowerCase().startsWith(lowered) && lowered.length >= 8)
    ?? all.find((note) => note.title === trimmed)
    ?? all.find((note) => String(note.filePath ?? '').toLowerCase() === lowered)
    ?? all.find((note) => String(note.filePath ?? '').toLowerCase().endsWith(`${lowered}.md`))
    ?? all.find((note) => note.title.toLowerCase().includes(lowered));
  if (!match) {
    const error = new Error(`没有找到笔记：${trimmed}`);
    error.code = 'NOT_FOUND';
    throw error;
  }
  return match;
}

const server = new McpServer({
  name: 'lattice',
  version: '0.2.0',
}, {
  instructions: [
    '格物 Lattice 本地知识库：Markdown 双链笔记库。',
    '推荐流程：先用 get_vault_statistics 了解全库规模，再用 search_notes 找材料、read_note 读取；',
    'get_note_links 可以沿反向链接和出链扩展线索，list_tags 帮助按主题定位。',
    MCP_WRITE_ENABLED
      ? '写入工具由 LATTICE_MCP_ALLOW_WRITES 开启；每次修改前必须先向用户确认。'
      : 'MCP 默认是只读模式；设置 LATTICE_MCP_ALLOW_WRITES=true 后才会暴露写入工具。',
    ...(MCP_WRITE_ENABLED ? [
      'create_note / update_note 会直接写入用户的 Vault（Markdown 真源）。',
      '补充内容优先用 update_note 的 append 模式而不是整体重写。',
      '每次修改都会自动留有历史版本（list_note_history），必要时可用 restore_note_version 回滚。',
    ] : []),
  ].join('\n'),
});

server.tool(
  'list_notes',
  '列出知识库中的笔记（按更新时间倒序）',
  { limit: z.number().int().min(1).max(100).default(20) },
  safeTool(async ({ limit }) => asText(notesService.index().slice(0, limit))),
);

server.tool(
  'search_notes',
  '全文检索笔记（支持中文子串），返回标题、路径与摘要',
  {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(20).default(8),
  },
  safeTool(async ({ query, limit }) => {
    const result = searchService.search(String(query).trim(), limit);
    return asText({
      strategy: result.strategy,
      items: result.items.map((item) => ({
        id: item.id,
        title: item.title,
        excerpt: item.excerpt,
      })),
    });
  }),
);

server.tool(
  'read_note',
  '按 ID、标题或路径读取一篇笔记的完整 Markdown 内容（含标签与链接概况）',
  { query: z.string().trim().min(1).max(300) },
  safeTool(async ({ query }) => {
    const match = resolveNote(query);
    const detail = notesService.getDetail(match.id);
    return asText({
      id: detail.id,
      title: detail.title,
      filePath: detail.filePath,
      tags: detail.tags.map((tag) => tag.name),
      outgoingCount: detail.outgoing.length,
      backlinkCount: detail.backlinks.length,
      content: detail.content,
    });
  }),
);

server.tool(
  'get_note_links',
  '查看一篇笔记的双链全景：出链（它引用谁）与反向链接（谁引用它）',
  { query: z.string().trim().min(1).max(300).describe('笔记 ID、标题或路径') },
  safeTool(async ({ query }) => {
    const match = resolveNote(query);
    const detail = notesService.getDetail(match.id);
    return asText({
      id: detail.id,
      title: detail.title,
      outgoing: detail.outgoing.map((link) => ({
        title: link.resolvedTitle ?? link.targetTitle,
        noteId: link.targetNoteId,
        resolved: link.resolved,
      })),
      backlinks: detail.backlinks.map((link) => ({
        title: link.sourceTitle,
        noteId: link.sourceNoteId,
        updatedAt: link.sourceUpdatedAt,
      })),
    });
  }),
);

server.tool(
  'list_tags',
  '列出知识库中的全部标签及使用次数',
  {},
  safeTool(async () => asText(tagsService.list().map((tag) => ({
    name: tag.name,
    noteCount: tag.noteCount,
  })))),
);

server.tool(
  'get_vault_statistics',
  '获取知识库概况：笔记 / 目录 / 标签 / 链接数量与最近更新的笔记',
  {},
  safeTool(async () => {
    const stats = notesService.statistics();
    const recent = notesService.index().slice(0, 5).map((note) => ({
      id: note.id,
      title: note.title,
      updatedAt: note.updatedAt,
    }));
    return asText({ ...stats, recentNotes: recent });
  }),
);

if (MCP_WRITE_ENABLED) {
server.tool(
  'create_note',
  '创建一篇新笔记（写入 Markdown 真源；title 将成为文件名）',
  {
    title: z.string().trim().min(1).max(200),
    content: z.string().max(2_000_000).default(''),
    folderId: z.string().uuid().nullable().default(null),
  },
  safeTool(async ({ title, content, folderId }) => {
    const normalizedTitle = String(title).trim();
    const normalizedContent = String(content ?? '');
    const action = { type: 'create', path: normalizedTitle };
    return auditedMutation(action, () => {
      const created = notesService.create({
        title: normalizedTitle,
        content: normalizedContent,
        folderId,
      });
      action.path = created.filePath;
      return asText({ id: created.id, title: created.title, filePath: created.filePath, folderId: created.folderId });
    });
  }),
);

server.tool(
  'update_note',
  '更新一篇笔记：replace 整体替换（默认）、append 追加到末尾、prepend 插入开头。写入前请先 read_note 并向用户确认',
  {
    noteId: z.string().min(1).max(120),
    content: z.string().max(2_000_000),
    mode: z.enum(['replace', 'append', 'prepend']).default('replace'),
  },
  safeTool(async ({ noteId, content, mode }) => {
    const trimmedId = String(noteId).trim();
    const incoming = String(content ?? '');
    const action = { type: 'update', path: trimmedId };
    return auditedMutation(action, () => {
      let finalContent = incoming;

      if (mode !== 'replace') {
        const current = notesService.getDetail(trimmedId);
        const separator = current.content.endsWith('\n') || incoming.startsWith('\n') ? '\n' : '\n\n';
        finalContent = mode === 'append'
          ? current.content + separator + incoming
          : incoming + separator + current.content;
      }

      const updated = notesService.update(trimmedId, { content: finalContent });
      action.path = updated.filePath ?? trimmedId;
      return asText({ id: updated.id ?? trimmedId, title: updated.title, filePath: updated.filePath, mode, updated: true });
    });
  }),
);

server.tool(
  'list_note_history',
  '列出一篇笔记的历史版本（每次修改自动留档，可用于回滚前查看）',
  { noteId: z.string().min(1).max(120) },
  safeTool(async ({ noteId }) => {
    const match = resolveNote(noteId);
    const history = notesService.listHistory(match.id);
    return asText({
      id: match.id,
      title: match.title,
      currentHash: history.currentHash,
      versions: history.items.map((item) => ({
        version: item.version,
        createdAt: item.createdAt,
      })),
    });
  }),
);

server.tool(
  'restore_note_version',
  '把一篇笔记恢复到指定历史版本（当前内容会先自动存为新版本；传入 expectedCurrentHash 可防止覆盖他人改动）',
  {
    noteId: z.string().min(1).max(120),
    version: z.string().min(1).max(120),
    expectedCurrentHash: z.string().min(1).max(120).optional(),
  },
  safeTool(async ({ noteId, version, expectedCurrentHash }) => {
    const match = resolveNote(noteId);
    return auditedMutation({ type: 'restore', path: match.filePath, targetPath: version }, () => {
      const restored = notesService.restoreHistory(match.id, version, { expectedCurrentHash });
      return asText({
        id: restored.id,
        title: restored.title,
        restoredFrom: version,
        filePath: restored.filePath,
        restored: true,
      });
    });
  }),
);
}

const transport = new StdioServerTransport();
await server.connect(transport);

function shutdown() {
  closeDatabase();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
