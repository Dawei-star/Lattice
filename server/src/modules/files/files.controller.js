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
  const actions = Array.isArray(req.valid.body.actions)
    ? req.valid.body.actions.map(actionFromBody)
    : null;
  const previewInput = actions ? { actions } : action;
  const data = service.preview(previewInput);
  res.json({
    data: {
      ...data,
      plan: createOperationPlan(actions ?? [action], { actor: principal.actor, role: principal.role, source: 'files-api' }),
      actor: principal.actor,
      role: principal.role,
      blocked: principal.role === 'viewer' && (actions ?? [action]).some((item) => WRITE_TYPES.has(item.type)),
      confirmation: confirmationRequirements(data, actions ?? [action]),
    },
  });
}

export function execute(req, res) {
  const principal = assertCanWrite(req);
  if (req.valid.body.confirmed !== true) throw new ValidationError('File changes require explicit confirmation');
  if (!req.valid.body.planHash) throw new ValidationError('File changes require a preview plan');
  const actions = Array.isArray(req.valid.body.actions)
    ? req.valid.body.actions.map(actionFromBody)
    : null;
  if ((actions ?? [req.valid.body]).some((item) => item.type === 'delete') && req.valid.body.secondConfirmed !== true) {
    throw new ValidationError('Delete operations require a second confirmation');
  }
  const result = service.execute(actions ? { actions } : actionFromBody(req.valid.body), {
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

function confirmationRequirements(preview, actions) {
  const deletes = actions.filter((action) => action.type === 'delete').length;
  return {
    required: actions.some((action) => WRITE_TYPES.has(action.type)),
    secondConfirmationRequired: deletes > 0,
    deleteCount: deletes,
    itemCount: actions.length,
    paths: preview.operations?.flatMap((operation) => operation.changes?.map((change) => change.fullPath) ?? [])
      ?? preview.changes?.map((change) => change.fullPath)
      ?? [],
  };
}

function getPrincipal(req) {
  return req.workspacePrincipal ?? { actor: 'local-user', role: 'editor' };
}

function assertCanWrite(req) {
  const principal = getPrincipal(req);
  if (principal.role === 'viewer') throw new ValidationError('当前角色只有读取权限，不能执行文件修改');
  return principal;
}
