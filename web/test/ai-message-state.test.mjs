import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAiMessage, restoreAiMessages } from '../src/ai/ai-message-state.ts';

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

console.log('AI message state tests passed');
