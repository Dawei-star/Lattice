import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './notes.controller.js';

const idParam = z.object({ id: z.string().uuid('笔记 ID 必须是合法 UUID') });

/** folderId 支持特殊值 __none__，表示「未分类」 */
const listQuery = z.object({
  folderId: z.string().max(64).nullish(),
  tagId: z.string().uuid('标签 ID 必须是合法 UUID').nullish(),
  sort: z.enum(['updated', 'created', 'title']).default('updated'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

const createBody = z.object({
  // 客户端可自带 UUID：网络抖动导致的自动重试会命中同一个 id，从而天然幂等
  id: z.string().uuid('笔记 ID 必须是合法 UUID').optional(),
  title: z.string().trim().max(200, '标题最长 200 个字符').optional(),
  content: z.string().max(2_000_000, '单篇正文最长 200 万字符').default(''),
  folderId: z.string().uuid().nullish().transform((v) => v ?? null),
});

const updateBody = z
  .object({
    title: z.string().trim().min(1, '标题不能为空').max(200).optional(),
    content: z.string().max(2_000_000).optional(),
    folderId: z.string().uuid().nullish(),
    isPinned: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少要提供一个待更新字段' });

export const notesRouter = Router();

notesRouter.get('/', validate({ query: listQuery }), controller.listNotes);
notesRouter.post('/', validate({ body: createBody }), controller.createNote);
// 必须注册在 /:id 之前，否则 "index" 会被当成 id 处理
notesRouter.get('/index', controller.getNoteIndex);
notesRouter.get('/:id', validate({ params: idParam }), controller.getNote);
notesRouter.patch('/:id', validate({ params: idParam, body: updateBody }), controller.updateNote);
notesRouter.delete('/:id', validate({ params: idParam }), controller.deleteNote);
