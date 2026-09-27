import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { normalizeVaultRelativePath } from '../../vault/path.js';
import * as controller from './canvas.controller.js';

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).passthrough();
const node = z.object({ id: z.string().min(1).max(100), type: z.enum(['text', 'file', 'image']), text: z.string().max(200000), x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(180).max(720).optional(), height: z.number().finite().min(110).max(560).optional(), color: z.string().max(30).optional(), noteId: z.string().max(100).optional(), path: z.string().max(1024).optional() }).passthrough().superRefine((value, ctx) => {
  if (value.type !== 'image') return;
  if (!value.path) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: '图片节点必须包含 Vault 相对路径' });
    return;
  }
  try {
    normalizeVaultRelativePath(value.path, '');
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: '图片路径必须是 Vault 内的相对路径' });
  }
});
const edge = z.object({ id: z.string().min(1).max(100), from: z.string().min(1).max(100), to: z.string().min(1).max(100) }).passthrough();
const documentBody = z.object({ nodes: z.array(node).max(10000), edges: z.array(edge).max(20000) }).passthrough();

export const canvasRouter = Router();
canvasRouter.get('/', controller.readCanvas);
canvasRouter.put('/', validate({ body: documentBody }), controller.writeCanvas);
