import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './review.controller.js';

const healthQuery = z.object({
  staleDays: z.coerce.number().int().min(7).max(3650).default(90),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const reviewRouter = Router();

reviewRouter.get('/health', validate({ query: healthQuery }), controller.getHealth);
