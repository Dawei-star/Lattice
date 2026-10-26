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
import { createMcpServer, withVisibleServers, type McpRequiredArg, type McpRequiredEnv, type McpServerConfig } from './mcpSettings.ts';
import type { RegistryServerEntry } from '../api/mcp.ts';

// 品牌 logo 与模型中心同一约定：静态文件放 web/public 下，用绝对路径引用。
const LOGO = (name: string): string => `/mcp-logos/${name}.svg`;

export const MARKET_ID_PREFIX = 'mcp-market-';

/** 安装上下文：占位符可用的取值（如当前 Vault 目录 / 数据库路径）。 */
export type MarketInstallContext = Record<string, string | null | undefined>;

/** 市场目录条目。 */
export interface McpMarketEntry {
  key: string;
  logo: string;
  name: string;
  category: string;
  runtime: 'node' | 'python';
  featured?: boolean;
  tagline: string;
  description: string;
  command: string;
  args?: string[];
  requiresArgs?: McpRequiredArg[];
  env: Record<string, string>;
  requiresEnv?: McpRequiredEnv[];
  tools: Array<{ name: string; description: string }>;
  docs: string;
  authorization?: {
    kind?: string;
    url: string;
    label: string;
    description?: string;
  };
}

export const MCP_MARKET_CATEGORIES = Object.freeze([
  '知识库',
  '日程与计划',
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
    requiresArgs: [{ token: 'vaultDir', label: '允许访问的目录', hint: '默认是当前知识库目录，也可换成别的文件夹', preset: 'vaultDir' }],
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
    requiresArgs: [{ token: 'dbFile', label: 'SQLite 数据库路径', hint: '默认指向 Lattice 的 lattice.db', preset: 'dbFile' }],
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
    key: 'notion-calendar',
    logo: LOGO('notion'),
    name: 'Notion Calendar',
    category: '日程与计划',
    runtime: 'node',
    featured: true,
    tagline: '在 Notion Calendar 可见的数据库中管理日程',
    description: '本地 MCP Server，使用官方 Notion API 读写一个由 Notion Calendar 展示的日历数据库。它不依赖 Notion Calendar 的私有接口；安装时自动绑定本地脚本路径，需填写 Integration Token 和数据库 ID。',
    command: 'node',
    args: ['{notionCalendarServerPath}'],
    requiresArgs: [{ token: 'notionCalendarServerPath', label: 'MCP 脚本路径', hint: '由 Lattice 自动填入；手动配置时填写 scripts/notion-calendar-mcp/server.mjs 的绝对路径' }],
    env: { NOTION_CALENDAR_ALLOW_WRITES: 'false' },
    requiresEnv: [
      { name: 'NOTION_API_KEY', hint: 'Notion Developer → Internal Integration 创建的 Token' },
      { name: 'NOTION_DATABASE_ID', hint: '打开日历数据库后，从 URL 或分享菜单获取数据库 ID' },
    ],
    tools: [
      { name: 'list_calendar_events', description: '按日期或标题列出日历事件' },
      { name: 'get_calendar_event', description: '读取单个日历事件' },
      { name: 'create_calendar_event', description: '创建日历事件（需开启写入）' },
      { name: 'update_calendar_event', description: '更新日历事件（需开启写入）' },
      { name: 'archive_calendar_event', description: '归档日历事件（需开启写入）' },
    ],
    docs: 'https://developers.notion.com/guides/data-apis/create-pages-in-a-data-source',
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
    args: ['mcp-server-git', '--repository', '{repository}'],
    requiresArgs: [{ token: 'repository', label: 'Git 仓库路径', hint: '要交给 Agent 查看的仓库目录；留空则该 Server 不会启用', preset: 'vaultDir' }],
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
] as readonly McpMarketEntry[]);

/**
 * 把 args 里的 {vaultDir} / {dbFile} / {repository} 占位符替换成当前环境已知的路径。
 *
 * 拿不到值时**保留占位符本身**，不回退到条目里的相对默认值：客户端是从任意工作目录
 * 拉起这些进程的，`--repository .` 这种相对路径对它们毫无意义，只会得到一份看着
 * 完整、实际跑不起来的配置。未填的参数由编辑器给出输入框，并在填齐前保持停用。
 */
