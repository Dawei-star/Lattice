import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './folders.controller.js';

const idParam = z.object({ id: z.string().uuid('目录 ID 必须是合法 UUID') });
const confirmationFields = {
  confirmed: z.boolean().default(false),
  secondConfirmed: z.boolean().default(false),
};
const confirmationBody = z.object(confirmationFields).default({});

const createBody = z.object({
  name: z.string().trim().min(1, '目录名不能为空').max(120, '目录名最长 120 个字符'),
  parentId: z.string().uuid('父目录 ID 必须是合法 UUID').nullish().transform((v) => v ?? null),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  ...confirmationFields,
});

const updateBody = z
  .object({
    name: z.string().trim().min(1, '目录名不能为空').max(120).optional(),
    parentId: z.string().uuid().nullish(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    ...confirmationFields,
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少要提供一个待更新字段' });

export const foldersRouter = Router();

foldersRouter.get('/', controller.listFolders);
foldersRouter.post('/', validate({ body: createBody }), controller.createFolder);
foldersRouter.patch('/:id', validate({ params: idParam, body: updateBody }), controller.updateFolder);
foldersRouter.delete('/:id', validate({ params: idParam, body: confirmationBody }), controller.deleteFolder);
