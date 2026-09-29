import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './jobs.controller.js';

export const jobsRouter = Router();

jobsRouter.get('/', validate({ query: z.object({
  type: z.string().trim().max(80).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}) }), controller.list);

jobsRouter.get('/:id', validate({ params: z.object({ id: z.string().trim().min(1).max(120) }) }), controller.detail);
jobsRouter.post('/:id/cancel', validate({ params: z.object({ id: z.string().trim().min(1).max(120) }) }), controller.cancel);
