import { http, type RequestOptions } from './client.ts';

/** 项目级 MCP Server 配置项（.lattice/mcp.json 的 mcpServers 值）。 */
export interface McpServerEntry {
  id?: string;
  key?: string;
  name?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  [key: string]: unknown;
}

/** 项目级 MCP 配置文档（<Vault>/.lattice/mcp.json）。 */
export interface McpProjectDocument {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/** 项目级 MCP 配置读取/保存结果。 */
export interface McpProjectState {
  path?: string;
  status?: 'default' | 'loaded' | 'invalid' | string;
  servers?: McpServerEntry[];
  warning?: string;
  [key: string]: unknown;
}

/** MCP 服务信息（GET /mcp/info）。 */
export interface McpInfo {
  [key: string]: unknown;
}

/** E3：MCP 工具条目（内核注册到工具面的形状）。 */
export interface McpToolInfo {
  server: string;
  name: string;
  externalName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  riskLevel: 'L0' | 'L1' | 'L2' | 'L3';
  openWorld: boolean;
}

/** E3：单个 MCP Server 运行态。 */
export interface McpServerStatus {
  key: string;
  name: string;
  transport: string;
  state: 'connected' | 'idle' | 'disabled' | 'error' | string;
  toolCount: number;
  error?: string | null;
  tools: McpToolInfo[];
}

/** E3：官方 Registry 归一化条目（后端已折叠成可落盘的 stdio 启动配置）。 */
export interface RegistryServerEntry {
  key: string;
  name: string;
  fullName: string;
  description: string;
  version: string;
  command: string;
  args: string[];
  docs: string;
  requiredEnv: Array<{ name: string; hint: string; required: boolean; secret: boolean }>;
}

export const mcpApi = {
  info: (): Promise<McpInfo> => http.get<McpInfo>('/mcp/info'),
  // 项目级 MCP 配置（<Vault>/.lattice/mcp.json）
  project: (): Promise<McpProjectState> => http.get<McpProjectState>('/mcp/project'),
  saveProject: (document: McpProjectDocument, options: RequestOptions = {}): Promise<McpProjectState> => http.put<McpProjectState>('/mcp/project', document, options),
  /** 运行态查询：只报告已缓存连接，不启动子进程。 */
  statuses: (servers?: McpServerEntry[]): Promise<McpServerStatus[]> =>
    http.post<McpServerStatus[]>('/mcp/status', servers ? { servers } : {}),
  /** 测试连接：会启动子进程并读取 tools/list（首次冷启动可能较慢）。 */
  test: (server: McpServerEntry): Promise<McpServerStatus> =>
    http.post<McpServerStatus>(
      '/mcp/test',
      { server },
      { timeout: 40_000, retries: 0 },
    ),
  /** 已连接 server 的工具清单（未连接时为空数组）。 */
  tools: (server: string): Promise<McpToolInfo[]> =>
    http.get<McpToolInfo[]>('/mcp/tools', { query: { server } }),
  /** 官方 Registry 在线目录（断网/超时抛错，调用方保留静态目录兜底）。 */
  registry: (query = '', limit = 20): Promise<RegistryServerEntry[]> =>
    http.get<RegistryServerEntry[]>('/mcp/registry', {
      query: { q: query, limit: String(limit) },
      timeout: 25_000,
      retries: 0,
    }),
  /** E4：回复 MCP elicitation 表单（accept 必须携带对象 content）。 */
  replyElicitation: (
    id: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown> | null,
  ): Promise<void> =>
    http.post<void>('/mcp/elicitation', { id, action, content: content ?? null }, { retries: 0 }),
};
