import path from 'node:path';
import { serverRoot, config } from '../../config/index.js';
import { resolveVaultDir } from '../../vault/config.js';
import { loadProjectMcpConfig, saveProjectMcpConfig } from './mcp.project.js';

/**
 * 内置 Lattice MCP Server 的完整工具清单。
 *
 * `write: true` 的工具只有在服务端进程带 `LATTICE_MCP_ALLOW_WRITES` 启动时才会真正注册；
 * 设置页需要把「现在可用」与「开启后可用」都讲清楚，因此这里返回全量清单并逐条带上
 * `enabled`，而不是像早期那样直接把未启用的写入工具从响应里删掉——否则界面无从得知
 * 还有哪些能力、又需要什么条件才能打开。
 */
const ALL_TOOLS = Object.freeze([
  { name: 'list_notes', description: '列出知识库中的笔记', write: false },
  { name: 'search_notes', description: '全文搜索笔记', write: false },
  { name: 'read_note', description: '按 ID、标题或路径读取笔记内容', write: false },
  { name: 'get_note_links', description: '查看笔记的出链与反向链接', write: false },
  { name: 'list_tags', description: '列出全部标签及使用次数', write: false },
  { name: 'search_by_tag', description: '按标签筛选笔记', write: false },
  { name: 'get_vault_statistics', description: '获取知识库概况与最近更新', write: false },
  { name: 'list_note_history', description: '列出笔记的历史版本', write: false },
  { name: 'create_note', description: '创建一篇新笔记', write: true },
  { name: 'update_note', description: '更新笔记正文（支持追加 / 前插 / 替换）', write: true },
  { name: 'restore_note_version', description: '把笔记恢复到指定历史版本', write: true },
]);

export const WRITES_ENV_VAR = 'LATTICE_MCP_ALLOW_WRITES';

const writesEnabled = ['true', '1', 'yes'].includes(
  String(process.env[WRITES_ENV_VAR] ?? '').trim().toLowerCase(),
);

const tools = ALL_TOOLS.map((tool) => ({
  ...tool,
  enabled: tool.write ? writesEnabled : true,
}));

export function getInfo(_req, res) {
  res.json({
    data: {
      name: 'lattice',
      transport: 'stdio',
      command: process.execPath,
      serverPath: path.resolve(serverRoot, '..', 'scripts', 'mcp-server', 'server.mjs'),
      // 桌面版把 Node 后端内嵌进 Electron 主进程，process.execPath 是 lattice.exe：
      // 外部客户端直接拉起它会开一个新窗口而不是跑 MCP Server，
      // 需要在导出配置的 env 里带 ELECTRON_RUN_AS_NODE=1（纯 node 运行时此标志为 false）。
      electronRuntime: Boolean(process.versions.electron),
      dbFile: config.dbFile,
      vaultDir: resolveVaultDir(config.vaultDir),
      writesEnabled,
      writesEnvVar: WRITES_ENV_VAR,
      tools,
      enabledToolCount: tools.filter((tool) => tool.enabled).length,
      writeToolCount: tools.filter((tool) => tool.write).length,
    },
  });
}

/** 项目级 MCP 配置（<Vault>/.lattice/mcp.json）：读视图，含文件路径与状态 */
export function getProject(_req, res) {
  const result = loadProjectMcpConfig();
  res.json({
    data: {
      path: result.filePath,
      status: result.status,
      warning: result.warning,
      servers: result.servers,
    },
  });
}

/** 保存项目级 MCP 配置；body 允许 { mcpServers: {...} } 或裸映射 */
export function putProject(req, res) {
  const result = saveProjectMcpConfig(req.valid.body);
  res.json({
    data: {
      path: result.filePath,
      status: result.status,
      warning: result.warning,
      servers: result.servers,
    },
  });
}
