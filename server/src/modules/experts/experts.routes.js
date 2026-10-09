import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { forbidViewerWrite } from '../../middleware/roleGuard.js';
import * as controller from './experts.controller.js';

const id = z.string().trim().regex(/^[a-z0-9][a-z0-9-_]{1,79}$/);
const skillBinding = z.object({
  id,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  config: z.record(z.unknown()).default({}),
});
const confirmationFields = {
  confirmed: z.boolean().default(false),
  secondConfirmed: z.boolean().default(false),
};
const expertBody = z.object({
  id: id.optional(),
  version: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  icon: z.string().trim().max(40).default('sparkles'),
  enabled: z.boolean().default(true),
  systemPrompt: z.string().max(12000).default(''),
  scope: z.object({ include: z.array(z.string().max(100)).max(40).default([]), exclude: z.array(z.string().max(100)).max(40).default([]) }).default({}),
  skills: z.array(skillBinding).max(40).default([]),
  capabilities: z.object({
    context: z.array(z.string().max(50)).max(20).default(['current-note', 'project', 'vault']),
    tools: z.array(z.string().max(100)).max(60).default(['read', 'search']),
    writePolicy: z.enum(['disabled', 'confirm', 'auto']).default('confirm'),
    maxRounds: z.number().int().min(1).max(12).default(6),
  }).default({}),
  routing: z.object({
    keywords: z.array(z.string().max(100)).max(40).default([]),
    priority: z.number().int().min(0).max(100).default(50),
    confidenceThreshold: z.number().min(0).max(1).default(0.72),
  }).default({}),
  ...confirmationFields,
}).strict();
const skillBody = z.object({
  id: id.optional(),
  version: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  triggers: z.array(z.string().max(100)).max(30).default([]),
  tools: z.array(z.string().max(100)).max(40).default([]),
  permissions: z.array(z.string().max(50)).max(20).default(['read']),
  inputSchema: z.record(z.unknown()).default({ type: 'object' }),
  outputSchema: z.record(z.unknown()).default({ type: 'object' }),
  enabled: z.boolean().default(true),
  content: z.string().trim().min(1).max(30000),
  ...confirmationFields,
}).strict();

export const expertsRouter = Router();

expertsRouter.get('/', controller.list);
expertsRouter.post('/route', validate({ body: z.object({
  message: z.string().trim().min(1).max(2000),
  excludeId: id.optional(),
}) }), controller.route);
expertsRouter.get('/skills', controller.listSkills);
expertsRouter.get('/skills/:id', validate({ params: z.object({ id }) }), controller.skillDetail);
expertsRouter.post('/skills', forbidViewerWrite, validate({ body: skillBody }), controller.createSkill);
expertsRouter.put('/skills/:id', forbidViewerWrite, validate({ params: z.object({ id }), body: skillBody.omit({ id: true }) }), controller.updateSkill);
expertsRouter.delete('/skills/:id', forbidViewerWrite, validate({ params: z.object({ id }), body: z.object(confirmationFields).default({}) }), controller.removeSkill);
expertsRouter.get('/:id', validate({ params: z.object({ id }) }), controller.detail);
expertsRouter.post('/', forbidViewerWrite, validate({ body: expertBody }), controller.create);
expertsRouter.put('/:id', forbidViewerWrite, validate({ params: z.object({ id }), body: expertBody.omit({ id: true }) }), controller.update);
expertsRouter.delete('/:id', forbidViewerWrite, validate({ params: z.object({ id }), body: z.object(confirmationFields).default({}) }), controller.remove);

export { expertBody, skillBody };
