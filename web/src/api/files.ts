import { http, type RequestOptions } from './client.ts';

// 文件内核的写接口必须关闭自动重试，避免网络抖动把同一个确认动作提交两次。
export const filesApi = {
  preview: (input: unknown, options: RequestOptions = {}): Promise<unknown> => http.post('/files/preview', input, { timeout: 30_000, retries: 0, ...options }),
  execute: (input: unknown, options: RequestOptions = {}): Promise<unknown> => http.post('/files/execute', input, { timeout: 30_000, retries: 0, ...options }),
  undo: (operationId: string, options: RequestOptions = {}): Promise<unknown> => http.post('/files/undo', { operationId }, { retries: 0, ...options }),
  log: (options: RequestOptions = {}): Promise<unknown[]> => http.get<unknown[]>('/files/log', options),
};
