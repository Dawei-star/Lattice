import type { AiStreamEvent, AiStreamFinalPayload, AiStreamOptions } from '../../api/ai.ts';
import type { AiProviderRequest } from './provider.ts';

export interface AiProviderRouteCandidate {
  id?: string;
  name?: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  authHeader?: string;
  [key: string]: unknown;
}

export interface AiProviderRouterTransport {
  stream: (request: AiProviderRequest, options?: AiStreamOptions) => Promise<AiStreamFinalPayload>;
}

export interface AiProviderRouterOptions {
  stream: AiProviderRouterTransport['stream'];
  getResumeSequence?: (runId: string) => Promise<number>;
  onFallback?: (input: {
    runId: string;
    from: AiProviderRouteCandidate;
    to: AiProviderRouteCandidate;
    attempt: number;
    error: unknown;
  }) => void;
  allowFallback?: (request: AiProviderRequest, error: unknown) => boolean;
}

function asCandidate(value: unknown): AiProviderRouteCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const endpoint = typeof candidate.endpoint === 'string' ? candidate.endpoint.trim() : '';
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
  if (!endpoint || !model) return null;
  return candidate as AiProviderRouteCandidate;
}

function candidateKey(candidate: AiProviderRouteCandidate): string {
  return String(candidate.id ?? `${candidate.endpoint}|${candidate.model}`);
}

export function normalizeProviderCandidates(input: unknown): AiProviderRouteCandidate[] {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const candidates: AiProviderRouteCandidate[] = [];
  for (const value of values) {
    const candidate = asCandidate(value);
    if (!candidate) continue;
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { status?: unknown; response?: { status?: unknown } };
  const status = Number(value.status ?? value.response?.status);
  return Number.isInteger(status) && status >= 100 ? status : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return [value.code, value.message, value.error].filter(Boolean).map(String).join(' ');
  }
  return String(error ?? '');
}

/** Only network, timeout, rate-limit, and upstream 5xx errors are retryable. */
export function isRetryableAiProviderError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== null) {
    if ([408, 425, 429].includes(status) || status >= 500) return true;
    return false;
  }
  const text = errorText(error);
  if (!text) return false;
  if (/(?:401|403|404|422|unauthori[sz]ed|forbidden|invalid\s+(?:api\s*)?key|content\s+policy|取消|cancelled|confirmation|确认)/iu.test(text)) return false;
  return /(?:timeout|timed\s*out|network|failed\s+to\s+fetch|fetch\s+failed|econn|connection|连接|无法连接|流读取失败|HTTP\s*5\d\d|上游.*5\d\d)/iu.test(text);
}

function fallbackEvent(input: {
  from: AiProviderRouteCandidate;
  to: AiProviderRouteCandidate;
  attempt: number;
  error: unknown;
}): AiStreamEvent {
  return {
    type: 'meta',
    model: input.to.model,
    meta: {
      providerId: input.to.id ?? input.to.name ?? input.to.model,
      fallback: true,
      fallbackFrom: input.from.id ?? input.from.name ?? input.from.model,
      attempt: input.attempt,
      errorKind: 'retryable_provider_error',
    },
  };
}

/**
 * Routes one durable Run through an ordered Provider list. The transport owns
 * persistence; this layer only changes the in-memory request between attempts.
 */
export function createAiProviderRouterTransport(options: AiProviderRouterOptions): AiProviderRouterTransport {
  return {
    stream: async (request, streamOptions = {}) => {
      const current = asCandidate(request.provider);
      const configured = normalizeProviderCandidates(request.providerCandidates);
      const candidates = normalizeProviderCandidates([
        current,
        ...configured,
      ]);
      if (candidates.length <= 1) return options.stream(request, streamOptions);

      let lastError: unknown;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const previous = index > 0 ? candidates[index - 1] : null;
        const fallbackAttempt = index > 0;
        let attemptProducedOutput = false;
        const resumeAfterSequence = fallbackAttempt && options.getResumeSequence
          ? await options.getResumeSequence(request.runId).catch(() => 0)
          : undefined;
        const attemptRequest: AiProviderRequest = {
          ...request,
          provider: candidate,
          ...(fallbackAttempt ? {
            resumeRun: true,
            providerAttempt: index,
            ...(resumeAfterSequence !== undefined ? { resumeAfterSequence } : {}),
          } : {}),
        };

        if (fallbackAttempt && previous) {
          const event = fallbackEvent({ from: previous, to: candidate, attempt: index, error: lastError });
          streamOptions.onEvent?.(event);
          options.onFallback?.({ runId: request.runId, from: previous, to: candidate, attempt: index, error: lastError });
        }

        try {
          return await options.stream(attemptRequest, {
            ...streamOptions,
            onEvent: (event) => {
              if ((event.type === 'delta' || event.type === 'reasoning') && String(event.text ?? '')) {
                attemptProducedOutput = true;
              }
              streamOptions.onEvent?.(event);
            },
          });
        } catch (error) {
          lastError = error;
          const hasNext = index < candidates.length - 1;
          const safeToFallback = request.mode !== 'task'
            && !attemptProducedOutput
            && (options.allowFallback?.(request, error) ?? true)
            && isRetryableAiProviderError(error);
          if (!hasNext || !safeToFallback) throw error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(errorText(lastError));
    },
  };
}
