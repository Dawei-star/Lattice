/**
 * CORS 与来源校验：只允许配置中显式列出的来源，以及同源请求。
 * 生产环境若配置为 * ，config 层会直接拒绝启动，这里不再兜底。
 * 同源部署（后端同时托管前端构建产物）时不会有 Origin 头，自然也无需 CORS。
 *
 * 除放行头之外，这里还承担两个浏览器侧攻击面的拦截：
 *  1. 跨站伪造：携带非法 Origin 的请求直接 403。DELETE / GET 这类简单请求
 *     浏览器不会发预检，若只是"不加 ACAO 头"，请求已在服务端执行完毕，
 *     响应读不到也拦不住删除（经典 CSRF）。
 *  2. DNS rebinding：服务端仅绑定回环地址时，Host 必须是回环主机名，
 *     否则攻击者域名解析到 127.0.0.1 即可绕过 Origin 检查读取响应。
 *     绑定 0.0.0.0 之类的广泛地址（局域网部署）时不校验 Host，靠令牌防护。
 */
import { config } from '../config/index.js';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 从 Host 头提取主机名（兼容 IPv6 的 [::1]:5177 形式） */
function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const colon = hostHeader.lastIndexOf(':');
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

function isAllowedRequest(req) {
  const hostHeader = req.get('host') ?? '';

  if (LOOPBACK_HOSTNAMES.has((config.host || '').toLowerCase())) {
    if (!LOOPBACK_HOSTNAMES.has(hostnameOf(hostHeader).toLowerCase())) return false;
  }

  const origin = req.get('origin');
  if (origin === undefined) return true;
  if (config.corsOrigins.includes(origin)) return true;

  // 同源请求：桌面端与托管模式下页面由本服务托管，POST 会带同源 Origin
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === hostHeader) {
      return true;
    }
  } catch {
    // 'null'（沙箱 iframe）或其它非法 Origin，落入拒绝
  }
  return false;
}

export function cors(req, res, next) {
  if (!isAllowedRequest(req)) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN_ORIGIN',
        message: '请求来源不在允许列表中',
        requestId: req.id,
      },
    });
    return;
  }

  const origin = req.get('origin');
  if (origin !== undefined && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id,X-Workspace-Token');
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
