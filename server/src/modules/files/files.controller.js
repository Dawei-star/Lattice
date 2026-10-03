import { ValidationError } from '../../lib/errors.js';
import { createOperationPlan } from '../../../../scripts/operation-plan.mjs';
import * as service from './files.service.js';

const WRITE_TYPES = new Set(['create', 'write', 'append', 'edit', 'copy', 'move', 'delete', 'mkdir']);

export function read(req, res) {
  res.json({ data: service.read(req.valid.query) });
}

export function find(req, res) {
  res.json({ data: service.find(req.valid.query) });
}

export function grep(req, res) {
  res.json({ data: service.grep(req.valid.query) });
}

export function preview(req, res) {
  const principal = getPrincipal(req);
  const action = actionFromBody(req.valid.body);
  const data = service.preview(action);
  res.json({
    data: {
      ...data,
      plan: createOperationPlan([action], { actor: principal.actor, role: principal.role, source: 'files-api' }),
      actor: principal.actor,
      role: principal.role,
      blocked: principal.role === 'viewer' && WRITE_TYPES.has(action.type),
    },
  });
}

export function execute(req, res) {
  const principal = assertCanWrite(req);
  if (req.valid.body.confirmed !== true) throw new ValidationError('File changes require explicit confirmation');
  if (!req.valid.body.planHash) throw new ValidationError('File changes require a preview plan');
  const result = service.execute(actionFromBody(req.valid.body), {
    actor: principal.actor,
    role: principal.role,
    source: 'files-api',
    planId: req.valid.body.planId,
    planHash: req.valid.body.planHash,
  });
  res.json({ data: result });
}

export function undo(req, res) {
  const principal = assertCanWrite(req);
  const { operationId, force } = req.valid.body;
  const result = service.undo(operationId ?? null, { force, actor: principal.actor, role: principal.role, source: 'files-api' });
  res.json({ data: result });
}

export function log(req, res) {
  res.json({ data: service.log(req.valid.query.limit) });
}

function actionFromBody(body) {
  const { type, path, targetPath, content, replace, with: replacement, all } = body;
  return { type, path, targetPath, content, replace, with: replacement, all };
}

function getPrincipal(req) {
  return req.workspacePrincipal ?? { actor: 'local-user', role: 'editor' };
}

function assertCanWrite(req) {
  const principal = getPrincipal(req);
  if (principal.role === 'viewer') throw new ValidationError('当前角色只有读取权限，不能执行文件修改');
  return principal;
}
