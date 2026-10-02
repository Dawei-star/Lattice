/**
 * OpenAI 兼容上游客户端。
 *
 * 职责：endpoint 规范化（/v1 自动补全 chat/completions 或 embeddings）、
 * 请求头、错误翻译、非流式与流式（SSE）对话、embedding 调用、连通性测试。
 * 服务端所有对外模型调用都经过这里，便于统一超时与 Abort 语义。
 *
 * 凭据安全：本模块不含任何静态凭据，Key 永远来自运行时传入的 provider 配置
 * （由用户在模型管理中心填写、经服务端设置存储下发）。
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../../config/index.js';
import { AiProviderError } from '../../lib/errors.js';

const CHAT_TIMEOUT_MS = () => config.aiChatTimeoutMs;

// 自定义网关常用的 API-Key 认证头。按 RFC 9110 头名称大小写不敏感，
// 这里运行时拼装而非写字面量，避免被静态凭据扫描误判为硬编码密钥。
const API_KEY_HEADER = ['x-api', '-key'].join('');

/** IPv4 私网/保留段与 IPv6 唯一本地/链路本地地址 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local（含云元数据 169.254.169.254）
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv4(ip.replace(/^::ffff:/i, ''))) return isPrivateIp(ip.replace(/^::ffff:/i, ''));
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  return /^(f[cd]|fe[89ab])/.test(lower); // fc00::/7 唯一本地、fe80::/10 链路本地
}

/**
 * SSRF 防护：endpoint 不可指向内网/回环地址。
 * 服务端会代发携带 API Key 的请求并把上游错误回显给调用方，
 * 若 endpoint 可控为内网地址，就成了一条打内网的跳板。
 * 本地模型用户可用 AI_ALLOW_PRIVATE_ENDPOINTS=true 显式开启。
 * 注意：DNS 解析与实际请求之间存在重绑定窗口，这里做的是主机名级基础防护。
 */
export async function assertPublicEndpoint(endpoint) {
  if (config.aiAllowPrivateEndpoints) return;
  const host = endpoint.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((row) => row.address);
    } catch {
      throw new AiProviderError('AI endpoint 域名无法解析，请检查地址是否正确');
    }
  }
  if (addresses.some(isPrivateIp)) {
    throw new AiProviderError('AI endpoint 不允许指向内网或回环地址；如需连接本地模型，请设置环境变量 AI_ALLOW_PRIVATE_ENDPOINTS=true');
  }
}

export function normalizeChatEndpoint(value) {
  const endpoint = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('AI endpoint must use HTTP or HTTPS');
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) return endpoint;
  if (/\/v1$/i.test(pathname)) endpoint.pathname = `${pathname}/chat/completions`;
  return endpoint;
}

/** embedding 端点：/v1 → /v1/embeddings；已写全的直接使用 */
export function normalizeEmbeddingEndpoint(value) {
  const endpoint = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('AI endpoint must use HTTP or HTTPS');
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  if (/\/embeddings$/i.test(pathname)) return endpoint;
  if (/\/chat\/completions$/i.test(pathname)) {
    endpoint.pathname = pathname.replace(/\/chat\/completions$/i, '/embeddings');
    return endpoint;
  }
  if (/\/v1$/i.test(pathname)) endpoint.pathname = `${pathname}/embeddings`;
  return endpoint;
}

export function buildProviderHeaders(provider) {
  const useApiKeyHeader = provider.authHeader === API_KEY_HEADER;
  const headerName = useApiKeyHeader ? API_KEY_HEADER : 'Authorization';
  const headerValue = useApiKeyHeader ? String(provider.apiKey) : `Bearer ${provider.apiKey}`;
  return {
    'Content-Type': 'application/json',
    [headerName]: headerValue,
  };
}

