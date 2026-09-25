import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './tags.controller.js';

const idParam = z.object({ id: z.string().uuid('标签 ID 必须是合法 UUID') });

export const tagsRouter = Router();

tagsRouter.get('/', controller.listTags);
tagsRouter.delete('/:id', validate({ params: idParam }), controller.deleteTag);
