import path from 'node:path';
import { serverRoot, config } from '../../config/index.js';
import { resolveVaultDir } from '../../vault/config.js';

const tools = [
  { name: 'list_notes', description: '列出知识库中的笔记' },
  { name: 'search_notes', description: '全文搜索笔记' },
  { name: 'read_note', description: '按 ID、标题或路径读取笔记内容' },
  { name: 'get_note_links', description: '查看笔记的出链与反向链接' },
  { name: 'list_tags', description: '列出全部标签及使用次数' },
  { name: 'get_vault_statistics', description: '获取知识库概况与最近更新' },
  { name: 'create_note', description: '创建一篇新笔记' },
  { name: 'update_note', description: '更新笔记正文（支持追加 / 前插 / 替换）' },
  { name: 'list_note_history', description: '列出笔记的历史版本' },
  { name: 'restore_note_version', description: '把笔记恢复到指定历史版本' },
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
