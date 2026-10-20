import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStreamAdapter } from '../src/ai/ai-stream-adapter.ts';

test('normalizes provider events and preserves event order', async () => {
  const events = [];
  const adapter = createAiStreamAdapter(async (_input, options) => {
    options?.onEvent?.({ type: 'delta', text: 'A' });
    options?.onEvent?.({ type: 'round', round: 2 });
    return { text: 'A' };
  }, { runId: 'run-1', onEvent: (event) => events.push(event) });
  await adapter.start({ message: 'x' });
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal(events[0].runId, 'run-1');
  assert.equal(events[0].type, 'delta');
  assert.equal(events[1].type, 'status');
  assert.equal(events[0].metrics.toolCalls, 0);
  assert.equal(events[0].metrics.timeToFirstTokenMs >= 0, true);
  assert.equal(events[1].metrics.terminationReason, undefined);
});

test('records tool timings and terminal reason in the standard event contract', async () => {
  const events = [];
  const adapter = createAiStreamAdapter(async (_input, options) => {
    options?.onEvent?.({ type: 'tool_call', payload: { callId: 'c1' } });
    options?.onEvent?.({ type: 'tool_result', payload: { callId: 'c1', durationMs: 42 } });
    options?.onEvent?.({ type: 'done', payload: { terminationReason: 'budget_exceeded' } });
    return { text: '' };
  }, { runId: 'run-2', onEvent: (event) => events.push(event) });
  await adapter.start({ message: 'x' });
  assert.equal(events[0].metrics.toolCalls, 1);
  assert.equal(events[1].metrics.toolDurationMs, 42);
  assert.equal(events[2].metrics.terminationReason, 'budget_exceeded');
  assert.equal(events[2].metrics.durationMs >= 0, true);
});

test('preserves a structured provider tool call in the runtime event contract', async () => {
  const events = [];
  const call = { id: 'call-1', name: 'read_note', input: { path: 'Notes/a.md' } };
  const adapter = createAiStreamAdapter(async (_input, options) => {
    options?.onEvent?.({ type: 'tool_call', call, payload: { call } });
    return { text: '', toolCalls: [call] };
  }, { runId: 'run-tool', onEvent: (event) => events.push(event) });
  await adapter.start({ message: 'read' });
  assert.deepEqual(events[0].call, call);
  assert.deepEqual(events[0].payload.call, call);
});

console.log('AI stream adapter tests passed');

