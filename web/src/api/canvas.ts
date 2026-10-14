import { http, type RequestOptions } from './client.ts';

/** 画板文件条目（GET /canvas/files）。 */
export interface CanvasFileSummary {
  path: string;
  name?: string;
  folderPath?: string;
  exists?: boolean;
  [key: string]: unknown;
}

/** 画板文档（nodes/edges 图形数据）。 */
export interface CanvasDocument {
  nodes?: unknown[];
  edges?: unknown[];
  version?: number;
  [key: string]: unknown;
}

export const canvasApi = {
  list: (): Promise<CanvasFileSummary[]> => http.get<CanvasFileSummary[]>('/canvas/files'),
  get: (path: string = '画板.canvas'): Promise<CanvasDocument> => http.get<CanvasDocument>('/canvas', { query: { path } }),
  save: (path: string, document: CanvasDocument): Promise<unknown> => http.put('/canvas', document, { query: { path } }),
  move: (fromPath: string, toPath: string, confirmation: Record<string, unknown> = {}): Promise<unknown> => http.patch('/canvas/file', { fromPath, toPath, ...confirmation }),
  rename: (fromPath: string, toPath: string, confirmation: Record<string, unknown> = {}): Promise<unknown> => http.patch('/canvas/file', { fromPath, toPath, ...confirmation }),
  remove: (path: string, confirmation: Record<string, unknown> = {}): Promise<unknown> => http.delete('/canvas/file', { query: { path }, body: confirmation }),
};
