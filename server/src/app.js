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
import { healthRouter } from './modules/health/health.routes.js';
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

  // 请求体上限 2MB：单篇笔记正文上限 200 万字符，留出 JSON 转义余量
  app.use(express.json({ limit: '2mb' }));

  // 探针放在鉴权与业务路由之前，保证永远可达
  app.use(healthRouter);

  app.use('/api', apiRouter);

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

  // SPA 回退：非 /api、非探针的 GET 一律交给前端路由
  app.get(/^\/(?!api\/|health$|ready$).*/, (_req, res) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.sendFile(indexHtml);
  });
}
