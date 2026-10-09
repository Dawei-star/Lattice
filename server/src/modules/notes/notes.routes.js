import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './notes.controller.js';

const idParam = z.object({ id: z.string().uuid('笔记 ID 必须是合法 UUID') });

const confirmationFields = {
  confirmed: z.boolean().default(false),
  secondConfirmed: z.boolean().default(false),
  planHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
};

const duplicateBody = z.object({
  folderId: z.string().uuid('目标目录 ID 必须是合法 UUID').nullish().transform((v) => v ?? undefined),
  ...confirmationFields,
}).default({});

/** folderId 支持特殊值 __none__，表示「未分类」 */
const listQuery = z.object({
  folderId: z.string().max(64).nullish(),
  inboxStatus: z.enum(['all', 'captured', 'processing', 'processed']).optional(),
  tagId: z.string().uuid('标签 ID 必须是合法 UUID').nullish(),
  sort: z.enum(['updated', 'created', 'title']).default('updated'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

const propertyValue = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(50),
]);

const propertiesBody = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,80}$/, '属性名只能包含字母、数字、下划线和短横线'),
  propertyValue,
).refine((value) => Object.keys(value).length <= 50, '单篇笔记最多支持 50 个属性');

const createBody = z.object({
  // 客户端可自带 UUID：网络抖动导致的自动重试会命中同一个 id，从而天然幂等
  id: z.string().uuid('笔记 ID 必须是合法 UUID').optional(),
  title: z.string().trim().max(200, '标题最长 200 个字符').optional(),
  content: z.string().max(2_000_000, '单篇正文最长 200 万字符').default(''),
  folderId: z.string().uuid().nullish().transform((v) => v ?? null),
  properties: propertiesBody.default({}),
  ...confirmationFields,
});

const updateBody = z
  .object({
    title: z.string().trim().min(1, '标题不能为空').max(200).optional(),
    content: z.string().max(2_000_000).optional(),
    folderId: z.string().uuid().nullish(),
    isPinned: z.boolean().optional(),
    properties: propertiesBody.optional(),
    // 乐观锁：携带读取时返回的 contentHash，不匹配返回 409
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/i, '版本哈希无效').optional(),
    ...confirmationFields,
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少要提供一个待更新字段' });

const versionParam = z.object({
  id: z.string().uuid(),
  version: z.string().regex(/^\d{8}T\d{9}Z-[a-f0-9]{64}$/i, '历史版本标识无效'),
});

const restoreBody = z.object({
  expectedCurrentHash: z.string().regex(/^[a-f0-9]{64}$/i, '当前版本哈希无效').optional(),
  ...confirmationFields,
}).default({});

const templateBody = z.object({
  template: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须使用 YYYY-MM-DD 格式').optional(),
  folderId: z.string().uuid().nullish().transform((v) => v ?? null),
  ...confirmationFields,
});

const dailyBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须使用 YYYY-MM-DD 格式').optional(),
  ...confirmationFields,
}).default({});

const deleteBody = z.object(confirmationFields).default({});

export const notesRouter = Router();

notesRouter.get('/', validate({ query: listQuery }), controller.listNotes);
notesRouter.post('/', validate({ body: createBody }), controller.createNote);
notesRouter.get('/templates', controller.listTemplates);
notesRouter.post('/from-template', validate({ body: templateBody }), controller.createFromTemplate);
notesRouter.post('/daily', validate({ body: dailyBody }), controller.createDailyNote);
// 必须注册在 /:id 之前，否则 "index" 会被当成 id 处理
notesRouter.get('/index', controller.getNoteIndex);
notesRouter.post('/:id/duplicate', validate({ params: idParam, body: duplicateBody }), controller.duplicateNote);
notesRouter.get('/:id/history', validate({ params: idParam }), controller.listHistory);
notesRouter.get('/:id/history/:version', validate({ params: versionParam }), controller.getHistoryVersion);
notesRouter.post('/:id/history/:version/restore', validate({ params: versionParam, body: restoreBody }), controller.restoreHistory);
notesRouter.get('/:id', validate({ params: idParam }), controller.getNote);
notesRouter.patch('/:id', validate({ params: idParam, body: updateBody }), controller.updateNote);
notesRouter.delete('/:id', validate({ params: idParam, body: deleteBody }), controller.deleteNote);
