/**
 * 请求上下文：为每个请求分配唯一 requestId，并派生带该 ID 的子 logger。
 * 支持客户端通过 x-request-id 透传，便于前后端串联排查。
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  const id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();

  req.id = id;
  req.log = logger.child({ requestId: id });
  res.setHeader('X-Request-Id', id);
  next();
}

export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    req.log[level]('http_request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    });
  });

  next();
}
