import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiSessionStore } from '../src/ai/ai-session-store.ts';

test('keeps session CRUD and loading state outside React components', async () => {
  const calls = [];
  const store = createAiSessionStore({
    list: async () => [{ id: 's1', title: '第一轮' }],
    messages: async () => [{ id: 'm1', role: 'user', content: '你好' }],
    create: async () => ({ id: 's2' }),
    rename: async (id, title) => calls.push(['rename', id, title]),
    remove: async (id) => calls.push(['remove', id]),
  });
  await store.refresh();
  assert.equal(store.getState().rows[0].id, 's1');
  await store.select('s1');
  assert.equal(store.getState().messages[0].content, '你好');
  await store.create();
  await store.rename('s1', '已重命名');
  await store.remove('s1');
  assert.deepEqual(calls, [['rename', 's1', '已重命名'], ['remove', 's1']]);
  assert.equal(store.getState().currentId, 's2');
});

console.log('AI session store tests passed');

