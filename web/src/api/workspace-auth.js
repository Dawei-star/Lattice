const STORAGE_KEY = 'lattice-ai-settings-v1';
// 与 client.js 同源约定（client.js 反向依赖本模块，这里不 import 它）
const RAW_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? '/api';

export function getWorkspaceAccessToken() {
  if (typeof localStorage === 'undefined') return '';
  try {
    const settings = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return typeof settings?.accessToken === 'string' ? settings.accessToken.trim().slice(0, 500) : '';
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
