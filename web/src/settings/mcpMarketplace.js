/**
 * MCP 插件市场：精选适配「本地知识库 + 外部 Agent」场景的 MCP Server 目录。
 *
 * 目录是静态内置的（离线可用、不依赖远端），条目只收录主流且长期维护的官方 /
 * 参考实现；「添加」只是把一份可编辑的配置写入本机 MCP 设置，
 * 真正拉起进程的仍是 Claude Desktop 等 MCP 客户端。
 *
 * args 中的 {vaultDir} / {dbFile} 占位符会在安装时用当前 Vault / 数据库路径替换
 * （见 resolveMarketArgs），让文件、数据库类服务器开箱即用。
 *
 * 每个条目的 logo 指向 web/public/mcp-logos/<name>.svg，品牌矢量取自 Simple Icons
 * （CC0 的图标数据，商标仍归各品牌所有），与模型中心 provider-logos 同一套约定；
 * Filesystem / Fetch / Memory / Sequential Thinking / Time / Everything 是 MCP 官方
 * 参考实现，没有独立品牌，统一用 modelcontextprotocol 官方标识。
 */
import { createMcpServer, withVisibleServers } from './mcpSettings.js';

// 品牌 logo 与模型中心同一约定：静态文件放 web/public 下，用绝对路径引用。
const LOGO = (name) => `/mcp-logos/${name}.svg`;

export const MARKET_ID_PREFIX = 'mcp-market-';

export const MCP_MARKET_CATEGORIES = Object.freeze([
  '知识库',
  '文件与系统',
  '网络与搜索',
  'AI 增强',
  '开发辅助',
  '效率与调试',
]);

export const MCP_MARKET_RUNTIME_HINT = Object.freeze({
  node: '需要本机 Node.js（npx）',
  python: '需要 Python 的 uv（uvx）',
});

const OFFICIAL_SERVERS_URL = 'https://github.com/modelcontextprotocol/servers/tree/main/src';

