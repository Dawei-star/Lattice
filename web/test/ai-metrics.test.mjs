import assert from 'node:assert/strict';
import { clearAiRunMetrics, recordAiRunMetric, summarizeAiRunMetrics } from '../src/ai/run-metrics-store.ts';

globalThis.localStorage = {
  value: new Map(),
  getItem(key) { return this.value.get(key) ?? null; },
  setItem(key, value) { this.value.set(key, String(value)); },
  removeItem(key) { this.value.delete(key); },
};

clearAiRunMetrics();
recordAiRunMetric({ runId: 'run-1', taskType: 'quick', model: 'small', metrics: { startedAt: '2026-01-01T00:00:00.000Z', durationMs: 100, timeToFirstTokenMs: 20, toolCalls: 0, toolDurationMs: 0, promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.01 } });
recordAiRunMetric({ runId: 'run-2', taskType: 'agent', model: 'large', metrics: { startedAt: '2026-01-01T00:00:00.000Z', durationMs: 300, timeToFirstTokenMs: 80, toolCalls: 2, toolDurationMs: 40, promptTokens: 20, completionTokens: 10, totalTokens: 30, terminationReason: 'budget_exceeded' } });
const summary = summarizeAiRunMetrics();
assert.equal(summary.requests, 2);
assert.equal(summary.totalTokens, 45);
assert.equal(summary.promptTokens, 30);
assert.equal(summary.byTask.find((item) => item.taskType === 'agent')?.requests, 1);
assert.equal(summary.costKnown, false);
clearAiRunMetrics();
console.log('AI metrics store tests passed');

