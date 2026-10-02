import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as controller from './files.controller.js';

const relativePath = z.string().trim().min(1).max(2048);
const fileType = z.string().trim().min(1).max(20).optional();
const regexFlag = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');
const mutationType = z.enum(['create', 'write', 'append', 'edit', 'copy', 'move', 'delete', 'mkdir']);
const mutationBody = z.object({
  type: mutationType,
  path: relativePath,
  targetPath: relativePath.optional(),
  content: z.string().max(2_000_000).optional(),
  replace: z.string().max(200_000).optional(),
  with: z.string().max(200_000).optional(),
  all: z.boolean().default(false),
  confirmed: z.boolean().default(false),
}).passthrough();

export const filesRouter = Router();

filesRouter.get('/read', validate({ query: z.object({
  path: relativePath,
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(2_097_152).default(2_097_152),
}) }), controller.read);

filesRouter.get('/find', validate({ query: z.object({
  pattern: z.string().trim().min(1).max(1024).default('**/*'),
  dir: z.string().trim().max(2048).default(''),
  type: fileType,
}) }), controller.find);

filesRouter.get('/grep', validate({ query: z.object({
  query: z.string().min(1).max(2000),
  dir: z.string().trim().max(2048).default(''),
  regex: regexFlag,
  type: fileType,
}) }), controller.grep);

filesRouter.post('/preview', validate({ body: mutationBody }), controller.preview);
filesRouter.post('/execute', validate({ body: mutationBody }), controller.execute);
filesRouter.post('/undo', validate({ body: z.object({
  operationId: z.string().trim().max(100).optional(),
  force: z.boolean().default(false),
}) }), controller.undo);
filesRouter.get('/log', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(40) }) }), controller.log);
