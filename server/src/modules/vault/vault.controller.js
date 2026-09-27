import { config } from '../../config/index.js';
import { resolveVaultDir } from '../../vault/config.js';
import { migrateSqliteToVault } from '../../vault/migrate-sqlite.js';
import * as service from './vault.service.js';

export function getInfo(_req, res) {
  res.json({ data: { vaultDir: resolveVaultDir(config.vaultDir), mode: 'markdown' } });
}

export async function listAssets(_req, res) {
  res.json({ data: await service.listAssets() });
}

export async function readAsset(req, res) {
  const asset = await service.readAsset(req.valid.query.path);
  if (!asset) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '图片不存在或格式不受支持', requestId: req.id ?? 'unknown' } });
    return;
  }
  res.type(asset.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.sendFile(asset.absolutePath);
}

export async function migrate(_req, res) {
  const result = await migrateSqliteToVault(resolveVaultDir(config.vaultDir));
  res.status(200).json({ data: result });
}
