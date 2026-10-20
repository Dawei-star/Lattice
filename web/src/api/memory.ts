import { http, type RequestOptions } from './client.ts';

export interface MemoryRecord {
  id: string;
  kind: 'preference' | 'knowledge' | string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  expired?: boolean;
}

export interface MemoryInput {
  id?: string;
  kind: 'preference' | 'knowledge';
  content: string;
  source: string;
  expiresAt?: string | null;
  confirmed?: boolean;
}

export const memoryApi = {
  list: (includeExpired = false, options: RequestOptions = {}): Promise<MemoryRecord[]> =>
    http.get<MemoryRecord[]>('/ai/memories', { ...options, query: { ...(options.query ?? {}), includeExpired } }),
  create: (input: MemoryInput, options: RequestOptions = {}): Promise<MemoryRecord> =>
    http.post<MemoryRecord>('/ai/memories', input, options),
  update: (id: string, input: MemoryInput, options: RequestOptions = {}): Promise<MemoryRecord> =>
    http.put<MemoryRecord>(`/ai/memories/${encodeURIComponent(id)}`, { ...input, id }, options),
  delete: (id: string, confirmed = false, options: RequestOptions = {}): Promise<{ id: string; deleted: boolean }> =>
    http.delete<{ id: string; deleted: boolean }>(`/ai/memories/${encodeURIComponent(id)}`, { ...options, body: { confirmed } }),
};
