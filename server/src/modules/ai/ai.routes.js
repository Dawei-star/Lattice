import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticateAi } from './ai.auth.js';
import * as controller from './ai.controller.js';

const role = z.enum(['viewer', 'editor', 'admin']).default('editor');
const provider = z.object({
  endpoint: z.string().url().max(500),
  apiKey: z.string().min(1).max(500),
  model: z.string().trim().max(120).optional(),
  authHeader: z.enum(['bearer', 'x-api-key']).default('bearer'),
}).nullable().optional();
const context = z.object({
  activeFile: z.string().max(2048).nullable().optional(),
  files: z.array(z.record(z.unknown())).max(120).optional(),
  folders: z.array(z.union([z.string(), z.record(z.unknown())])).max(80).optional(),
}).default({});
const action = z.object({
  id: z.string().max(100).optional(),
  type: z.enum(['read', 'create', 'update', 'delete', 'move', 'copy']),
  path: z.string().max(2048).optional(),
  sourcePath: z.string().max(2048).optional(),
  fromPath: z.string().max(2048).optional(),
  targetPath: z.string().max(2048).optional(),
  toPath: z.string().max(2048).optional(),
  destination: z.string().max(2048).optional(),
  content: z.string().max(2_000_000).optional(),
}).passthrough();

export const aiRouter = Router();

aiRouter.use(authenticateAi);

aiRouter.post('/chat', validate({ body: z.object({
  message: z.string().trim().min(1).max(8000),
  context,
  provider,
  actor: z.string().trim().max(80).default('local-user'),
  role,
}) }), controller.chat);

aiRouter.post('/operations/preview', validate({ body: z.object({
  actions: z.array(action).min(1).max(30),
  actor: z.string().trim().max(80).default('local-user'),
  role,
}) }), controller.preview);

aiRouter.post('/operations/execute', validate({ body: z.object({
  actions: z.array(action).min(1).max(30),
  actor: z.string().trim().max(80).default('local-user'),
  role,
  source: z.enum(['ai-chat', 'cli', 'api']).default('ai-chat'),
  confirmed: z.boolean().default(false),
}) }), controller.execute);

aiRouter.get('/history', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(250).default(80) }) }), controller.history);
