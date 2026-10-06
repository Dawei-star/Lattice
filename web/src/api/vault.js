import { http } from './client.js';

export const vaultApi = {
  info: () => http.get('/vault/info'),
  updateProfile: (profile, options = {}) => http.put('/vault/profile', profile, { retries: 0, ...options }),
  // 全库 SQLite→Markdown 迁移是长耗时写端点：默认 15s 超时会让前端报错重试，
  // 而服务端仍在跑第一遍（重入风险）——放宽超时并关闭自动重试
  migrate: () => http.post('/vault/migrate', {}, { timeout: 300_000, retries: 0 }),
};
