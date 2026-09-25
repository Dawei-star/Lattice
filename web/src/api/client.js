/**
 * 类型化 HTTP 客户端。
 *
 * 设计要点：
 *  1. Base URL 走环境变量，默认同源 /api，代码里不出现任何硬编码后端地址
 *  2. 统一超时控制（默认 15s），避免请求悬挂
 *  3. 自动重试：仅对「可重试错误」退避重试最多 3 次 —— 5xx、429、网络中断、超时
 *     4xx 一律不重试（客户端错误重试没有意义）
 *     为此后端的写接口都设计成幂等：POST /notes 由客户端提供 UUID、
 *     PATCH 整体替换、DELETE 幂等，因此重试不会产生重复数据
 *  4. 错误统一映射为面向用户的中文提示，4xx 采用后端返回的文案（本就是给用户看的），
 *     5xx 一律使用通用文案，绝不把服务端内部信息透出到界面
 */

// import.meta.env 由 Vite 在构建时注入；用可选链兜底，
// 这样同一份代码在非 Vite 环境（如 Node 冒烟测试）里也能安全降级到 /api
const RAW_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? '/api';
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 400;

const FALLBACK_MESSAGES = {
  400: '请求格式有误，请刷新页面后重试',
  401: '登录状态已失效，请重新登录',
  403: '没有权限执行该操作',
  404: '目标内容不存在，可能已被删除',
  409: '操作与现有数据冲突，请刷新后重试',
  413: '内容体积超出限制，请精简后再试',
  422: '提交的内容未通过校验',
  429: '操作过于频繁，请稍后再试',
  500: '服务端处理失败，已自动重试仍未成功',
  502: '服务网关异常，请稍后重试',
  503: '服务暂时不可用，请稍后重试',
  504: '服务响应超时，请稍后重试',
};

export class ApiError extends Error {
  /**
   * @param {string} message 面向用户的可读提示
   * @param {{ status?: number, code?: string, details?: unknown, requestId?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, { cause: meta.cause });
    this.name = 'ApiError';
    this.status = meta.status ?? 0;
    this.code = meta.code ?? 'UNKNOWN';
    this.details = meta.details;
    this.requestId = meta.requestId;
  }

  /** 网络不可达 / 后端未启动 */
  get isOffline() {
    return this.code === 'OFFLINE' || this.code === 'NETWORK';
  }

  get isTimeout() {
    return this.code === 'TIMEOUT';
  }

  get isRetryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** 把后端的逐字段校验错误摊平成 { 字段名: 提示 } */
  get fieldErrors() {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries(this.details.map((item) => [item.field, item.message]));
  }
}

function resolveMessage(status, code, serverMessage) {
  if (code === 'OFFLINE') return '当前处于离线状态，请检查网络连接';
  if (code === 'NETWORK') return '无法连接后端服务，请确认服务已启动（默认 http://localhost:5177）';
  if (code === 'TIMEOUT') return '请求超时，后端可能未响应，请稍后重试';
  if (status === 0) return '网络请求失败，请稍后重试';
  // 4xx 的文案由后端提供，本身就是面向用户的；5xx 一律用兜底文案
  if (status < 500 && serverMessage) return serverMessage;
  return FALLBACK_MESSAGES[status] ?? `请求失败（HTTP ${status}）`;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

async function attemptOnce(url, { method, body, timeout, signal }) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError('', { code: 'OFFLINE', status: 0 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const serverError = payload?.error ?? {};
      throw new ApiError(resolveMessage(response.status, serverError.code, serverError.message), {
        status: response.status,
        code: serverError.code ?? `HTTP_${response.status}`,
        details: serverError.details,
        requestId: serverError.requestId,
      });
    }

    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') {
      // 外部主动取消不应被当作超时
      if (signal?.aborted) throw error;
      throw new ApiError('', { code: 'TIMEOUT', status: 0, cause: error });
    }
    throw new ApiError('', { code: 'NETWORK', status: 0, cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * @param {string} path 以 / 开头的资源路径
 * @param {{ method?: string, body?: unknown, query?: Record<string, unknown>, signal?: AbortSignal, timeout?: number, retries?: number, base?: string }} [options]
 * @returns {Promise<unknown>} 后端返回的完整响应体
 */
async function requestRaw(path, options = {}) {
  const {
    method = 'GET',
    body,
    query,
    signal,
    timeout = DEFAULT_TIMEOUT_MS,
    retries = MAX_RETRIES,
    base = BASE_URL,
  } = options;

  const url = new URL(`${base}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await attemptOnce(url, { method, body, timeout, signal });
    } catch (error) {
      const retryable = error instanceof ApiError && error.isRetryable;
      if (!retryable || attempt > retries) throw error;

      // 指数退避 + 抖动，避免多个请求同时重试造成尖峰
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), 3000) + Math.random() * 200;
      await delay(backoff, signal);
    }
  }
}

/** 只取 data 字段（绝大多数接口的用法） */
async function request(path, options) {
  const payload = await requestRaw(path, options);
  return payload?.data;
}

export const http = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  /** 需要同时读取 data 与 meta（如分页总数、检索策略）时使用 */
  getFull: (path, options) => requestRaw(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  postFull: (path, body, options) => requestRaw(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

export { BASE_URL };
