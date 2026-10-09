import { config } from '../../config/index.js';
import { ValidationError } from '../../lib/errors.js';
import { resolveVaultDir } from '../../vault/config.js';
import { subscribeVaultEvents } from '../../vault/events.js';
import { migrateSqliteToVault } from '../../vault/migrate-sqlite.js';
import { loadVaultProfile, saveVaultProfile } from '../../vault/profile.js';
import * as service from './vault.service.js';
import * as attachments from './vault.attachments.js';
import { requireFileConfirmation } from '../../lib/file-confirmation.js';

export function getInfo(_req, res) {
  const loaded = loadVaultProfile(config.vaultDir);
  res.json({ data: profileInfo(loaded) });
}

export function updateProfile(req, res) {
  requireFileConfirmation(req);
  const principal = req.workspacePrincipal ?? { role: 'editor' };
  if (principal.role === 'viewer') throw new ValidationError('当前角色只有读取权限，不能修改 Vault profile');
  const { confirmed: _confirmed, secondConfirmed: _secondConfirmed, ...profile } = req.valid.body;
  const loaded = saveVaultProfile(config.vaultDir, profile);
  res.json({ data: profileInfo(loaded) });
}

export function streamEvents(_req, res) {
  subscribeVaultEvents(res);
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
  applyAssetSecurityHeaders(res);
  res.sendFile(asset.absolutePath);
}

export async function migrate(req, res) {
  requireFileConfirmation(req);
  const result = await migrateSqliteToVault(resolveVaultDir(config.vaultDir));
  res.status(200).json({ data: result });
}

export function listAttachments(_req, res) {
  res.json({ data: attachments.listAttachments() });
}

export function listVaultFiles(_req, res) {
  res.json({ data: attachments.listVaultFiles() });
}

export function uploadAttachment(req, res) {
  requireFileConfirmation(req);
  const result = attachments.uploadAttachment({
    name: req.valid.query.name,
    mimeType: req.get('content-type'),
    body: req.body,
    folder: req.valid.query.folder ?? '',
  });
  res.status(201).json({ data: result });
}

export function readAttachment(req, res) {
  const asset = attachments.readAttachment(req.valid.query.path);
  if (!asset) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '附件不存在', requestId: req.id ?? 'unknown' } });
    return;
  }
  res.type(asset.mimeType);
  // SVG 等可携带脚本的格式强制下载，防止存储型 XSS 在应用同源下执行
  const disposition = asset.mimeType === 'image/svg+xml' ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=60');
  applyAssetSecurityHeaders(res);
  res.sendFile(asset.absolutePath);
}

export function downloadFile(req, res) {
  const asset = attachments.readVaultFile(req.valid.query.path);
  if (!asset) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '文件不存在', requestId: req.id ?? 'unknown' } });
    return;
  }
  res.type(asset.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
  res.setHeader('Content-Length', String(asset.size));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(asset.absolutePath);
}

/**
 * 静态资产响应的沙箱头：CSP 只加在 SPA 路由上，资产端点若不带同样约束，
 * SVG/HTML 类附件可在应用同源下执行脚本、调用全部 API。
 */
function applyAssetSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function attachmentReferences(req, res) {
  res.json({ data: attachments.getAttachmentReferences(req.valid.query.path) });
}

export function validateAttachmentReferences(req, res) {
  res.json({ data: attachments.validateReferences(req.valid.body) });
}

export function deleteAttachment(req, res) {
  requireFileConfirmation(req, { destructive: true });
  res.json({ data: attachments.deleteAttachment(req.valid.query.path) });
}

export function cleanupAttachments(req, res) {
  if (!req.valid.body.dryRun) requireFileConfirmation(req, { destructive: true });
  res.json({ data: attachments.cleanupOrphans(req.valid.body) });
}

function profileInfo(loaded) {
  return {
    vaultDir: resolveVaultDir(config.vaultDir),
    mode: 'markdown',
    profile: loaded.profile,
    profilePath: loaded.filePath,
    profileStatus: loaded.status,
    profileWarning: loaded.warning,
  };
}
