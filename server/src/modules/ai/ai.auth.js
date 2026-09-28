import { timingSafeEqual } from 'node:crypto';
import { config } from '../../config/index.js';
import { UnauthorizedError } from '../../lib/errors.js';

/**
 * Optional single-workspace authentication. Local installs stay passwordless;
 * setting AI_ACCESS_TOKEN turns the AI API into a bearer-token boundary.
 */
export function authenticateAi(req, _res, next) {
  if (!config.aiAccessToken) {
    next();
    return;
  }

  const authorization = req.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || !sameSecret(token, config.aiAccessToken)) {
    throw new UnauthorizedError('AI 工作区访问令牌缺失或无效');
  }

  req.aiPrincipal = {
    actor: 'authenticated-user',
    role: config.aiAccessRole,
  };
  next();
}

export function applyAiPrincipal(req, body) {
  if (!req.aiPrincipal) return body;
  return { ...body, ...req.aiPrincipal };
}

function sameSecret(candidate, expected) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer);
}
