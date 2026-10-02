import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { UnauthorizedError } from '../lib/errors.js';

/**
 * Protect every workspace API with one shared token when configured.
 * X-Workspace-Token is preferred; Bearer remains supported for CLI clients.
 */
export function authenticateWorkspace(req, _res, next) {
  if (!config.workspaceAccessToken) {
    next();
    return;
  }

  const explicitToken = req.get('x-workspace-token')?.trim();
  const queryToken = typeof req.query?.workspaceToken === 'string' ? req.query.workspaceToken.trim() : '';
  const token = explicitToken || readBearerToken(req.get('authorization')) || queryToken;
  if (!token || !sameSecret(token, config.workspaceAccessToken)) {
    throw new UnauthorizedError('工作区访问令牌缺失或无效');
  }

  req.workspacePrincipal = {
    actor: 'authenticated-user',
    role: config.workspaceAccessRole,
  };
  next();
}

export function readBearerToken(value = '') {
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export function sameSecret(candidate, expected) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer);
}
