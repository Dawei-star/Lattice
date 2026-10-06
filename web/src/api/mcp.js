import { http } from './client.js';

export const mcpApi = {
  info: () => http.get('/mcp/info'),
  // 项目级 MCP 配置（<Vault>/.lattice/mcp.json）
  project: () => http.get('/mcp/project'),
  saveProject: (document, options = {}) => http.put('/mcp/project', document, options),
};
