import path from 'node:path';
import { serverRoot, config } from '../../config/index.js';
import { resolveVaultDir } from '../../vault/config.js';

const tools = [
  { name: 'list_notes', description: '列出知识库中的笔记' },
  { name: 'search_notes', description: '全文搜索笔记' },
  { name: 'read_note', description: '读取笔记的完整 Markdown 内容' },
  { name: 'create_note', description: '创建一篇新笔记' },
  { name: 'update_note', description: '更新笔记正文' },
];

export function getInfo(_req, res) {
  res.json({
    data: {
      name: 'lattice',
      transport: 'stdio',
      command: process.execPath,
      serverPath: path.resolve(serverRoot, '..', 'scripts', 'mcp-server', 'server.mjs'),
      dbFile: config.dbFile,
      vaultDir: resolveVaultDir(config.vaultDir),
      tools,
    },
  });
}
