import * as service from './ai.service.js';
import { applyAiPrincipal } from './ai.auth.js';

export async function chat(req, res) {
  res.json({ data: await service.chat(applyAiPrincipal(req, req.valid.body)) });
}

export async function preview(req, res) {
  const body = applyAiPrincipal(req, req.valid.body);
  res.json({ data: service.preview(body.actions, body) });
}

export async function execute(req, res) {
  const body = applyAiPrincipal(req, req.valid.body);
  res.json({ data: await service.execute(body.actions, body) });
}

export async function history(req, res) {
  res.json({ data: service.history(req.valid.query.limit) });
}
