import type { AiStreamEvent, AiStreamFinalPayload, AiStreamOptions } from '../../api/ai.ts';
import type { AiProvider, AiProviderRequest } from './provider.ts';

export interface TauriAiProviderTransport {
  stream: (request: AiProviderRequest, options?: AiStreamOptions) => Promise<AiStreamFinalPayload>;
}

export interface TauriAiRunRecord {
  id: string;
  kind: string;
  key?: string | null;
  status: string;
  payload?: unknown;
  result?: unknown;
  error?: string | null;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  checkpoint?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TauriAiRunEventRecord {
  runId: string;
  sequence: number;
  eventType: string;
  payload: AiStreamEvent;
  createdAt: string;
}

export interface TauriAiRunClient {
  enqueue: (request: AiProviderRequest) => Promise<TauriAiRunRecord>;
  get: (runId: string) => Promise<TauriAiRunRecord | null>;
  events: (runId: string, afterSequence?: number, limit?: number) => Promise<TauriAiRunEventRecord[]>;
  checkpoint: (runId: string, checkpoint: unknown) => Promise<TauriAiRunRecord | null>;
  cancel: (runId: string) => Promise<TauriAiRunRecord | null>;
  resume: (runId: string, request?: AiProviderRequest) => Promise<TauriAiRunRecord | null>;
}

/**
 * Desktop transport boundary. The Tauri command/event wiring is injected so
 * this module can be tested without requiring a desktop runtime.
 */
export function createTauriAiProvider(transport: TauriAiProviderTransport, id = 'tauri'): AiProvider {
  return {
    id,
    supportsStreaming: true,
    stream: (request, options) => transport.stream(request, options),
  };
}

export function createTauriEventStreamTransport(input: {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  subscribe: (eventName: string, handler: (event: { payload?: AiStreamEvent }) => void) => Promise<() => void>;
  command?: string;
  cancelCommand?: string;
  eventName?: string;
}): TauriAiProviderTransport {
  return {
    stream: async (request, options = {}) => {
      const command = input.command ?? 'ai_chat_stream';
      const cancelCommand = input.cancelCommand ?? 'ai_chat_cancel';
      const eventName = input.eventName ?? `ai://stream/${encodeURIComponent(request.runId)}`;
      let finalPayload: AiStreamFinalPayload | undefined;
      let streamError: Error | undefined;
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        void input.invoke(cancelCommand, { runId: request.runId }).catch(() => {});
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      const unsubscribe = await input.subscribe(eventName, (event) => {
        const payload = event.payload;
        if (!payload) return;
        options.onEvent?.(payload);
        if (payload.type === 'done') finalPayload = payload.payload;
        if (payload.type === 'error') streamError = new Error(payload.message ?? 'AI 调用失败');
      });
      try {
        await input.invoke(command, { request });
      } finally {
        unsubscribe();
        options.signal?.removeEventListener('abort', onAbort);
      }
      if (streamError) throw streamError;
      if (cancelled && !finalPayload) return { cancelled: true };
      if (!finalPayload) throw new Error('Tauri AI 流未返回完成事件');
      return finalPayload;
    },
  };
}

/** Durable background Run API. A closed panel can resume by reading the job
 * and fetching events after the last sequence it rendered. */
export function createTauriDurableRunClient(input: {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  enqueueCommand?: string;
  getCommand?: string;
  eventsCommand?: string;
  cancelCommand?: string;
  resumeCommand?: string;
}): TauriAiRunClient {
  return {
    enqueue: (request: AiProviderRequest) => input.invoke(input.enqueueCommand ?? 'ai_run_enqueue', { request }) as Promise<TauriAiRunRecord>,
    get: (runId: string) => input.invoke(input.getCommand ?? 'ai_run_get', { runId }) as Promise<TauriAiRunRecord | null>,
    events: (runId: string, afterSequence = 0, limit = 200) => input.invoke(input.eventsCommand ?? 'ai_run_events', {
      runId, afterSequence, limit,
    }) as Promise<TauriAiRunEventRecord[]>,
    checkpoint: (runId: string, checkpoint: unknown) => input.invoke('ai_run_checkpoint', {
      runId, checkpoint,
    }) as Promise<TauriAiRunRecord | null>,
    cancel: (runId: string) => input.invoke(input.cancelCommand ?? 'ai_run_cancel', { runId }) as Promise<TauriAiRunRecord | null>,
    resume: (runId: string, request?: AiProviderRequest) => input.invoke(input.resumeCommand ?? 'ai_run_resume', {
      runId,
      ...(request ? { request } : {}),
    }) as Promise<TauriAiRunRecord | null>,
  };
}

/**
 * Durable desktop stream. The model call runs in the Rust worker; the web
 * side only replays persisted events, so closing the panel does not drop the
 * run and reopening it can continue from the last sequence.
 */
export function createTauriDurableRunTransport(input: {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  pollIntervalMs?: number;
}): TauriAiProviderTransport {
  const client = createTauriDurableRunClient(input);
  const pollIntervalMs = Math.max(0, input.pollIntervalMs ?? 250);

  return {
    stream: async (request, options = {}) => {
      let sequence = Number(request.resumeAfterSequence) || 0;
      let finalPayload: AiStreamFinalPayload | undefined;
      let streamError: Error | undefined;
      let cancelled = false;
      let run: TauriAiRunRecord | null = null;

      const replay = async () => {
        const events = await client.events(request.runId, sequence, 200);
        for (const record of events) {
          sequence = Math.max(sequence, Number(record.sequence) || sequence);
          const event = record.payload;
          options.onEvent?.(event);
          if (event.type === 'done') finalPayload = event.payload;
          if (event.type === 'error') streamError = new Error(event.message ?? 'AI 调用失败');
        }
      };

      const onAbort = () => {
        cancelled = true;
        void client.cancel(request.runId).catch(() => {});
      };

      if (options.signal?.aborted) return { cancelled: true };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (request.resumeRun) await client.resume(request.runId, request);
        else await client.enqueue(request);
        while (!finalPayload && !cancelled) {
          await replay();
          if (finalPayload || cancelled) break;

          run = await client.get(request.runId);
          const status = String(run?.status ?? '');
          if (status === 'cancelled') return { cancelled: true };
          if (status === 'failed') {
            throw streamError ?? new Error(run?.error ?? 'AI 后台任务失败');
          }
          if (status === 'completed') {
            await replay();
            if (finalPayload) break;
            throw streamError ?? new Error('AI 后台任务缺少完成事件');
          }
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, pollIntervalMs));
        }
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
      }

      if (streamError && !finalPayload) throw streamError;
      if (cancelled && !finalPayload) return { cancelled: true };
      if (!finalPayload) throw new Error('AI 后台任务未返回完成事件');
      return finalPayload;
    },
  };
}
