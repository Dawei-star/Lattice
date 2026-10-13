import { randomUUID } from 'node:crypto';

export const OPERATION_PLAN_VERSION = 1;

const ACTION_FIELDS = [
  'path',
  'targetPath',
  'content',
  'replace',
  'with',
  'all',
  'query',
  'noteId',
  'version',
];

export function createOperationPlan(actions, {
  id = randomUUID(),
  actor = 'local-user',
  role = 'editor',
  source = 'api',
  createdAt = new Date().toISOString(),
} = {}) {
  return {
    version: OPERATION_PLAN_VERSION,
    id: String(id),
    actor: String(actor),
    role: String(role),
    source: String(source),
    createdAt,
    actions: normalizePlanActions(actions),
  };
}

export function normalizePlanActions(actions, { max = 30 } = {}) {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > max) {
    throw new Error(`An operation plan must contain between 1 and ${max} actions`);
  }

  return actions.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Operation ${index + 1} must be an object`);
    }
    const type = String(raw.type ?? '').trim().toLowerCase();
    if (!type) throw new Error(`Operation ${index + 1} is missing a type`);

    const action = {
      id: String(raw.id ?? `op-${index + 1}`),
      type,
    };
    for (const field of ACTION_FIELDS) {
      if (raw[field] !== undefined) action[field] = raw[field];
    }
    return action;
  });
}

export function auditAction(action) {
  const result = {
    id: action?.id ?? null,
    type: action?.type ?? null,
  };
  for (const field of ['path', 'targetPath']) {
    if (action?.[field] !== undefined) result[field] = action[field];
  }
  return result;
}
