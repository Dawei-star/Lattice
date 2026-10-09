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

const vaultFileQuery = z.object({
  path: z.string().min(1).max(1024).refine((value) => {
    try {
      normalizeVaultRelativePath(value, '');
      return true;
    } catch {
      return false;
    }
  }, '文件路径必须是 Vault 内的相对路径'),
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

const deleteAttachmentQuery = attachmentPathQuery.extend({
  confirmed: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  secondConfirmed: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

const uploadQuery = z.object({
  name: z.string().trim().min(1).max(255),
  // 可选：attachments/ 下的子目录（按当前笔记归组），逐段在服务端清洗
  folder: z.string().trim().max(400).optional(),
  confirmed: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  secondConfirmed: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

const validateReferencesBody = z.object({
  content: z.string().max(2_000_000),
  filePath: z.string().max(1024).default(''),
});

const cleanupBody = z.object({
  dryRun: z.boolean().default(true),
  confirmed: z.boolean().default(false),
  secondConfirmed: z.boolean().default(false),
}).default({});

const profileBody = z.object({
  version: z.literal(1).optional(),
  paths: z.object({
    inbox: z.string().trim().min(1).max(240),
    daily: z.string().trim().min(1).max(240),
    journal: z.string().trim().min(1).max(240),
  }).strict(),
  confirmed: z.boolean().default(false),
  secondConfirmed: z.boolean().default(false),
}).strict();

const confirmationBody = z.object({ confirmed: z.boolean().default(false), secondConfirmed: z.boolean().default(false) }).default({});

const rawAttachmentBody = express.raw({ type: '*/*', limit: '25mb' });

vaultRouter.get('/info', controller.getInfo);
vaultRouter.put('/profile', validate({ body: profileBody }), controller.updateProfile);
// GET /events 已迁至 vault.events.routes.js：EventSource 无法带请求头，
// 事件流的「令牌或一次性票据」校验需要注册在全局鉴权链之前
vaultRouter.get('/attachments', controller.listAttachments);
vaultRouter.get('/files', controller.listVaultFiles);
vaultRouter.get('/download', validate({ query: vaultFileQuery }), controller.downloadFile);
vaultRouter.post('/attachments', rawAttachmentBody, validate({ query: uploadQuery }), controller.uploadAttachment);
vaultRouter.get('/attachments/references', validate({ query: attachmentPathQuery }), controller.attachmentReferences);
vaultRouter.post('/attachments/validate', validate({ body: validateReferencesBody }), controller.validateAttachmentReferences);
vaultRouter.post('/attachments/cleanup', validate({ body: cleanupBody }), controller.cleanupAttachments);
vaultRouter.delete('/attachments', validate({ query: deleteAttachmentQuery }), controller.deleteAttachment);
vaultRouter.get('/attachment', validate({ query: attachmentPathQuery }), controller.readAttachment);
vaultRouter.get('/assets', controller.listAssets);
vaultRouter.get('/asset', validate({ query: assetQuery }), controller.readAsset);
vaultRouter.post('/migrate', validate({ body: confirmationBody }), controller.migrate);
