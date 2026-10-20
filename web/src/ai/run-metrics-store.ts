import type { AiRunMetrics, AiRunTerminationReason } from './contracts.ts';
import { aiStorageKey } from './storage.ts';

export type AiMetricTaskType = 'quick' | 'retrieval' | 'agent';

export interface AiRunMetricRecord {
  runId: string;
  taskType: AiMetricTaskType;
  model: string;
  provider: string;
  recordedAt: string;
  metrics: AiRunMetrics;
  terminationReason: AiRunTerminationReason;
}

export interface AiMetricSummary {
  requests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  costKnown: boolean;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  ttftP50Ms: number | null;
  byTask: Array<{ taskType: AiMetricTaskType; requests: number; totalTokens: number; durationP50Ms: number | null; ttftP50Ms: number | null }>;
  byModel: Array<{ model: string; requests: number; totalTokens: number; estimatedCostUsd: number; costKnown: boolean }>;
}

const STORAGE_KEY = 'lattice-ai-run-metrics-v1';
const MAX_RECORDS = 500;

function storage() {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function key(namespace?: string | null): string {
  return namespace ? aiStorageKey(STORAGE_KEY, namespace) : STORAGE_KEY;
}

export function readAiRunMetrics(namespace?: string | null): AiRunMetricRecord[] {
  const target = storage();
  if (!target) return [];
  try {
    const value = JSON.parse(target.getItem(key(namespace)) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is AiRunMetricRecord => Boolean(item && typeof item === 'object' && typeof item.runId === 'string' && item.metrics && typeof item.metrics === 'object')).slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}

export function recordAiRunMetric(input: {
  runId: string;
  taskType: AiMetricTaskType;
  model?: string | null;
  provider?: string | null;
  metrics: AiRunMetrics;
  storageNamespace?: string | null;
}): AiRunMetricRecord {
  const record: AiRunMetricRecord = {
    runId: input.runId,
    taskType: input.taskType,
    model: input.model?.trim() || 'local',
    provider: input.provider?.trim() || 'local',
    recordedAt: new Date().toISOString(),
    metrics: input.metrics,
    terminationReason: input.metrics.terminationReason ?? 'completed',
  };
  const target = storage();
  if (target) {
    const next = [...readAiRunMetrics(input.storageNamespace).filter((item) => item.runId !== record.runId), record].slice(-MAX_RECORDS);
    try { target.setItem(key(input.storageNamespace), JSON.stringify(next)); } catch { /* metrics are best effort */ }
  }
  return record;
}

export function clearAiRunMetrics(namespace?: string | null): void {
  const target = storage();
  if (target) target.removeItem(key(namespace));
}

function percentile(values: number[], fraction: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

export function summarizeAiRunMetrics(records?: AiRunMetricRecord[], namespace?: string | null): AiMetricSummary {
  const source = records ?? readAiRunMetrics(namespace);
  records = source;
  const promptTokens = records.reduce((sum, item) => sum + (item.metrics.promptTokens ?? 0), 0);
  const completionTokens = records.reduce((sum, item) => sum + (item.metrics.completionTokens ?? 0), 0);
  const totalTokens = records.reduce((sum, item) => sum + (item.metrics.totalTokens ?? 0), 0);
  const costs = records.map((item) => item.metrics.estimatedCostUsd).filter((value): value is number => Number.isFinite(value));
  const byTask = [...new Set(records.map((item) => item.taskType))].map((taskType) => {
    const rows = records.filter((item) => item.taskType === taskType);
    return {
      taskType,
      requests: rows.length,
      totalTokens: rows.reduce((sum, item) => sum + (item.metrics.totalTokens ?? 0), 0),
      durationP50Ms: percentile(rows.map((item) => item.metrics.durationMs), .5),
      ttftP50Ms: percentile(rows.map((item) => item.metrics.timeToFirstTokenMs ?? NaN), .5),
    };
  });
  const byModel = [...new Set(records.map((item) => item.model))].map((model) => {
    const rows = records.filter((item) => item.model === model);
    const rowCosts = rows.map((item) => item.metrics.estimatedCostUsd).filter((value): value is number => Number.isFinite(value));
    return {
      model,
      requests: rows.length,
      totalTokens: rows.reduce((sum, item) => sum + (item.metrics.totalTokens ?? 0), 0),
      estimatedCostUsd: rowCosts.reduce((sum, value) => sum + value, 0),
      costKnown: rowCosts.length === rows.length,
    };
  });
  return {
    requests: records.length,
    totalTokens,
    promptTokens,
    completionTokens,
    estimatedCostUsd: costs.reduce((sum, value) => sum + value, 0),
    costKnown: costs.length === records.length && records.length > 0,
    durationP50Ms: percentile(records.map((item) => item.metrics.durationMs), .5),
    durationP95Ms: percentile(records.map((item) => item.metrics.durationMs), .95),
    ttftP50Ms: percentile(records.map((item) => item.metrics.timeToFirstTokenMs ?? NaN), .5),
    byTask,
    byModel,
  };
}

