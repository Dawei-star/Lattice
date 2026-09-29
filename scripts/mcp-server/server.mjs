#!/usr/bin/env node
/**
 * 格物 Lattice 知识库 MCP Server（stdio 传输）。
 *
 * 让 Claude Desktop / 其他支持 MCP 的 Agent 直接读写你的笔记库：
 *   search_notes / read_note / list_notes / create_note / update_note
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

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = await import('zod');

const { openDatabase, closeDatabase } = await import('../../server/src/db/index.js');
const { runMigrations } = await import('../../server/src/db/migrate.js');
const { resolveVaultDir } = await import('../../server/src/vault/config.js');
const { config } = await import('../../server/src/config/index.js');
const notesService = await import('../../server/src/modules/notes/notes.service.js');
const searchService = await import('../../server/src/modules/search/search.service.js');

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

const server = new McpServer({
  name: 'lattice',
  version: '0.1.0',
}, {
  instructions: '格物 Lattice 本地知识库：Markdown 双链笔记库。优先用 search_notes 找材料、read_note 读取；create_note / update_note 会直接写入用户的 Vault（Markdown 真源），写入前请向用户确认。',
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
  '按标题或路径读取一篇笔记的完整 Markdown 内容',
  { query: z.string().trim().min(1).max(300) },
  safeTool(async ({ query }) => {
    const trimmed = String(query).trim();
    const all = notesService.index();
    const match = all.find((note) => note.title === trimmed)
      ?? all.find((note) => String(note.filePath ?? '').toLowerCase() === trimmed.toLowerCase())
      ?? all.find((note) => String(note.filePath ?? '').toLowerCase().endsWith(`${trimmed.toLowerCase()}.md`))
      ?? all.find((note) => note.title.toLowerCase().includes(trimmed.toLowerCase()));
    if (!match) {
      const error = new Error(`没有找到笔记：${trimmed}`);
      error.code = 'NOT_FOUND';
      throw error;
    }
    const detail = notesService.getDetail(match.id);
    return asText({ id: detail.id, title: detail.title, filePath: detail.filePath ?? match.filePath, content: detail.content });
  }),
);

server.tool(
  'create_note',
  '创建一篇新笔记（写入 Markdown 真源；title 将成为文件名）',
  {
    title: z.string().trim().min(1).max(200),
    content: z.string().max(2_000_000).default(''),
    folderId: z.string().uuid().nullable().default(null),
  },
  safeTool(async ({ title, content, folderId }) => {
    const created = notesService.create({
      title: String(title).trim(),
      content: String(content ?? ''),
      folderId,
    });
    return asText({ id: created.id, title: created.title, filePath: created.filePath, folderId: created.folderId });
  }),
);

server.tool(
  'update_note',
  '更新一篇笔记的正文（整体替换；写入前请先 read_note 并向用户确认）',
  {
    noteId: z.string().min(1).max(120),
    content: z.string().max(2_000_000),
  },
  safeTool(async ({ noteId, content }) => {
    const updated = notesService.update(String(noteId).trim(), { content: String(content ?? '') });
    return asText({ id: updated.id ?? noteId, title: updated.title, filePath: updated.filePath, updated: true });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

function shutdown() {
  closeDatabase();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
