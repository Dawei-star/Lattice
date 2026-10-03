/**
 * Express 应用装配。
 * 中间件顺序即安全边界，顺序敏感，请勿随意调整：
 *   请求ID → 访问日志 → 安全头 → CORS → JSON 解析 → 探针 → 业务路由 → 静态资源 → 404 → 全局错误
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config/index.js';
import { cors } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestContext, requestLogger } from './middleware/requestContext.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { authenticateWorkspace } from './middleware/workspaceAuth.js';
import { healthRouter } from './modules/health/health.routes.js';
import { vaultEventsRouter } from './modules/vault/vault.events.routes.js';
import { apiRouter } from './routes/index.js';

/** 单页应用的 CSP：只允许加载同源资源，禁止被嵌入 iframe */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(requestContext);
  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(cors);

  // 请求体上限 8MB：单篇笔记正文上限 200 万字符，中文 UTF-8 约 6MB，
  // 加上 JSON 转义与属性余量取 8MB，让 zod 校验（而非 413）成为真正的边界。
  // 附件上传（POST /api/vault/attachments）是原始字节流，由路由上的 raw 解析器
  // 接管；JSON 解析器若先消费，JSON 类型的附件文件就再也还原不回字节流了。
  app.use(express.json({
    limit: '8mb',
    type: (req) => Boolean(req.is('application/json'))
      && !(req.method === 'POST' && req.path === '/api/vault/attachments'),
  }));

  // 探针放在鉴权与业务路由之前，保证永远可达
  app.use(healthRouter);

  // SSE 事件流自带「令牌或一次性票据」校验，必须注册在全局鉴权链之前
  // （EventSource 无法带请求头，长期令牌不应进 URL，见 vault.events.routes.js）
  app.use(vaultEventsRouter);

  app.use('/api', authenticateWorkspace, apiRouter);

  // 若前端已构建，则由同一进程托管，实现「一条命令跑生产」
  mountWebApp(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function mountWebApp(app) {
  const indexHtml = path.join(config.webDistDir, 'index.html');
  if (!fs.existsSync(indexHtml)) return;

  app.use(
    express.static(config.webDistDir, {
      index: false,
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // SPA 回退：非 /api（含精确 /api）、非探针的 GET 一律交给前端路由
  app.get(/^\/(?!api(\/|$)|health$|ready$).*/, (_req, res) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.sendFile(indexHtml);
  });
}