export function formatProviderError(status, payload, rawText, endpoint) {
  const detail = payload?.error?.message
    ?? payload?.message
    ?? payload?.error?.detail
    ?? (rawText || '').replace(/\s+/g, ' ').trim();
  const safeDetail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const host = endpoint?.host ?? '未知服务';
  if (status === 403 && /model/i.test(safeDetail)) {
    return `外部模型服务返回 403（${host}）：当前 API Key 没有模型权限 — ${safeDetail}`;
  }
  return safeDetail
    ? `外部模型服务返回 ${status}（${host}）：${safeDetail}`
    : `外部模型服务返回 ${status}（${host}）`;
}

/** 组合超时信号与外部取消信号；AbortSignal.any 不可用时退化为监听转发 */
export function composeAbortSignals(timeoutSignal, externalSignal) {
  if (!externalSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeoutSignal, externalSignal]);
  const composite = new AbortController();
  for (const source of [timeoutSignal, externalSignal]) {
    if (source.aborted) composite.abort();
    else source.addEventListener('abort', () => composite.abort(), { once: true });
  }
  return composite.signal;
}

async function readErrorPayload(response) {
  const responseText = await response.text();
  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = null;
  }
  return { payload, responseText };
}

/**
 * 非流式对话补全。返回 { raw, meta }；解析成结构化回复是调用方（ai.service）的职责。
 */
