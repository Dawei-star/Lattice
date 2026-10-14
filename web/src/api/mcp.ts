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
  servers?: McpServerEntry[];
  warning?: string;
  [key: string]: unknown;
}

/** MCP 服务信息（GET /mcp/info）。 */
export interface McpInfo {
  [key: string]: unknown;
}

export const mcpApi = {
  info: (): Promise<McpInfo> => http.get<McpInfo>('/mcp/info'),
  // 项目级 MCP 配置（<Vault>/.lattice/mcp.json）
  project: (): Promise<McpProjectState> => http.get<McpProjectState>('/mcp/project'),
  saveProject: (document: McpProjectDocument, options: RequestOptions = {}): Promise<McpProjectState> => http.put<McpProjectState>('/mcp/project', document, options),
};
