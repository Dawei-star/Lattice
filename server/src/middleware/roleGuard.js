import { ForbiddenError } from '../lib/errors.js';

/**
 * viewer 角色写端点守卫：只对携带身份主体的请求生效（令牌/工作区鉴权开启时），
 * 本地无鉴权模式下 role 是纯前端偏好，不拦截——否则用户在设置里选了 viewer
 * 会把设置页本身锁死。viewer 语义（只读）在配置与文件写端点上必须与 operations 一致。
 */
export function forbidViewerWrite(req, _res, next) {
  const principalRole = req.aiPrincipal?.role ?? req.workspacePrincipal?.role ?? null;
  if (principalRole === 'viewer') {
    next(new ForbiddenError('viewer 角色不允许修改配置或写入文件'));
    return;
  }
  next();
}
