/**
 * 基础安全响应头。这是一个 JSON API，不注入 HTML，因此这里只做通用加固；
 * 托管前端构建产物时会在静态资源中间件上额外施加 CSP。
 */
export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  next();
}
