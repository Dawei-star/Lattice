import type { AiMetricTaskType } from './run-metrics-store.ts';
import { aiStorageKey } from './storage.ts';

export type AiTraceEventType = 'run_started' | 'status' | 'delta' | 'reasoning' | 'tool_call' | 'tool_result' | 'confirmation' | 'citation' | 'error' | 'done' | 'run_finished';

export interface AiRunTraceEvent {
  runId: string;
  sequence: number;
  eventType: AiTraceEventType;
  taskType?: AiMetricTaskType;
  model?: string;
  at: string;
  metadata?: Record<string, string | number | boolean | null>;
}

const STORAGE_KEY = 'lattice-ai-run-trace-v1';
const MAX_EVENTS = 4_000;
const FLUSH_DELAY_MS = 150;
const pending = new Map<string, AiRunTraceEvent[]>();
const flushTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

function key(namespace?: string | null): string {
  return namespace ? aiStorageKey(STORAGE_KEY, namespace) : STORAGE_KEY;
}

function read(namespace?: string | null): AiRunTraceEvent[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(key(namespace)) ?? '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item.runId === 'string').slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

function persist(namespace: string | null | undefined, events: AiRunTraceEvent[]): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key(namespace), JSON.stringify([...read(namespace), ...events].slice(-MAX_EVENTS))); } catch { /* trace is best effort */ }
}

function flush(namespace?: string | null): void {
  const storageKey = key(namespace);
  const events = pending.get(storageKey);
  if (!events?.length) return;
  pending.delete(storageKey);
  persist(namespace, events);
}

function scheduleFlush(namespace?: string | null): void {
  const storageKey = key(namespace);
  if (flushTimers.has(storageKey)) return;
  const timer = globalThis.setTimeout(() => {
    flushTimers.delete(storageKey);
    flush(namespace);
  }, FLUSH_DELAY_MS);
  flushTimers.set(storageKey, timer);
}

function safeMetadata(event: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!event) return undefined;
  const allowed = [
    'status', 'durationMs', 'timeToFirstTokenMs', 'toolDurationMs',
    'promptTokens', 'completionTokens', 'totalTokens', 'toolCalls',
    'ok', 'tool', 'server', 'terminationReason', 'errorKind', 'citationCount', 'stepCount',
  ];
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of allowed) {
    const value = event[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}

export function recordAiRunTraceEvent(input: {
  runId: string;
  sequence: number;
  eventType: AiTraceEventType;
  taskType?: AiMetricTaskType;
  model?: string | null;
  metadata?: Record<string, unknown>;
  storageNamespace?: string | null;
}): AiRunTraceEvent {
  const metadata = safeMetadata(input.metadata);
  const event: AiRunTraceEvent = {
    runId: input.runId,
    sequence: input.sequence,
    eventType: input.eventType,
    ...(input.taskType ? { taskType: input.taskType } : {}),
    ...(input.model ? { model: input.model } : {}),
    at: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
  if (event.eventType === 'delta' || event.eventType === 'reasoning') {
    const storageKey = key(input.storageNamespace);
    pending.set(storageKey, [...(pending.get(storageKey) ?? []), event].slice(-MAX_EVENTS));
    scheduleFlush(input.storageNamespace);
  } else {
    flush(input.storageNamespace);
    persist(input.storageNamespace, [event]);
  }
  return event;
}

export function readAiRunTrace(runId?: string, namespace?: string | null): AiRunTraceEvent[] {
  flush(namespace);
  const events = read(namespace);
  return runId ? events.filter((event) => event.runId === runId) : events;
}

export function clearAiRunTrace(namespace?: string | null): void {
  const storageKey = key(namespace);
  const timer = flushTimers.get(storageKey);
  if (timer) globalThis.clearTimeout(timer);
  flushTimers.delete(storageKey);
  pending.delete(storageKey);
  if (typeof localStorage !== 'undefined') localStorage.removeItem(storageKey);
}

