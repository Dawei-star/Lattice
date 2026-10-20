import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IPC_ROUTES } from '../src/api/ipc-routes.ts';
import { createTauriDurableRunTransport } from '../src/ai/providers/tauri-provider.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const rust = readFileSync(resolve(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');

test('desktop provider connectivity test has a registered IPC command', () => {
  const route = IPC_ROUTES.find((item) => item.method === 'POST' && item.path === '/ai/test');
  assert.ok(route, '桌面端缺少 /ai/test IPC 映射');
  assert.equal(route.command, 'ai_provider_test');
  assert.match(rust, /\bai_provider_test\b/);
  assert.match(rust, /generate_handler!\[[\s\S]*\bai_provider_test\b/);
});

test('durable desktop transport enqueues and replays persisted events', async () => {
  const calls = [];
  const emitted = [];
  const transport = createTauriDurableRunTransport({
    pollIntervalMs: 0,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'ai_run_enqueue') return { id: 'job-1', status: 'queued' };
      if (command === 'ai_run_events') return [
        { runId: args.runId, sequence: 1, payload: { type: 'delta', text: '已恢复' } },
        { runId: args.runId, sequence: 2, payload: { type: 'done', payload: { text: '已恢复' } } },
      ];
      throw new Error(`unexpected command: ${command}`);
    },
  });

  const result = await transport.stream({ runId: 'run-1', message: '继续任务' }, { onEvent: (event) => emitted.push(event) });

  assert.deepEqual(result, { text: '已恢复' });
  assert.equal(calls[0].command, 'ai_run_enqueue');
  assert.equal(calls[1].command, 'ai_run_events');
  assert.deepEqual(emitted.map((event) => event.type), ['delta', 'done']);
});

test('durable desktop transport resumes an existing run with its request', async () => {
  const calls = [];
  const transport = createTauriDurableRunTransport({
    pollIntervalMs: 0,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'ai_run_resume') return { id: 'job-2', status: 'queued' };
      if (command === 'ai_run_events') return [{
        runId: args.runId,
        sequence: 3,
        payload: { type: 'done', payload: { text: '恢复完成' } },
      }];
      throw new Error(`unexpected command: ${command}`);
    },
  });

  const request = { runId: 'run-2', resumeRun: true, message: '继续' };
  const result = await transport.stream(request);

  assert.deepEqual(result, { text: '恢复完成' });
  assert.equal(calls[0].command, 'ai_run_resume');
  assert.deepEqual(calls[0].args, { runId: 'run-2', request });
  assert.equal(calls[1].command, 'ai_run_events');
});