export function resolveMarketArgs(entry: McpMarketEntry, context: MarketInstallContext = {}): string[] {
  return (entry.args ?? []).map((arg) => {
    const match = /^\{(\w+)\}$/.exec(arg);
    if (!match) return arg;
    const value = context[match[1]];
    return value != null && String(value).trim() ? String(value) : arg;
  });
}

/** 条目里声明的必需参数中，当前上下文还填不出来的那些（用来决定是否默认停用并弹编辑器）。 */
export function unresolvedMarketArgs(entry: McpMarketEntry, context: MarketInstallContext = {}): string[] {
  return (entry.requiresArgs ?? [])
    .map((item) => item.token)
    .filter((token) => !(context[token] != null && String(context[token]).trim()));
}

/**
 * 由市场条目生成一份本机 MCP Server 配置。
 * 需要密钥或必需参数的条目默认先停用——包括 filesystem / sqlite 这类平时能自动绑定、
 * 但 info 尚未返回时无从得知路径的条目。
 */
export function createServerFromMarketEntry(entry: McpMarketEntry, context: MarketInstallContext = {}): McpServerConfig {
  const requiresEnv = entry.requiresEnv ?? [];
  const requiresArgs = entry.requiresArgs ?? [];
  const unresolved = unresolvedMarketArgs(entry, context);
  return createMcpServer({
    id: MARKET_ID_PREFIX + entry.key,
    key: entry.key,
    name: entry.name,
    description: entry.tagline ?? '',
    command: entry.command,
    args: resolveMarketArgs(entry, context),
    env: { ...entry.env },
    transport: 'stdio',
    enabled: requiresEnv.length === 0 && unresolved.length === 0,
    tools: entry.tools ?? [],
    // 编辑器据此为每个待补的密钥 / 参数渲染独立输入框
    requiresEnv,
    requiresArgs,
    argValues: Object.fromEntries(Object.entries(context)
      .filter(([token, value]) => requiresArgs.some((item) => item.token === token) && value != null && String(value).trim())
      .map(([token, value]) => [token, String(value)])),
  });
}

/** 已添加判定：命中市场固定 id，或 key 相同（含从配置文件导入的同名 Server）。 */
export function isMarketEntryInstalled(servers: Pick<McpServerConfig, 'id' | 'key'>[] | null | undefined, entry: McpMarketEntry): boolean {
  return (servers ?? []).some((server) => server.id === MARKET_ID_PREFIX + entry.key || server.key === entry.key);
}

/**
 * 官方 Registry 条目 → 市场条目（E3 ⑤）。
 * Registry 只给启动命令与必需环境变量，工具清单要等首次连接后由 tools/list 填充；
 * key 加 `registry-` 前缀，避免与 12 条静态精选撞名。
 */
export function marketEntryFromRegistry(entry: RegistryServerEntry): McpMarketEntry {
  const requiredEnv: McpRequiredEnv[] = entry.requiredEnv
    .filter((item) => item.required)
    .map((item) => ({ name: item.name, hint: item.hint || (item.secret ? '密钥，仅保存在本机' : '启动必需的环境变量') }));
  return {
    key: 'registry-' + entry.key,
    logo: LOGO('mcp'),
    name: entry.name || entry.fullName,
    category: '在线目录',
    runtime: entry.command === 'uvx' ? 'python' : 'node',
    tagline: entry.description || entry.fullName,
    description: entry.description || '来自官方 MCP Registry 的 Server。',
    command: entry.command,
    args: entry.args,
    env: {},
    requiresEnv: requiredEnv,
    tools: [],
    docs: entry.docs,
  };
}

/**
 * 追加一个市场 Server。
 *
 * 列表尚未落盘（info 还在读取 / 读取失败）时，界面展示的是回退出来的内置 Lattice
 * Server，此时若只往已保存列表追加，内置条目会在下一次保存后消失；因此一律走
 * withVisibleServers 取「当前界面上可见的列表」为基线。
 */
export function appendMarketServer(currentServers: McpServerConfig[], fallbackServers: McpServerConfig[] | null | undefined, server: McpServerConfig): McpServerConfig[] {
  return withVisibleServers(currentServers, fallbackServers, (base) => [...base, server]);
}
