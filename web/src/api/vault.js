import { http } from './client.js';

export const vaultApi = {
  info: () => http.get('/vault/info'),
  migrate: () => http.post('/vault/migrate'),
};
