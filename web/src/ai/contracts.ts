import type { AiAgentBudget, AiIntent, AiModelTier, AiRiskLevel, AiScopeDecision } from '../lib/ai-policy.ts';
import type { AgentToolCall, AgentToolKind } from '../lib/ai-agent.ts';

export type AiRunStatus =
  | 'queued'
  | 'routing'
  | 'retrieving'
  | 'generating'
  | 'waiting_confirmation'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded';

export interface AiRequest {
  runId: string;
  sessionId?: string | null;
  message: string;
  resumeRun?: boolean;
  mode: 'quick' | 'task';
  intents?: AiIntent[];
  modelTier?: AiModelTier;
  scope?: AiScopeDecision | null;
  budget: AiAgentBudget;
  context?: Record<string, unknown>;
  attachments?: Array<Record<string, unknown>>;
  /** 用户通过 `/` 面板显式调用的技能 id：本轮注入正文，与专家绑定无关。 */
  invokedSkills?: string[];
}

/**
 * Cache isolation identity. Every cache that can contain retrieved workspace
 * data must bind its key to this complete permission context.
 */
export interface AiPermissionContext {
  actor: string;
  role: string;
  scopeId: string;
  permissionVersion: string;
  contentVersion: string;
  /** Vault-relative paths available to the current AI operation. */
  allowedPaths?: readonly string[];
}

export interface AiContextBlock {
  id: string;
  source: 'system' | 'tool' | 'memory' | 'retrieval' | 'history' | 'attachment' | 'external';
  content: string;
  trusted: boolean;
  permitted: boolean;
  citationId?: string;
  metadata?: Record<string, unknown>;
  truncated?: boolean;
  compressed?: boolean;
}

export interface AiToolDescriptor {
  name: string;
  kind: AgentToolKind;
  description?: string;
  riskLevel: AiRiskLevel;
  inputSchema: Record<string, unknown>;
  timeoutMs: number;
  supportsUndo: boolean;
  idempotent: boolean;
}

export interface AiRunEvent {
  runId: string;
  sequence: number;
  at: string;
  type: 'status' | 'delta' | 'reasoning' | 'tool_call' | 'tool_result' | 'confirmation' | 'citation' | 'error' | 'done';
  status?: AiRunStatus;
  text?: string;
  call?: AgentToolCall;
  tool?: AiToolDescriptor;
  payload?: Record<string, unknown>;
  metrics?: AiRunMetrics;
}

export type AiRunTerminationReason = 'completed' | 'error' | 'cancelled' | 'budget_exceeded';

export interface AiRunMetrics {
  startedAt: string;
  firstTokenAt?: string;
  timeToFirstTokenMs?: number;
  durationMs: number;
  toolCalls: number;
  toolDurationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  terminationReason?: AiRunTerminationReason;
}

export interface AiRunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  durationMs: number;
}

export interface AiRunResult {
  runId: string;
  status: Extract<AiRunStatus, 'completed' | 'waiting_confirmation' | 'failed' | 'cancelled' | 'budget_exceeded'>;
  answer?: string;
  pendingCalls?: AgentToolCall[];
  citations?: Array<Record<string, unknown>>;
  usage: AiRunUsage;
  error?: { code: string; message: string; retryable: boolean };
}

export function createRunId(): string {
  return `run-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`;
}

export function isUntrustedContextBlock(block: AiContextBlock): boolean {
  return block.trusted === false || block.source === 'retrieval' || block.source === 'attachment' || block.source === 'external';
}

