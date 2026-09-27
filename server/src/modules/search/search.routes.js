import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './search.controller.js';

const searchQuery = z.object({
  q: z.string().trim().min(1, '检索词不能为空').max(200, '检索词最长 200 个字符'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  folderId: z.string().max(64).nullish(),
});

export const searchRouter = Router();

searchRouter.get('/', validate({ query: searchQuery }), controller.searchNotes);