export const MCP_MARKET_CATALOG = Object.freeze([
  {
    key: 'filesystem',
    logo: LOGO('mcp'),
    name: 'Filesystem',
    category: '文件与系统',
    runtime: 'node',
    featured: true,
    tagline: '让外部 Agent 读写本机指定目录内的文件',
    description: '官方参考服务器：在受控目录内提供读取、写入、移动、搜索文件与目录树等工具，越界路径会被拒绝。安装时自动绑定当前 Vault 目录。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{vaultDir}'],
    argDefaults: { vaultDir: '.' },
    env: {},
    tools: [
      { name: 'read_file', description: '读取单个文件内容' },
      { name: 'write_file', description: '创建或覆盖文件' },
      { name: 'list_directory', description: '列出目录内容' },
      { name: 'search_files', description: '按名称递归搜索文件' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/filesystem`,
  },
  {
    key: 'sqlite',
    logo: LOGO('sqlite'),
    name: 'SQLite Explorer',
    category: '知识库',
    runtime: 'python',
    tagline: '查询本地 SQLite 数据库的表结构与数据',
    description: '安装时自动绑定 Lattice 的 lattice.db，可以用 SQL 检索笔记元数据、标签、双链等投影数据。含写工具，日常只读使用即可。',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '{dbFile}'],
    argDefaults: { dbFile: './data/lattice.db' },
    env: {},
    tools: [
      { name: 'read_query', description: '执行只读 SQL 查询' },
      { name: 'list_tables', description: '列出数据库中的表' },
      { name: 'describe_table', description: '查看表结构' },
      { name: 'write_query', description: '执行写入 SQL' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/sqlite`,
  },
  {
    key: 'obsidian',
    logo: LOGO('obsidian'),
    name: 'Obsidian',
    category: '知识库',
    runtime: 'python',
    tagline: '通过 Local REST API 读写 Obsidian 库',
    description: 'Lattice 与 Obsidian 的 Markdown 结构同源兼容；如果你同时使用 Obsidian，这套工具可以检索、追加与修改其库内笔记。',
    command: 'uvx',
    args: ['mcp-obsidian'],
    env: { OBSIDIAN_HOST: '127.0.0.1:27124' },
    requiresEnv: [{ name: 'OBSIDIAN_API_KEY', hint: 'Obsidian 需安装 Local REST API 插件，Key 在插件设置中查看' }],
    tools: [
      { name: 'get_file_contents', description: '读取库内文件内容' },
      { name: 'list_files_in_dir', description: '列出目录下的文件' },
      { name: 'search', description: '简单检索库内笔记' },
      { name: 'append_content', description: '向笔记追加内容' },
    ],
    docs: 'https://github.com/MarkusPfundstein/mcp-obsidian',
  },
  {
    key: 'fetch',
    logo: LOGO('mcp'),
    name: 'Fetch',
    category: '网络与搜索',
    runtime: 'python',
    featured: true,
    tagline: '抓取网页并转为 Markdown 供模型阅读',
    description: '官方参考服务器：拉取 URL 内容并去掉噪音转成 Markdown，支持 robots.txt 约束；让 Agent 能引用网上资料再沉淀进笔记。',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: {},
    tools: [
      { name: 'fetch', description: '抓取 URL 并转为 Markdown' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/fetch`,
  },
  {
    key: 'brave-search',
    logo: LOGO('brave'),
    name: 'Brave Search',
    category: '网络与搜索',
    runtime: 'node',
    tagline: '联网搜索网页与新闻',
    description: '官方参考服务器：通过 Brave Search API 进行网页检索，适合先搜索、再用 Fetch 抓原文的组合。免费档每月 2000 次查询。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: {},
    requiresEnv: [{ name: 'BRAVE_API_KEY', hint: '在 brave.com/search/api 免费申请' }],
    tools: [
      { name: 'brave_web_search', description: '网页搜索（分页可选）' },
      { name: 'brave_local_search', description: '查找本地商家与地点' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/brave-search`,
  },
  {
    key: 'puppeteer',
    logo: LOGO('puppeteer'),
    name: 'Puppeteer',
    category: '网络与搜索',
    runtime: 'node',
    tagline: '驱动无头浏览器：导航、截图与执行脚本',
    description: '官方参考服务器：让 Agent 操作真实浏览器完成登录页面、截图存档、抓取需要渲染的页面等任务。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    env: {},
    tools: [
      { name: 'puppeteer_navigate', description: '导航到指定 URL' },
      { name: 'puppeteer_screenshot', description: '截取当前页面' },
      { name: 'puppeteer_click', description: '点击页面元素' },
      { name: 'puppeteer_evaluate', description: '在页面中执行脚本' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/puppeteer`,
  },
  {
    key: 'memory',
    logo: LOGO('mcp'),
    name: 'Memory',
    category: 'AI 增强',
    runtime: 'node',
    featured: true,
    tagline: '基于知识图谱的长期记忆（实体 / 关系 / 事实）',
    description: '官方参考服务器：把对话中的实体、关系与观察沉淀成本地知识图谱（JSONL 存储），跨会话记住你的偏好与项目上下文。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    tools: [
      { name: 'create_entities', description: '创建实体节点' },
      { name: 'add_observations', description: '为实体追加事实' },
      { name: 'search_nodes', description: '检索图谱节点' },
      { name: 'read_graph', description: '读取整个图谱' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/memory`,
  },
  {
    key: 'sequential-thinking',
    logo: LOGO('mcp'),
    name: 'Sequential Thinking',
    category: 'AI 增强',
    runtime: 'node',
    featured: true,
    tagline: '分步推理工具：动态修正与分支思考',
    description: '官方参考服务器：提供一个可中途修订、可分支假设的思考工具，适合复杂任务的规划与推演。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: {},
    tools: [
      { name: 'sequentialthinking', description: '记录并推进分步思考' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/sequentialthinking`,
  },
  {
    key: 'git',
    logo: LOGO('git'),
    name: 'Git',
    category: '开发辅助',
    runtime: 'python',
    tagline: '只读查看 Git 仓库的状态、差异与历史',
    description: '官方参考服务器：查看仓库状态、提交历史、差异与单次提交内容；配合笔记库的 Git 备份或代码仓库都好用。',
    command: 'uvx',
    args: ['mcp-server-git'],
    env: {},
    tools: [
      { name: 'git_status', description: '查看工作区状态' },
      { name: 'git_log', description: '查看提交历史' },
      { name: 'git_diff', description: '查看差异' },
      { name: 'git_show', description: '查看单次提交内容' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/git`,
  },
  {
    key: 'github',
    logo: LOGO('github'),
    name: 'GitHub',
    category: '开发辅助',
    runtime: 'node',
    tagline: '管理仓库、Issue 与 Pull Request',
    description: '官方参考服务器：创建 Issue、查阅 PR、读取仓库文件与检索代码，需要一个 GitHub Personal Access Token。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {},
    requiresEnv: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', hint: 'GitHub → Settings → Developer settings → Personal access tokens' }],
    tools: [
      { name: 'create_issue', description: '创建 Issue' },
      { name: 'list_issues', description: '列出 Issue' },
      { name: 'get_file_contents', description: '读取仓库文件' },
      { name: 'search_repositories', description: '检索仓库' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/github`,
  },
  {
    key: 'time',
    logo: LOGO('mcp'),
    name: 'Time',
    category: '效率与调试',
    runtime: 'python',
    tagline: '查询当前时间与时区换算',
    description: '官方参考服务器：获取指定时区当前时间、在时区间换算；写日记与日程类笔记时的小帮手。',
    command: 'uvx',
    args: ['mcp-server-time'],
    env: {},
    tools: [
      { name: 'get_current_time', description: '查询指定时区当前时间' },
      { name: 'convert_time', description: '时区之间换算' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/time`,
  },
  {
    key: 'everything',
    logo: LOGO('mcp'),
    name: 'Everything',
    category: '效率与调试',
    runtime: 'node',
    tagline: '官方测试服务器：验证 MCP 客户端连接',
    description: '包含回显、加法、长任务等演示工具，用于确认 MCP 客户端配置是否生效，或体验工具调用流程。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    env: {},
    tools: [
      { name: 'echo', description: '原样回显输入' },
      { name: 'add', description: '两数相加' },
      { name: 'printEnv', description: '回显环境变量' },
    ],
    docs: `${OFFICIAL_SERVERS_URL}/everything`,
  },
]);

/** 把 args 中的 {vaultDir} / {dbFile} 占位符替换为当前环境路径，缺省时退回条目自带默认值。 */
export function resolveMarketArgs(entry, context = {}) {
  return (entry.args ?? []).map((arg) => {
    const match = /^\{(\w+)\}$/.exec(arg);
    if (!match) return arg;
    const token = match[1];
    const value = context[token] ?? entry.argDefaults?.[token];
    return value != null && String(value).trim() ? String(value) : arg;
  });
}

/** 由市场条目生成一份本机 MCP Server 配置；需要密钥的条目默认先停用。 */
export function createServerFromMarketEntry(entry, context = {}) {
  return createMcpServer({
    id: MARKET_ID_PREFIX + entry.key,
    key: entry.key,
    name: entry.name,
    description: entry.tagline ?? '',
    command: entry.command,
    args: resolveMarketArgs(entry, context),
    env: { ...entry.env },
    transport: 'stdio',
    enabled: !(entry.requiresEnv ?? []).length,
    tools: entry.tools ?? [],
    // 编辑器据此为每个待补的密钥渲染独立输入框
    requiresEnv: entry.requiresEnv ?? [],
  });
}

/** 已添加判定：命中市场固定 id，或 key 相同（含从配置文件导入的同名 Server）。 */
export function isMarketEntryInstalled(servers, entry) {
  return (servers ?? []).some((server) => server.id === MARKET_ID_PREFIX + entry.key || server.key === entry.key);
}

/**
 * 追加一个市场 Server。
 *
 * 列表尚未落盘（info 还在读取 / 读取失败）时，界面展示的是回退出来的内置 Lattice
 * Server，此时若只往已保存列表追加，内置条目会在下一次保存后消失；因此一律走
 * withVisibleServers 取「当前界面上可见的列表」为基线。
 */
export function appendMarketServer(currentServers, fallbackServers, server) {
  return withVisibleServers(currentServers, fallbackServers, (base) => [...base, server]);
}
