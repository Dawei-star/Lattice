import { http } from './client.js';

export const reviewApi = {
  health: ({ staleDays = 90, limit = 100 } = {}, options = {}) => http.get('/review/health', {
    query: { staleDays, limit },
    ...options,
  }),
  createPlan: (findingIds, options = {}) => http.post('/review/health/plan', {
    findingIds,
    staleDays: options.staleDays ?? 90,
    limit: options.limit ?? 100,
  }, options),
  executePlan: (planId, planHash, confirmation, options = {}) => http.post('/review/health/execute', {
    planId,
    planHash,
    ...confirmation,
  }, options),
};
