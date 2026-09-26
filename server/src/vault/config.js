import path from 'node:path';
import { config } from '../config/index.js';

/** The vault is intentionally separate from the SQLite projection. */
export const defaultVaultDir = path.join(path.dirname(config.dbFile), 'vault');

export function resolveVaultDir(value = process.env.VAULT_DIR) {
  if (!value) return defaultVaultDir;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(process.cwd(), value);
}
