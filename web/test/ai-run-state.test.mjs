import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAiRunEvent, canTransitionRun, createAiRunState, isTerminalRun, transitionAiRun } from '../src/ai/run-state.ts';

test('enforces the AI run lifecycle and sequences events', () => {
  let state = createAiRunState('run-test', '2026-10-16T00:00:00.000Z');
  state = transitionAiRun(state, 'routing', '2026-10-16T00:00:01.000Z');
  state = appendAiRunEvent(state, { type: 'status', status: 'generating', text: '生成中' }, '2026-10-16T00:00:02.000Z');
  state = appendAiRunEvent(state, { type: 'delta', text: '完成' }, '2026-10-16T00:00:03.000Z');
  assert.equal(state.status, 'generating');
  assert.equal(state.sequence, 2);
  assert.equal(state.events[0].sequence, 1);
  assert.equal(state.events[1].sequence, 2);
  assert.equal(state.startedAt, '2026-10-16T00:00:01.000Z');
  assert.equal(canTransitionRun('generating', 'completed'), true);
  assert.equal(canTransitionRun('completed', 'generating'), false);
});

test('rejects invalid transitions and recognizes terminal states', () => {
  const state = createAiRunState('run-test');
  assert.throws(() => transitionAiRun(state, 'completed'), /Invalid AI run transition/);
  const completed = transitionAiRun(transitionAiRun(state, 'routing'), 'generating');
  const terminal = transitionAiRun(completed, 'completed');
  assert.equal(isTerminalRun(terminal), true);
  assert.throws(() => transitionAiRun(terminal, 'failed'), /Invalid AI run transition/);
  assert.throws(() => appendAiRunEvent(terminal, { type: 'status', status: 'generating' }), /Invalid AI run event transition/);
});

console.log('AI run state tests passed');

