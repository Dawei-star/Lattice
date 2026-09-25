/**
 * 全局错误处理：把任意异常翻译为规范化的 JSON 错误体。
 * 契约（前端按此解析）：
 *   { error: { code, message, details?, requestId } }
 * 5xx 一律不外泄内部细节，只记录日志。
 */
import { AppError, InternalError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** 未命中任何路由 */
export function notFoundHandler(req, _res, next) {
  next(new NotFoundError(`接口不存在：${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars -- Express 靠四元签名识别错误中间件
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }

  const log = req.log ?? logger;
  const requestId = req.id ?? 'unknown';

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = '服务器内部错误';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_REQUEST';
    message = '请求体不是合法的 JSON';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = '请求体超出大小限制';
  } else if (err?.status && err?.status < 500) {
    status = err.status;
    code = err.code ?? 'REQUEST_ERROR';
    message = err.message;
  }

  if (status >= 500) {
    log.error('unhandled_error', {
      method: req.method,
      path: req.originalUrl,
      status,
      err: err instanceof Error ? err : new InternalError(String(err)),
    });
  } else {
    log.warn('request_rejected', {
      method: req.method,
      path: req.originalUrl,
      status,
      code,
      reason: message,
      details,
    });
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      requestId,
    },
  });
}
