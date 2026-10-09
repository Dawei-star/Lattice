import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './review.controller.js';

const healthQuery = z.object({
  staleDays: z.coerce.number().int().min(7).max(3650).default(90),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const planBody = z.object({
  findingIds: z.array(z.string().trim().min(1).max(240)).min(1).max(100),
  staleDays: z.coerce.number().int().min(7).max(3650).default(90),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const executeBody = z.object({
  planId: z.string().uuid(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/i),
  confirmed: z.boolean().default(false),
  secondConfirmed: z.boolean().default(false),
});

export const reviewRouter = Router();

reviewRouter.get('/health', validate({ query: healthQuery }), controller.getHealth);
reviewRouter.post('/health/plan', validate({ body: planBody }), controller.createPlan);
reviewRouter.post('/health/execute', validate({ body: executeBody }), controller.executePlan);
