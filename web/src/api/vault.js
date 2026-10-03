import { http } from './client.js';

export const vaultApi = {
  info: () => http.get('/vault/info'),
  updateProfile: (profile, options = {}) => http.put('/vault/profile', profile, { retries: 0, ...options }),
  migrate: () => http.post('/vault/migrate'),
};
