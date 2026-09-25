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
import { ensureDir } from './modules/attachments/attachments.service.js';
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

  // 请求体上限：笔记正文由 zod 限到 200 万字符，这里主要给附件 base64 上传留空间
  app.use(express.json({ limit: config.maxBodyBytes }));

  // 探针放在鉴权与业务路由之前，保证永远可达
  app.use(healthRouter);

  app.use('/api', apiRouter);

  // 附件目录：以 UUID 文件名对外提供，内容不可变，可长期强缓存
  mountAttachments(app);

  // 导出的静态站点：只读托管，便于导出后在浏览器里本地预览
  mountExport(app);

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
        // 部分环境 mime 表不含 .webmanifest，会退化成 octet-stream 而被浏览器拒收
        if (filePath.endsWith('.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        }
      },
    }),
  );

  // SPA 回退：非 /api、非探针、非附件、非导出预览的 GET 一律交给前端路由
  app.get(/^\/(?!api\/|health$|ready$|attachments\/|export\/).*/, (_req, res) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.sendFile(indexHtml);
  });
}

/**
 * 只读托管导出的静态站点（EXPORT_DIR），供本地预览。
 * 每个导出是独立时间戳目录，HTML 不缓存、其余按普通静态资源处理。
 */
function mountExport(app) {
  fs.mkdirSync(config.exportDir, { recursive: true });
  app.use(
    '/export',
    express.static(config.exportDir, {
      index: 'index.html',
      dotfiles: 'ignore',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
}

/**
 * 托管附件目录。文件名是不可变的 UUID，可长期强缓存；
 * 缺失文件向下穿过（SPA 路由已排除 /attachments），最终落到 404 处理。
 */
function mountAttachments(app) {
  ensureDir();
  app.use(
    '/attachments',
    express.static(config.attachmentsDir, {
      index: false,
      dotfiles: 'ignore',
      maxAge: '365d',
      immutable: true,
    }),
  );
}
