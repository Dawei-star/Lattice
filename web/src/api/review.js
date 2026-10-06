import { http } from './client.js';

export const reviewApi = {
  health: ({ staleDays = 90, limit = 100 } = {}, options = {}) => http.get('/review/health', {
    query: { staleDays, limit },
    ...options,
  }),
};
