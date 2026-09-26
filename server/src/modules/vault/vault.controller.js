import { config } from '../../config/index.js';
import { resolveVaultDir } from '../../vault/config.js';
import { migrateSqliteToVault } from '../../vault/migrate-sqlite.js';

export function getInfo(_req, res) {
  res.json({ data: { vaultDir: resolveVaultDir(config.vaultDir), mode: 'markdown' } });
}

export async function migrate(_req, res) {
  const result = await migrateSqliteToVault(resolveVaultDir(config.vaultDir));
  res.status(200).json({ data: result });
}
