import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { normalizeVaultRelativePath } from '../../vault/path.js';
import * as controller from './canvas.controller.js';

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).passthrough();
// text 可选：Obsidian 的 file/group 节点没有 text 字段；宽高放开到真实画布的尺寸范围（Obsidian 节点常大于 720×560）
const node = z.object({ id: z.string().min(1).max(100), type: z.enum(['text', 'file', 'image', 'group']), text: z.string().max(200000).optional(), x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(20).max(100000).optional(), height: z.number().finite().min(20).max(100000).optional(), color: z.string().max(64).optional(), noteId: z.string().max(100).optional(), path: z.string().max(1024).optional(), file: z.string().max(1024).optional() }).passthrough().superRefine((value, ctx) => {
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
const documentBody = z.object({
  nodes: z.array(node).max(10000),
  edges: z.array(edge).max(20000),
  // 乐观锁：传 GET 返回的 revision，服务端发现画布已变则返回 409
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).passthrough();
const canvasPath = z.string().min(1).max(2048).superRefine((value, ctx) => {
  try {
    normalizeVaultRelativePath(value, '.canvas');
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '画布路径必须是 Vault 内的相对路径' });
  }
});
const canvasPathQuery = z.object({ path: canvasPath.default('画板.canvas') });
const moveBody = z.object({ fromPath: canvasPath, toPath: canvasPath });
const deleteQuery = z.object({ path: canvasPath });

export const canvasRouter = Router();
canvasRouter.get('/files', controller.listCanvasFiles);
canvasRouter.patch('/file', validate({ body: moveBody }), controller.moveCanvas);
canvasRouter.delete('/file', validate({ query: deleteQuery }), controller.deleteCanvas);
canvasRouter.get('/', validate({ query: canvasPathQuery }), controller.readCanvas);
canvasRouter.put('/', validate({ query: canvasPathQuery, body: documentBody }), controller.writeCanvas);
