import express, { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { normalizeVaultRelativePath } from '../../vault/path.js';
import * as controller from './vault.controller.js';

export const vaultRouter = Router();

const assetQuery = z.object({
  path: z.string().min(1).max(1024).refine((value) => {
    try {
      normalizeVaultRelativePath(value, '');
      return true;
    } catch {
      return false;
    }
  }, '图片路径必须是 Vault 内的相对路径'),
});

const attachmentPathQuery = z.object({
  path: z.string().min(1).max(1024).refine((value) => {
    try {
      normalizeVaultRelativePath(value, '');
      return value.replaceAll('\\', '/').startsWith('attachments/');
    } catch {
      return false;
    }
  }, '附件路径必须位于 Vault 的 attachments 目录'),
});

const uploadQuery = z.object({
  name: z.string().trim().min(1).max(255),
  // 可选：attachments/ 下的子目录（按当前笔记归组），逐段在服务端清洗
  folder: z.string().trim().max(400).optional(),
});

const validateReferencesBody = z.object({
  content: z.string().max(2_000_000),
  filePath: z.string().max(1024).default(''),
});

const cleanupBody = z.object({
  dryRun: z.boolean().default(true),
}).default({});

const profileBody = z.object({
  version: z.literal(1).optional(),
  paths: z.object({
    inbox: z.string().trim().min(1).max(240),
    daily: z.string().trim().min(1).max(240),
    journal: z.string().trim().min(1).max(240),
  }).strict(),
}).strict();

const rawAttachmentBody = express.raw({ type: '*/*', limit: '25mb' });

vaultRouter.get('/info', controller.getInfo);
vaultRouter.put('/profile', validate({ body: profileBody }), controller.updateProfile);
// GET /events 已迁至 vault.events.routes.js：EventSource 无法带请求头，
// 事件流的「令牌或一次性票据」校验需要注册在全局鉴权链之前
vaultRouter.get('/attachments', controller.listAttachments);
vaultRouter.get('/files', controller.listVaultFiles);
vaultRouter.post('/attachments', rawAttachmentBody, validate({ query: uploadQuery }), controller.uploadAttachment);
vaultRouter.get('/attachments/references', validate({ query: attachmentPathQuery }), controller.attachmentReferences);
vaultRouter.post('/attachments/validate', validate({ body: validateReferencesBody }), controller.validateAttachmentReferences);
vaultRouter.post('/attachments/cleanup', validate({ body: cleanupBody }), controller.cleanupAttachments);
vaultRouter.delete('/attachments', validate({ query: attachmentPathQuery }), controller.deleteAttachment);
vaultRouter.get('/attachment', validate({ query: attachmentPathQuery }), controller.readAttachment);
vaultRouter.get('/assets', controller.listAssets);
vaultRouter.get('/asset', validate({ query: assetQuery }), controller.readAsset);
vaultRouter.post('/migrate', controller.migrate);
