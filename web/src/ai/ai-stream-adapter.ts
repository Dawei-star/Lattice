import type { AiStreamEvent, AiStreamFinalPayload, AiStreamOptions } from '../api/ai.ts';
import type { AiRunEvent } from './contracts.ts';
import { createAiRunTelemetry } from './run-telemetry.ts';

export interface AiStreamAdapterOptions {
  runId: string;
  onEvent?: (event: AiRunEvent) => void;
  onProviderEvent?: (event: AiStreamEvent) => void;
}

export interface AiStreamAdapter {
  start: (input: unknown, options?: Omit<AiStreamOptions, 'onEvent'>) => Promise<AiStreamFinalPayload>;
}

function mapEvent(runId: string, sequence: number, event: AiStreamEvent, metrics: AiRunEvent['metrics']): AiRunEvent {
  const rawType = String(event.type ?? 'status');
  const type: AiRunEvent['type'] = rawType === 'delta' || rawType === 'reasoning' || rawType === 'tool_call' || rawType === 'tool_result' || rawType === 'confirmation' || rawType === 'citation' || rawType === 'error' || rawType === 'done'
    ? rawType
    : 'status';
  return {
    runId,
    sequence,
    at: new Date().toISOString(),
    type,
    text: typeof event.text === 'string' ? event.text : typeof event.message === 'string' ? event.message : undefined,
    call: event.call,
    payload: event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : undefined,
    status: type === 'done' ? 'completed' : undefined,
    metrics,
  };
}

/** Converts provider-specific SSE/IPC events into the AI Runtime event contract. */
export function createAiStreamAdapter(transport: (input: unknown, options?: AiStreamOptions) => Promise<AiStreamFinalPayload>, options: AiStreamAdapterOptions): AiStreamAdapter {
  return {
    start: (input, requestOptions = {}) => {
      let sequence = 0;
      const telemetry = createAiRunTelemetry();
      return transport(input, {
        ...requestOptions,
        onEvent: (event) => {
          sequence += 1;
          options.onProviderEvent?.(event);
          options.onEvent?.(mapEvent(options.runId, sequence, event, telemetry.record({
            type: String(event.type ?? 'status') as AiRunEvent['type'],
            text: typeof event.text === 'string' ? event.text : typeof event.message === 'string' ? event.message : undefined,
            payload: event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : undefined,
          })));
        },
      });
    },
  };
}

