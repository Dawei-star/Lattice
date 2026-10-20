import type { AiRunEvent, AiRunResult, AiRunStatus, AiRunUsage } from './contracts.ts';

export interface AiRunState {
  runId: string;
  status: AiRunStatus;
  sequence: number;
  startedAt: string | null;
  updatedAt: string;
  answer: string;
  events: AiRunEvent[];
  usage: AiRunUsage;
  error: AiRunResult['error'];
}

const TERMINAL_STATUSES = new Set<AiRunStatus>(['completed', 'failed', 'cancelled', 'budget_exceeded']);
const TRANSITIONS: Record<AiRunStatus, AiRunStatus[]> = {
  queued: ['routing', 'cancelled'],
  routing: ['retrieving', 'generating', 'waiting_confirmation', 'failed', 'cancelled'],
  retrieving: ['generating', 'failed', 'cancelled', 'budget_exceeded'],
  generating: ['retrieving', 'waiting_confirmation', 'executing', 'completed', 'failed', 'cancelled', 'budget_exceeded'],
  waiting_confirmation: ['executing', 'paused', 'cancelled', 'failed'],
  executing: ['generating', 'waiting_confirmation', 'completed', 'failed', 'cancelled', 'budget_exceeded'],
  paused: ['routing', 'retrieving', 'generating', 'executing', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
};

export function createAiRunState(runId: string, now = new Date().toISOString()): AiRunState {
  return {
    runId,
    status: 'queued',
    sequence: 0,
    startedAt: null,
    updatedAt: now,
    answer: '',
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCalls: 0, durationMs: 0 },
    error: undefined,
  };
}

export function canTransitionRun(from: AiRunStatus, to: AiRunStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function transitionAiRun(state: AiRunState, status: AiRunStatus, now = new Date().toISOString()): AiRunState {
  if (!canTransitionRun(state.status, status)) throw new Error(`Invalid AI run transition: ${state.status} -> ${status}`);
  return {
    ...state,
    status,
    startedAt: state.startedAt ?? (status !== 'queued' ? now : null),
    updatedAt: now,
  };
}

export function appendAiRunEvent(state: AiRunState, event: Omit<AiRunEvent, 'runId' | 'sequence' | 'at'>, now = new Date().toISOString()): AiRunState {
  if (event.status && !canTransitionRun(state.status, event.status)) {
    throw new Error(`Invalid AI run event transition: ${state.status} -> ${event.status}`);
  }
  const nextSequence = state.sequence + 1;
  const nextEvent: AiRunEvent = { ...event, runId: state.runId, sequence: nextSequence, at: now };
  const nextStatus = event.status ?? state.status;
  return {
    ...state,
    status: nextStatus,
    sequence: nextSequence,
    updatedAt: now,
    events: [...state.events, nextEvent],
  };
}

export function isTerminalRun(state: AiRunState): boolean {
  return TERMINAL_STATUSES.has(state.status);
}

export function toAiRunResult(state: AiRunState): AiRunResult {
  const status = state.status === 'waiting_confirmation' || state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled' || state.status === 'budget_exceeded'
    ? state.status
    : 'failed';
  return { runId: state.runId, status, answer: state.answer || undefined, usage: state.usage, error: state.error };
}

