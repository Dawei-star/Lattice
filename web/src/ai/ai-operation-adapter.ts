import type { RequestOptions } from '../api/client.ts';

export interface AiOperationGateway {
  preview: (input: unknown, options?: RequestOptions) => Promise<unknown>;
  execute: (input: unknown, options?: RequestOptions) => Promise<unknown>;
  undo: (operationId: string, options?: RequestOptions) => Promise<unknown>;
}

export interface AiOperationAdapter {
  preview: <T = unknown>(input: unknown, options?: RequestOptions) => Promise<T>;
  execute: <T = unknown>(input: unknown, options?: RequestOptions) => Promise<T>;
  undo: <T = unknown>(operationId: string, options?: RequestOptions) => Promise<T>;
}

function unwrap<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'data' in value) return (value as { data: T }).data;
  return value as T;
}

/** Keeps HTTP/IPC response envelopes out of the AI UI and controller layers. */
export function createAiOperationAdapter(gateway: AiOperationGateway): AiOperationAdapter {
  return {
    preview: async <T>(input: unknown, options?: RequestOptions) => unwrap<T>(await gateway.preview(input, options)),
    execute: async <T>(input: unknown, options?: RequestOptions) => unwrap<T>(await gateway.execute(input, options)),
    undo: async <T>(operationId: string, options?: RequestOptions) => unwrap<T>(await gateway.undo(operationId, options)),
  };
}

