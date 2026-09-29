import { http } from './client.js';

export const mcpApi = {
  info: () => http.get('/mcp/info'),
};
