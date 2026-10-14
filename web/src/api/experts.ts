import { http, type RequestOptions } from './client.ts';

/** 专家（GET /experts）。 */
export interface Expert {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/** 专家技能（GET /experts/skills）。 */
export interface Skill {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/** 专家路由请求载荷。 */
export interface ExpertRouteInput {
  message: string;
  excludeId?: string | null;
  [key: string]: unknown;
}

export const expertsApi = {
  list: (options: RequestOptions = {}): Promise<Expert[]> => http.get<Expert[]>('/experts', options),
  route: (input: ExpertRouteInput, options: RequestOptions = {}): Promise<Expert> => http.post<Expert>('/experts/route', input, { retries: 0, ...options }),
  get: (id: string, options: RequestOptions = {}): Promise<Expert> => http.get<Expert>(`/experts/${encodeURIComponent(id)}`, options),
  create: (input: Record<string, unknown>, options: RequestOptions = {}): Promise<Expert> => http.post<Expert>('/experts', input, { retries: 0, ...options }),
  update: (id: string, input: Record<string, unknown>, options: RequestOptions = {}): Promise<Expert> => http.put<Expert>(`/experts/${encodeURIComponent(id)}`, input, { retries: 0, ...options }),
  remove: (id: string, options: RequestOptions = {}): Promise<unknown> => http.delete(`/experts/${encodeURIComponent(id)}`, { retries: 0, ...options }),
  listSkills: (options: RequestOptions = {}): Promise<Skill[]> => http.get<Skill[]>('/experts/skills', options),
  getSkill: (id: string, options: RequestOptions = {}): Promise<Skill> => http.get<Skill>(`/experts/skills/${encodeURIComponent(id)}`, options),
  createSkill: (input: Record<string, unknown>, options: RequestOptions = {}): Promise<Skill> => http.post<Skill>('/experts/skills', input, { retries: 0, ...options }),
  updateSkill: (id: string, input: Record<string, unknown>, options: RequestOptions = {}): Promise<Skill> => http.put<Skill>(`/experts/skills/${encodeURIComponent(id)}`, input, { retries: 0, ...options }),
  removeSkill: (id: string, options: RequestOptions = {}): Promise<unknown> => http.delete(`/experts/skills/${encodeURIComponent(id)}`, { retries: 0, ...options }),
};