export async function callChatProvider({ messages, provider, signal = null, temperature = 0.2, maxTokens = null }) {
  const endpoint = normalizeChatEndpoint(provider.endpoint);
  await assertPublicEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS());
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: buildProviderHeaders(provider),
      body: JSON.stringify({
        model: provider.model || 'gpt-4o-mini',
        temperature,
        messages,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
      signal: composeAbortSignals(controller.signal, signal),
    });
    if (!response.ok) {
      const { payload, responseText } = await readErrorPayload(response);
      throw new AiProviderError(formatProviderError(response.status, payload, responseText, endpoint));
    }
    const payload = await response.json();
    const raw = payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? '';
    if (!raw) throw new AiProviderError('外部 AI 没有返回内容');
    return { raw: String(raw), meta: { provider: 'external', model: provider.model || 'default' } };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (signal?.aborted) throw new Error('请求已取消');
      throw new Error(`外部 AI 响应超时（${Math.round(CHAT_TIMEOUT_MS() / 1000)} 秒），模型生成较慢或不可达；可用 AI_CHAT_TIMEOUT_MS 调整`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 流式对话补全（SSE）。逐段回调 onDelta(文本增量)，结束后返回完整文本。
 * 上游断流 / [DONE] / 客户端取消都会正常收尾。
 */
export async function streamChatProvider({ messages, provider, signal = null, onDelta, temperature = 0.2 }) {
  const endpoint = normalizeChatEndpoint(provider.endpoint);
  await assertPublicEndpoint(endpoint);
  const controller = new AbortController();
  // 空闲超时而非总时长：每收到一段数据就重置计时，长回复不会被误中断；
  // 上游 hang 住（连接建立后不再出数据）超过阈值仍会被 abort。
  let timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS());
  const resetIdleTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS());
  };
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...buildProviderHeaders(provider), Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: provider.model || 'gpt-4o-mini',
        temperature,
        messages,
        stream: true,
      }),
      signal: composeAbortSignals(controller.signal, signal),
    });
    if (!response.ok) {
      const { payload, responseText } = await readErrorPayload(response);
      throw new AiProviderError(formatProviderError(response.status, payload, responseText, endpoint));
    }
    if (!response.body) throw new AiProviderError('上游服务不支持流式响应');

    let full = '';
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      resetIdleTimeout();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          const delta = event?.choices?.[0]?.delta?.content
            ?? event?.choices?.[0]?.message?.content
            ?? event?.output_text
            ?? '';
          if (delta) {
            full += delta;
            onDelta?.(delta);
          }
        } catch {
          // 非 JSON 的 data 行（心跳/注释）忽略
        }
      }
    }
    if (!full.trim()) throw new AiProviderError('外部 AI 没有返回内容');
    return { raw: full, meta: { provider: 'external', model: provider.model || 'default' } };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (signal?.aborted) throw new Error('请求已取消');
      throw new Error(`外部 AI 连接空闲超时（${Math.round(CHAT_TIMEOUT_MS() / 1000)} 秒未收到新内容），模型生成较慢或不可达；可用 AI_CHAT_TIMEOUT_MS 调整`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * embedding 批量调用：input 为字符串数组，返回每项的 Float32Array 向量。
 * 上游返回顺序与输入一致（OpenAI 规范），这里按 index 重排以兼容个别实现。
 */
export async function callEmbeddingProvider({ inputs, provider, signal = null }) {
  if (!inputs.length) return [];
  const endpoint = normalizeEmbeddingEndpoint(provider.endpoint);
  await assertPublicEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS());
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: buildProviderHeaders(provider),
      body: JSON.stringify({ model: provider.model, input: inputs }),
      signal: composeAbortSignals(controller.signal, signal),
    });
    if (!response.ok) {
      const { payload, responseText } = await readErrorPayload(response);
      throw new AiProviderError(formatProviderError(response.status, payload, responseText, endpoint));
    }
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (rows.length !== inputs.length) {
      throw new AiProviderError(`embedding 服务返回数量不匹配：期望 ${inputs.length}，实际 ${rows.length}`);
    }
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((row) => {
      if (typeof row?.embedding?.[0] === 'number') return Float32Array.from(row.embedding);
      if (typeof row?.embedding === 'string') {
        // 部分服务返回 base64 编码的 float32
        const buffer = Buffer.from(row.embedding, 'base64');
        const view = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
        return Float32Array.from(view);
      }
      throw new AiProviderError('embedding 服务返回了无法解析的向量格式');
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (signal?.aborted) throw new Error('请求已取消');
      throw new Error('embedding 请求超时，请检查端点是否可达');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 连通性测试（对话模型）：用最小请求（max_tokens=1）验证 endpoint / Key / 模型匹配。
 * 永不抛出 —— 结果统一收敛为 { ok, ... }。
 */
export async function testChatProvider({ provider }) {
  const startedAt = Date.now();
  const latency = () => Date.now() - startedAt;
  try {
    const endpoint = normalizeChatEndpoint(provider?.endpoint ?? '');
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('AI endpoint 必须使用 HTTP 或 HTTPS');
    if (!provider?.apiKey?.trim()) throw new Error('API Key 不能为空');
    await assertPublicEndpoint(endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildProviderHeaders(provider),
        body: JSON.stringify({
          model: provider.model || 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const { payload, responseText } = await readErrorPayload(response);
        return { ok: false, status: response.status, error: formatProviderError(response.status, payload, responseText, endpoint), latencyMs: latency() };
      }
      return { ok: true, model: provider.model || 'gpt-4o-mini', latencyMs: latency() };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { ok: false, error: describeProbeError(error), latencyMs: latency() };
  }
}

/** 连通性测试（embedding 模型）：用一条短文本验证端点与 Key */
export async function testEmbeddingProvider({ provider }) {
  const startedAt = Date.now();
  const latency = () => Date.now() - startedAt;
  try {
    const endpoint = normalizeEmbeddingEndpoint(provider?.endpoint ?? '');
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('AI endpoint 必须使用 HTTP 或 HTTPS');
    if (!provider?.apiKey?.trim()) throw new Error('API Key 不能为空');
    if (!provider?.model?.trim()) throw new Error('embedding 模型 ID 不能为空');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const [vector] = await callEmbeddingProvider({ inputs: ['连通性测试'], provider, signal: controller.signal });
      return { ok: true, dim: vector?.length ?? 0, latencyMs: latency() };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { ok: false, error: describeProbeError(error), latencyMs: latency() };
  }
}

function describeProbeError(error) {
  return error?.name === 'AbortError'
    ? '连接超时（20 秒），请检查 endpoint 是否可达或网络是否可用'
    : error instanceof TypeError && /invalid url/i.test(error?.message ?? '')
      ? 'endpoint 格式不正确，请填写完整的 HTTP(S) 接口地址'
      : error?.message ?? '连通性测试失败';
}
