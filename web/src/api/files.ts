import { http, type RequestOptions } from './client.ts';

// 文件内核的写接口必须关闭自动重试，避免网络抖动把同一个确认动作提交两次。
export const filesApi = {
  read: (path: string, offset = 0, limit?: number, options: RequestOptions = {}): Promise<unknown> =>
    http.get('/files/read', { query: { path, offset, limit }, ...options }),
  find: (query: { pattern?: string; dir?: string; fileType?: string } = {}, options: RequestOptions = {}): Promise<unknown> =>
    http.get('/files/find', { query, ...options }),
  grep: (query: { query: string; dir?: string; regex?: boolean; fileType?: string }, options: RequestOptions = {}): Promise<unknown> =>
    http.get('/files/grep', { query, ...options }),
  preview: (input: unknown, options: RequestOptions = {}): Promise<unknown> => http.post('/files/preview', input, { timeout: 30_000, retries: 0, ...options }),
  execute: (input: unknown, options: RequestOptions = {}): Promise<unknown> => http.post('/files/execute', input, { timeout: 30_000, retries: 0, ...options }),
  undo: (operationId: string, options: RequestOptions = {}): Promise<unknown> => http.post('/files/undo', { operationId }, { retries: 0, ...options }),
  log: (options: RequestOptions = {}): Promise<unknown[]> => http.get<unknown[]>('/files/log', options),
};
