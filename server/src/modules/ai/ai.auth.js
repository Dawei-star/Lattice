import { timingSafeEqual } from 'node:crypto';
import { config } from '../../config/index.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { readBearerToken } from '../../middleware/workspaceAuth.js';

/**
 * Optional single-workspace authentication. Local installs stay passwordless;
 * setting AI_ACCESS_TOKEN turns the AI API into a bearer-token boundary.
 */
export function authenticateAi(req, _res, next) {
  if (!config.aiAccessToken) {
    next();
    return;
  }

  const token = readBearerToken(req.get('authorization'));
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
  const principal = req.aiPrincipal ?? req.workspacePrincipal;
  if (!principal) return body;
  return { ...body, ...principal };
}

function sameSecret(candidate, expected) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer);
}
