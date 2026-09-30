import { config } from '../../config/index.js';
import { resolveVaultDir } from '../../vault/config.js';
import { subscribeVaultEvents } from '../../vault/events.js';
import { migrateSqliteToVault } from '../../vault/migrate-sqlite.js';
import * as service from './vault.service.js';
import * as attachments from './vault.attachments.js';

export function getInfo(_req, res) {
  res.json({ data: { vaultDir: resolveVaultDir(config.vaultDir), mode: 'markdown' } });
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

export async function migrate(_req, res) {
  const result = await migrateSqliteToVault(resolveVaultDir(config.vaultDir));
  res.status(200).json({ data: result });
}

export function listAttachments(_req, res) {
  res.json({ data: attachments.listAttachments() });
}

export function uploadAttachment(req, res) {
  const result = attachments.uploadAttachment({
    name: req.valid.query.name,
    mimeType: req.get('content-type'),
    body: req.body,
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
  res.json({ data: attachments.deleteAttachment(req.valid.query.path) });
}

export function cleanupAttachments(req, res) {
  res.json({ data: attachments.cleanupOrphans(req.valid.body) });
}
