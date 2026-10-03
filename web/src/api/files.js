import { http } from './client.js';

// 文件内核的写接口必须关闭自动重试，避免网络抖动把同一个确认动作提交两次。
export const filesApi = {
  preview: (input, options = {}) => http.post('/files/preview', input, { timeout: 30_000, retries: 0, ...options }),
  execute: (input, options = {}) => http.post('/files/execute', input, { timeout: 30_000, retries: 0, ...options }),
  undo: (operationId, options = {}) => http.post('/files/undo', { operationId }, { retries: 0, ...options }),
  log: (options = {}) => http.get('/files/log', options),
};
