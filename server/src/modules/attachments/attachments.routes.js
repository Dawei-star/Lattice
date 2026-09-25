import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './attachments.controller.js';

const idParam = z.object({ id: z.string().uuid('附件 ID 必须是合法 UUID') });

// data 为 base64 字符串；15MB 原文件约 20M 字符，留出余量到 40M
const uploadBody = z.object({
  name: z.string().trim().max(255).optional(),
  mime: z.string().min(1).max(100),
  data: z.string().min(1).max(40_000_000, '附件内容过大'),
});

export const attachmentsRouter = Router();

attachmentsRouter.get('/', controller.listAttachments);
attachmentsRouter.post('/', validate({ body: uploadBody }), controller.uploadAttachment);
// /cleanup 必须注册在 /:id 之前，否则会被当成 id 处理（虽然方法是 POST 不冲突，但保持路由顺序清晰）
attachmentsRouter.post('/cleanup', controller.cleanupAttachments);
attachmentsRouter.delete('/:id', validate({ params: idParam }), controller.deleteAttachment);
