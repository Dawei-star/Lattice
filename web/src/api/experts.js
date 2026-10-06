import { http } from './client.js';

export const expertsApi = {
  list: (options = {}) => http.get('/experts', options),
  route: (input, options = {}) => http.post('/experts/route', input, { retries: 0, ...options }),
  get: (id, options = {}) => http.get(`/experts/${encodeURIComponent(id)}`, options),
  create: (input, options = {}) => http.post('/experts', input, { retries: 0, ...options }),
  update: (id, input, options = {}) => http.put(`/experts/${encodeURIComponent(id)}`, input, { retries: 0, ...options }),
  remove: (id, options = {}) => http.delete(`/experts/${encodeURIComponent(id)}`, { retries: 0, ...options }),
  listSkills: (options = {}) => http.get('/experts/skills', options),
  getSkill: (id, options = {}) => http.get(`/experts/skills/${encodeURIComponent(id)}`, options),
  createSkill: (input, options = {}) => http.post('/experts/skills', input, { retries: 0, ...options }),
  updateSkill: (id, input, options = {}) => http.put(`/experts/skills/${encodeURIComponent(id)}`, input, { retries: 0, ...options }),
  removeSkill: (id, options = {}) => http.delete(`/experts/skills/${encodeURIComponent(id)}`, { retries: 0, ...options }),
};
