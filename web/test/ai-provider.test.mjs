import assert from 'node:assert/strict';
import { createHttpAiProvider } from '../src/ai/providers/http-provider.ts';
import { createTauriAiProvider, createTauriDurableRunClient, createTauriDurableRunTransport, createTauriEventStreamTransport } from '../src/ai/providers/tauri-provider.ts';

const request = { runId: 'run-1', message: 'hello' };
const expected = { text: 'ok' };
const http = createHttpAiProvider({ stream: async (input, options) => { options?.onEvent?.({ type: 'done', payload: expected }); return expected; } });
assert.equal((await http.stream(request)).text, 'ok');

const tauri = createTauriAiProvider({ stream: async (input) => ({ text: input.message }) });
assert.equal((await tauri.stream(request)).text, 'hello');

let eventHandler;
let eventName;
const calls = [];
const transport = createTauriEventStreamTransport({
  subscribe: async (name, handler) => { eventName = name; eventHandler = handler; return () => {}; },
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'ai_chat_stream') eventHandler({ payload: { type: 'done', payload: expected } });
  },
});
assert.deepEqual(await transport.stream(request), expected);
assert.equal(eventName, 'ai://stream/run-1');
assert.equal(calls[0].command, 'ai_chat_stream');
assert.deepEqual(calls[0].args, { request });

const abort = new AbortController();
let cancelCalled = false;
const cancelledTransport = createTauriEventStreamTransport({
  subscribe: async () => () => {},
  invoke: async (command) => {
    if (command === 'ai_chat_stream') abort.abort();
    if (command === 'ai_chat_cancel') cancelCalled = true;
  },
});
assert.deepEqual(await cancelledTransport.stream(request, { signal: abort.signal }), { cancelled: true });
assert.equal(cancelCalled, true);

const durableCalls = [];
const durable = createTauriDurableRunClient({
  invoke: async (command, args) => { durableCalls.push({ command, args }); return { id: 'job-1' }; },
});
await durable.enqueue(request);
await durable.events('run-1', 3, 20);
await durable.checkpoint('run-1', { stage: 'tool_execution', completedSteps: [] });
await durable.cancel('run-1');
await durable.resume('run-1', request);
assert.deepEqual(durableCalls, [
  { command: 'ai_run_enqueue', args: { request } },
  { command: 'ai_run_events', args: { runId: 'run-1', afterSequence: 3, limit: 20 } },
  { command: 'ai_run_checkpoint', args: { runId: 'run-1', checkpoint: { stage: 'tool_execution', completedSteps: [] } } },
  { command: 'ai_run_cancel', args: { runId: 'run-1' } },
  { command: 'ai_run_resume', args: { runId: 'run-1', request } },
]);

const durableStreamCalls = [];
const durableStreamEvents = [
  { runId: 'run-2', sequence: 1, eventType: 'status', payload: { type: 'status', text: '排队中' } },
  { runId: 'run-2', sequence: 2, eventType: 'delta', payload: { type: 'delta', text: 'hello' } },
  { runId: 'run-2', sequence: 3, eventType: 'done', payload: { type: 'done', payload: { text: 'hello' } } },
];
const durableTransport = createTauriDurableRunTransport({
  pollIntervalMs: 0,
  invoke: async (command, args) => {
    durableStreamCalls.push({ command, args });
    if (command === 'ai_run_events') return durableStreamEvents.filter((event) => event.sequence > args.afterSequence);
    if (command === 'ai_run_get') return { status: 'running' };
    return { id: 'job-2', status: 'queued' };
  },
});
const replayed = [];
assert.deepEqual(await durableTransport.stream({ ...request, runId: 'run-2' }, { onEvent: (event) => replayed.push(event) }), { text: 'hello' });
assert.deepEqual(replayed.map((event) => event.type), ['status', 'delta', 'done']);
assert.equal(durableStreamCalls[0].command, 'ai_run_enqueue');
assert.equal(durableStreamCalls[1].command, 'ai_run_events');

const resumedStreamCalls = [];
const resumedTransport = createTauriDurableRunTransport({
  pollIntervalMs: 0,
  invoke: async (command, args) => {
    resumedStreamCalls.push({ command, args });
    if (command === 'ai_run_events') return [{ sequence: 1, payload: { type: 'done', payload: { text: 'resumed' } } }];
    if (command === 'ai_run_get') return { status: 'completed' };
    return { id: 'job-resumed', status: 'queued' };
  },
});
assert.deepEqual(await resumedTransport.stream({ ...request, runId: 'run-resumed', resumeRun: true }), { text: 'resumed' });
assert.equal(resumedStreamCalls[0].command, 'ai_run_resume');
assert.deepEqual(resumedStreamCalls[0].args, { runId: 'run-resumed', request: { ...request, runId: 'run-resumed', resumeRun: true } });

const failingTransport = createTauriDurableRunTransport({
  pollIntervalMs: 0,
  invoke: async (command) => {
    if (command === 'ai_run_events') return [{ sequence: 1, payload: { type: 'error', message: 'model unavailable' } }];
    if (command === 'ai_run_get') return { status: 'failed', error: '后台任务失败' };
    return { id: 'job-3', status: 'queued' };
  },
});
await assert.rejects(() => failingTransport.stream({ ...request, runId: 'run-3' }), /model unavailable/);

const abortController = new AbortController();
let durableCancelCalled = false;
const cancellableTransport = createTauriDurableRunTransport({
  pollIntervalMs: 0,
  invoke: async (command) => {
    if (command === 'ai_run_events') return [];
    if (command === 'ai_run_get') {
      abortController.abort();
      return { status: 'running' };
    }
    if (command === 'ai_run_cancel') durableCancelCalled = true;
    return { id: 'job-4', status: 'queued' };
  },
});
assert.deepEqual(await cancellableTransport.stream({ ...request, runId: 'run-4' }, { signal: abortController.signal }), { cancelled: true });
assert.equal(durableCancelCalled, true);
console.log('AI provider tests passed');
