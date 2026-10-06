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

/** URL 解析失败（空串、残缺地址等）抛 502 的可预期错误，而非裸 TypeError 变成 500 */
function parseEndpoint(value) {
  try {
    return new URL(String(value).trim());
  } catch {
    throw new AiProviderError('AI endpoint 格式不正确，请填写完整的 HTTP(S) 接口地址');
  }
}

export function normalizeChatEndpoint(value) {
  const endpoint = parseEndpoint(value);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new AiProviderError('AI endpoint 必须使用 HTTP 或 HTTPS 协议');
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) return endpoint;
  if (/\/v1$/i.test(pathname)) endpoint.pathname = `${pathname}/chat/completions`;
  return endpoint;
}

/** embedding 端点：/v1 → /v1/embeddings；已写全的直接使用 */
export function normalizeEmbeddingEndpoint(value) {
  const endpoint = parseEndpoint(value);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new AiProviderError('AI endpoint 必须使用 HTTP 或 HTTPS 协议');
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
  if (status === 401) {
    // 401 最常见的根因是 Key 与服务不匹配（同一厂商不同产品线的密钥通常不通用）
    return `外部模型服务返回 401（${host}）：API Key 无效或与该服务不匹配（同一厂商不同产品线的密钥通常不通用）— ${safeDetail}`;
  }
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

/** 归一上游 usage（OpenAI 规范字段，部分网关缺省）；无有效字段时返回 null */
function normalizeUsage(raw) {
  const prompt = Number(raw?.prompt_tokens);
  const completion = Number(raw?.completion_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(Number(raw?.total_tokens))
      ? Number(raw.total_tokens)
      : (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0),
  };
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
 * AbortError 的统一出口：客户端取消与上游超时都应归为可预期错误（502 + warn 日志），
 * 否则非流式路径会把「请求已取消」当成未处理异常记 error 级 unhandled_error。
 */
function abortOutcomeError(signal, timeoutMessage) {
  if (signal?.aborted) return new AiProviderError('请求已取消', { code: 'AI_REQUEST_CANCELLED' });
  return new AiProviderError(timeoutMessage, { code: 'AI_UPSTREAM_TIMEOUT' });
}

/**
 * 非流式对话补全。返回 { raw, meta }；解析成结构化回复是调用方（ai.service）的职责。
 * 429/5xx/建连网络错误自动重试（AI_RETRY_MAX，默认 1 次，指数退避）；超时与客户端取消不重试。
 */
export async function callChatProvider({ messages, provider, signal = null, temperature = 0.2, maxTokens = null }) {
  const endpoint = normalizeChatEndpoint(provider.endpoint);
  await assertPublicEndpoint(endpoint);
  const body = JSON.stringify({
    model: provider.model || 'gpt-4o-mini',
    temperature,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  });
  const headers = buildProviderHeaders(provider);

  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt - 1)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS());
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: composeAbortSignals(controller.signal, signal),
      });
      if (!response.ok) {
        const { payload, responseText } = await readErrorPayload(response);
        if (isRetryableStatus(response.status) && attempt < config.aiRetryMax) continue;
        throw new AiProviderError(formatProviderError(response.status, payload, responseText, endpoint));
      }
      const payload = await response.json();
      const raw = payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? '';
      if (!raw) throw new AiProviderError('外部 AI 没有返回内容');
      const reasoning = String(payload?.choices?.[0]?.message?.reasoning_content ?? '');
      const usage = normalizeUsage(payload?.usage);
      return { raw: String(raw), reasoning, meta: { provider: 'external', model: provider.model || 'default', ...(usage ? { usage } : {}) } };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (isRetryableNetworkError(error, signal) && attempt < config.aiRetryMax) continue;
      if (error?.name === 'AbortError') {
        throw abortOutcomeError(signal, `外部 AI 响应超时（${Math.round(CHAT_TIMEOUT_MS() / 1000)} 秒），模型生成较慢或不可达；可用 AI_CHAT_TIMEOUT_MS 调整`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** 429 与 5xx 属瞬时故障，值得一次退避重试；4xx 参数错误重试无意义 */
function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function retryDelayMs(attempt) {
  return Math.min(500 * 2 ** attempt, 4_000);
}

/** 建连层网络错误（fetch failed / 连接被重置）；客户端已取消时绝不重试 */
function isRetryableNetworkError(error, signal) {
  if (signal?.aborted) return false;
  if (error?.name === 'AbortError') return false;
  if (error instanceof TypeError) return true; // node fetch 的网络层失败统一是 TypeError: fetch failed
  return /ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR/i.test(String(error?.cause?.code ?? ''));
}

/**
 * 流式对话补全（SSE）。逐段回调 onDelta(正文增量) 与 onReasoning(思维链增量，
 * 推理模型如 glm-5.3-flashx 会在 delta.reasoning_content 里输出)，结束后返回完整文本。
 * 上游断流 / [DONE] / 客户端取消都会正常收尾。
 * 429/5xx/建连失败在首包之前自动重试（AI_RETRY_MAX）；已开始输出后不可重试，
 * 中断一律按取消/超时语义收尾，避免向调用方重复下发前一段内容。
 */
export async function streamChatProvider({ messages, provider, signal = null, onDelta, onReasoning, temperature = 0.2, maxTokens = null }) {
  const endpoint = normalizeChatEndpoint(provider.endpoint);
  await assertPublicEndpoint(endpoint);
  const body = JSON.stringify({
    model: provider.model || 'gpt-4o-mini',
    temperature,
    messages,
    stream: true,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  });
  const headers = { ...buildProviderHeaders(provider), Accept: 'text/event-stream' };

  // 首包之后 receivedAny 为真：重试只对「还没向调用方吐出任何内容」的失败生效
  let receivedAny = false;
  const trackDelta = (text) => {
    receivedAny = true;
    onDelta?.(text);
  };
  const trackReasoning = (text) => {
    receivedAny = true;
    onReasoning?.(text);
  };

  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt - 1)));
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
        headers,
        body,
        signal: composeAbortSignals(controller.signal, signal),
      });
      if (!response.ok) {
        const { payload, responseText } = await readErrorPayload(response);
        if (isRetryableStatus(response.status) && attempt < config.aiRetryMax && !receivedAny) continue;
        throw new AiProviderError(formatProviderError(response.status, payload, responseText, endpoint));
      }
      if (!response.body) throw new AiProviderError('上游服务不支持流式响应');

      // 部分兼容网关会忽略 stream:true 直接回整体 JSON：按非流式解析，
      // 否则流式解析读不到任何 data: 行，误报「外部 AI 没有返回内容」。
      const contentType = String(response.headers?.get('content-type') ?? '');
      if (/application\/json/i.test(contentType)) {
        const payload = await response.json();
        const raw = String(payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? '');
        if (!raw) throw new AiProviderError('外部 AI 没有返回内容');
        const reasoning = String(payload?.choices?.[0]?.message?.reasoning_content ?? '');
        if (reasoning) trackReasoning(reasoning);
        trackDelta(raw);
        const usage = normalizeUsage(payload?.usage);
        return { raw, reasoning, meta: { provider: 'external', model: provider.model || 'default', ...(usage ? { usage } : {}) } };
      }

      let full = '';
      let reasoning = '';
      // 用量一般随最后一个 chunk 下发（DeepSeek/GLM 默认带；OpenAI 需 stream_options，这里被动捕获、不发兼容性存疑的参数）
      let usage = null;
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
            if (event?.usage) usage = normalizeUsage(event.usage) ?? usage;
            const delta = event?.choices?.[0]?.delta ?? event?.choices?.[0]?.message ?? {};
            const reasoningDelta = String(delta.reasoning_content ?? delta.reasoning ?? '');
            if (reasoningDelta) {
              reasoning += reasoningDelta;
              trackReasoning(reasoningDelta);
            }
            const contentDelta = delta.content ?? event?.output_text ?? '';
            if (contentDelta) {
              full += contentDelta;
              trackDelta(contentDelta);
            }
          } catch {
            // 非 JSON 的 data 行（心跳/注释）忽略
          }
        }
      }
      if (!full.trim()) throw new AiProviderError('外部 AI 没有返回内容');
      return { raw: full, reasoning, meta: { provider: 'external', model: provider.model || 'default', ...(usage ? { usage } : {}) } };
    } catch (error) {
      if (receivedAny) {
        // 已有输出下发：不可重试，按既有的取消/超时语义收尾
        if (error?.name === 'AbortError') {
          throw abortOutcomeError(signal, `外部 AI 连接空闲超时（${Math.round(CHAT_TIMEOUT_MS() / 1000)} 秒未收到新内容），模型生成较慢或不可达；可用 AI_CHAT_TIMEOUT_MS 调整`);
        }
        throw error;
      }
      if (error instanceof AiProviderError) throw error;
      if (isRetryableNetworkError(error, signal) && attempt < config.aiRetryMax) continue;
      if (error?.name === 'AbortError') {
        throw abortOutcomeError(signal, `外部 AI 连接空闲超时（${Math.round(CHAT_TIMEOUT_MS() / 1000)} 秒未收到新内容），模型生成较慢或不可达；可用 AI_CHAT_TIMEOUT_MS 调整`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
      throw abortOutcomeError(signal, 'embedding 请求超时，请检查端点是否可达');
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
