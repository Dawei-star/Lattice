import type { AiRunEvent, AiRunMetrics, AiRunTerminationReason } from './contracts.ts';

export interface AiRunTelemetry {
  record: (event: Pick<AiRunEvent, 'type' | 'text' | 'payload'>) => AiRunMetrics;
  snapshot: () => AiRunMetrics;
}

function terminationFor(event: Pick<AiRunEvent, 'type' | 'payload'>): AiRunTerminationReason | undefined {
  if (event.type === 'done') {
    const reason = event.payload?.terminationReason;
    if (reason === 'cancelled' || reason === 'budget_exceeded' || reason === 'error') return reason;
    return 'completed';
  }
  if (event.type === 'error') return 'error';
  return undefined;
}

/** Captures low-cardinality run timings without coupling to a provider. */
export function createAiRunTelemetry(now: () => number = () => Date.now()): AiRunTelemetry {
  const startedAtMs = now();
  let firstTokenAtMs: number | undefined;
  let toolCalls = 0;
  let toolDurationMs = 0;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;
  let terminationReason: AiRunTerminationReason | undefined;

  const readUsage = (payload: Record<string, unknown> | undefined) => {
    const direct = payload?.usage;
    const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta as Record<string, unknown> : undefined;
    const usage = direct && typeof direct === 'object' ? direct as Record<string, unknown> : meta?.usage && typeof meta.usage === 'object' ? meta.usage as Record<string, unknown> : undefined;
    if (!usage) return;
    const read = (...keys: string[]) => {
      for (const key of keys) {
        const value = Number(usage[key]);
        if (Number.isFinite(value) && value >= 0) return Math.floor(value);
      }
      return undefined;
    };
    promptTokens = read('prompt_tokens', 'promptTokens') ?? promptTokens;
    completionTokens = read('completion_tokens', 'completionTokens') ?? completionTokens;
    totalTokens = read('total_tokens', 'totalTokens') ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : totalTokens);
  };

  const snapshot = (): AiRunMetrics => ({
    startedAt: new Date(startedAtMs).toISOString(),
    ...(firstTokenAtMs === undefined ? {} : {
      firstTokenAt: new Date(firstTokenAtMs).toISOString(),
      timeToFirstTokenMs: Math.max(0, firstTokenAtMs - startedAtMs),
    }),
    durationMs: Math.max(0, now() - startedAtMs),
    toolCalls,
    toolDurationMs: Math.max(0, toolDurationMs),
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(terminationReason ? { terminationReason } : {}),
  });

  return {
    record(event) {
      const timestamp = now();
      if (firstTokenAtMs === undefined && event.type === 'delta' && Boolean(event.text)) firstTokenAtMs = timestamp;
      if (event.type === 'tool_call') toolCalls += 1;
      if (event.type === 'tool_result') {
        const duration = Number(event.payload?.durationMs);
        if (Number.isFinite(duration) && duration >= 0) toolDurationMs += duration;
      }
      readUsage(event.payload);
      terminationReason = terminationFor(event) ?? terminationReason;
      return snapshot();
    },
    snapshot,
  };
}
