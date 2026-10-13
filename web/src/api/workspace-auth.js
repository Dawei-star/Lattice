const STORAGE_KEY = 'lattice-ai-settings-v1';
const SESSION_STORAGE_KEY = 'lattice-ai-session-v1';
// 与 client.js 同源约定（client.js 反向依赖本模块，这里不 import 它）
const RAW_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? '/api';

export function getWorkspaceAccessToken() {
  const sessionToken = readToken(typeof sessionStorage === 'undefined' ? undefined : sessionStorage, SESSION_STORAGE_KEY);
  if (sessionToken) return sessionToken;
  if (typeof localStorage === 'undefined') return '';
  try {
    const settings = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const legacyToken = typeof settings?.accessToken === 'string' ? settings.accessToken.trim().slice(0, 500) : '';
    if (legacyToken) {
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: legacyToken }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, accessToken: '' }));
      } catch {
        // A restricted storage context can still use the legacy value for this request.
      }
    }
    return legacyToken;
  } catch {
    return '';
  }
}

function readToken(storage, key) {
  if (typeof storage === 'undefined') return '';
  try {
    const value = JSON.parse(storage.getItem(key) ?? '{}');
    return typeof value?.accessToken === 'string' ? value.accessToken.trim().slice(0, 500) : '';
  } catch {
    return '';
  }
}

export function workspaceHeaders(headers = {}) {
  const token = getWorkspaceAccessToken();
  return token ? { ...headers, 'X-Workspace-Token': token } : headers;
}

/**
 * 换取 SSE 一次性短时票据（30 秒有效、单次使用）。
 * EventSource 无法携带请求头，用短时票据替代在 URL 里暴露长期令牌。
 */
export async function createSseTicket() {
  const url = new URL(`${RAW_BASE_URL.replace(/\/+$/, '')}/workspace/sse-ticket`, window.location.origin);
  const response = await fetch(url, {
    method: 'POST',
    headers: workspaceHeaders({ 'Content-Type': 'application/json' }),
  });
  if (!response.ok) throw new Error(`无法获取事件流票据（${response.status}）`);
  const payload = await response.json();
  return payload?.data ?? null;
}
