import assert from 'node:assert/strict';
import { clearAiRunTrace, readAiRunTrace, recordAiRunTraceEvent } from '../src/ai/run-trace-store.ts';

globalThis.localStorage = {
  value: new Map(),
  getItem(key) { return this.value.get(key) ?? null; },
  setItem(key, value) { this.value.set(key, String(value)); },
  removeItem(key) { this.value.delete(key); },
};

clearAiRunTrace();
recordAiRunTraceEvent({ runId: 'run-1', sequence: 1, eventType: 'tool_result', model: 'small', metadata: { ok: true, durationMs: 12, content: 'secret-not-stored' } });
const events = readAiRunTrace('run-1');
assert.equal(events.length, 1);
assert.equal(events[0].metadata?.durationMs, 12);
assert.equal(events[0].metadata?.content, undefined);
clearAiRunTrace();
console.log('AI trace store tests passed');

