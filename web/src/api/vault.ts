import { http, type RequestOptions } from './client.ts';

/** Vault 档案中的路径配置。 */
export interface VaultProfilePaths {
  vaultDir?: string | null;
  dbFile?: string | null;
  [key: string]: unknown;
}

/** Vault 档案（版本 + 目录路径配置）。 */
export interface VaultProfile {
  version?: number;
  paths?: VaultProfilePaths;
  [key: string]: unknown;
}

/** 档案更新载荷：paths 之外可携带确认信息（confirmed 等）。 */
export interface VaultProfileUpdate {
  version?: number;
  paths?: VaultProfilePaths;
  [key: string]: unknown;
}

/** Vault 信息（GET /vault/info）。 */
export interface VaultInfo {
  vaultDir?: string;
  profile?: VaultProfile;
  [key: string]: unknown;
}

export const vaultApi = {
  info: (): Promise<VaultInfo> => http.get<VaultInfo>('/vault/info'),
  updateProfile: (profile: VaultProfileUpdate, options: RequestOptions = {}): Promise<unknown> => http.put('/vault/profile', profile, { retries: 0, ...options }),
  // 全库 SQLite→Markdown 迁移是长耗时写端点：默认 15s 超时会让前端报错重试，
  // 而服务端仍在跑第一遍（重入风险）——放宽超时并关闭自动重试
  migrate: (confirmation: Record<string, unknown> = {}): Promise<unknown> => http.post('/vault/migrate', confirmation, { timeout: 300_000, retries: 0 }),
};
