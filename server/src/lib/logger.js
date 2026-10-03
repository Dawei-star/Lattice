/**
 * 结构化 JSON 日志。
 * 每条日志一行 JSON，字段固定（ts/level/msg + 上下文），便于被采集与检索。
 * 只在 logger 层做序列化，业务代码只负责传上下文对象。
 */
import { config } from '../config/index.js';

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

/** 敏感字段一律脱敏，避免密码/令牌/隐私写入日志 */
const REDACT_KEYS = /^(password|passwd|token|access_token|refresh_token|authorization|secret|cookie|api_?key)$/i;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = REDACT_KEYS.test(key) ? '[redacted]' : sanitize(val, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, base, context, message) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[config.logLevel]) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...sanitize(base),
    ...sanitize(context),
  };

  const line = `${JSON.stringify(record)}\n`;
  if (level === 'error' || level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
}

/**
 * 创建一个 logger，可携带固定上下文（如 requestId）。
 * @param {Record<string, unknown>} [base]
 */
export function createLogger(base = {}) {
  return {
    debug: (message, context) => emit('debug', base, context, message),
    info: (message, context) => emit('info', base, context, message),
    warn: (message, context) => emit('warn', base, context, message),
    error: (message, context) => emit('error', base, context, message),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}

export const logger = createLogger({ app: 'lattice' });
