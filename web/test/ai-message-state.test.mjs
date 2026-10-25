import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAiMessage, attachRegenerateVariant, restoreAiMessages, switchMessageVariant } from '../src/ai/ai-message-state.ts';

const welcome = { id: 'ai-welcome', role: 'assistant', content: '欢迎' };

test('removes the placeholder welcome message when the first real message is appended', () => {
  const user = { id: 'user-1', role: 'user', content: '你好' };
  assert.deepEqual(appendAiMessage([welcome], user, welcome.id), [user]);
});

test('does not let an empty or failed session restore erase messages already sent', () => {
  const user = { id: 'user-1', role: 'user', content: '你好' };
  assert.deepEqual(restoreAiMessages([user], [], welcome), [user]);
  assert.deepEqual(restoreAiMessages([user], [{ id: 'remote-1', role: 'assistant', content: '旧回复' }], welcome), [user]);
});

test('restores a saved conversation when the current view is still the welcome state', () => {
  const restored = { id: 'remote-1', role: 'assistant', content: '旧回复' };
  assert.deepEqual(restoreAiMessages([welcome], [restored], welcome), [restored]);
});

// --- U3 变体切换（会话内存）-----------------------------------------------------
test('regenerate keeps the replaced answer as a variant and shows the newest', () => {
  const first = { id: 'a-1', content: '版本一' };
  const second = { id: 'a-2', content: '版本二' };
  const group = attachRegenerateVariant(undefined, first, second);
  assert.deepEqual(group.variants.map((item) => item.id), ['a-1', 'a-2']);
  assert.equal(group.variantIndex, 1, '新回答为当前显示版本');

  const third = { id: 'a-3', content: '版本三' };
  const grown = attachRegenerateVariant(group.variants, second, third);
  assert.deepEqual(grown.variants.map((item) => item.id), ['a-1', 'a-2', 'a-3'], '旧变体链随替换延续');
  assert.equal(grown.variantIndex, 2);
});

test('switching variants shares the group and stamps the displayed index', () => {
  const group = [{ id: 'a-1', content: '版本一' }, { id: 'a-2', content: '版本二' }];
  const displayed = switchMessageVariant(group, 0);
  assert.equal(displayed.id, 'a-1');
  assert.equal(displayed.variantIndex, 0);
  assert.equal(switchMessageVariant(group, 5), null);
  assert.equal(switchMessageVariant([], 0), null);
});

console.log('AI message state tests passed');
