import { RateLimitError } from '../lib/errors.js';

/**
 * 进程内固定窗口限流。Lattice 是本地优先单进程服务，使用内存状态足够；
 * 部署到多实例时应把这里替换为共享计数器，而不是误以为本地 Map 是集群方案。
 */
export function createRateLimiter({ windowMs, max, key = 'default' }) {
  const buckets = new Map();
  const cleanupEvery = Math.max(windowMs, 30_000);
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [bucketKey, entry] of buckets) {
      if (entry.expiresAt <= now) buckets.delete(bucketKey);
    }
  }, cleanupEvery);
  cleanup.unref?.();

  return (req, res, next) => {
    const identity = req.get('x-workspace-token')
      ? `token:${req.get('x-workspace-token')}`
      : `ip:${req.socket.remoteAddress ?? 'unknown'}`;
    const bucketKey = `${key}:${identity}`;
    const now = Date.now();
    let entry = buckets.get(bucketKey);
    if (!entry || entry.expiresAt <= now) {
      entry = { count: 0, expiresAt: now + windowMs };
      buckets.set(bucketKey, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.expiresAt / 1000)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      next(new RateLimitError(retryAfterSeconds));
      return;
    }
    next();
  };
}
