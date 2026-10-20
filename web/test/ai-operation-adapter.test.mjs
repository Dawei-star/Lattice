import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiOperationAdapter } from '../src/ai/ai-operation-adapter.ts';

test('unwraps both HTTP envelopes and direct IPC values consistently', async () => {
  const adapter = createAiOperationAdapter({
    preview: async () => ({ data: { planHash: 'p1' } }),
    execute: async () => ({ operationId: 'op-1' }),
    undo: async () => ({ data: { undone: true } }),
  });
  assert.deepEqual(await adapter.preview('x'), { planHash: 'p1' });
  assert.deepEqual(await adapter.execute('x'), { operationId: 'op-1' });
  assert.deepEqual(await adapter.undo('op-1'), { undone: true });
});

console.log('AI operation adapter tests passed');

