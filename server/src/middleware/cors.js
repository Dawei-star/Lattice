/**
 * CORS：只允许配置中显式列出的来源。
 * 生产环境若配置为 * ，config 层会直接拒绝启动，这里不再兜底。
 * 同源部署（后端同时托管前端构建产物）时不会有 Origin 头，自然也无需 CORS。
 */
import { config } from '../config/index.js';

export function cors(req, res, next) {
  const origin = req.get('origin');
  const allowed = origin === undefined || config.corsOrigins.includes(origin);

  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  // 无论是否命中白名单都要 Vary，避免中间代理缓存串味
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
