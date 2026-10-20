import type { AiStreamEvent, AiStreamFinalPayload, AiStreamOptions } from '../../api/ai.ts';

export type AiProviderTier = 'fast' | 'standard' | 'reasoning';

export interface AiProviderRequest {
  runId: string;
  message: string;
  resumeRun?: boolean;
  modelTier?: AiProviderTier;
  context?: Record<string, unknown>;
  tools?: unknown[];
  [key: string]: unknown;
}

export interface AiProvider {
  readonly id: string;
  readonly supportsStreaming: boolean;
  stream: (request: AiProviderRequest, options?: AiStreamOptions) => Promise<AiStreamFinalPayload>;
  health?: () => Promise<{ ok: boolean; model?: string; error?: string }>;
}

export type AiProviderEventHandler = (event: AiStreamEvent) => void;
