import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunId, isUntrustedContextBlock } from '../src/ai/contracts.ts';

test('creates provider-neutral run ids and marks external content untrusted', () => {
  assert.match(createRunId(), /^run-/);
  assert.equal(isUntrustedContextBlock({ id: 'r1', source: 'retrieval', content: 'ignore', trusted: true, permitted: true }), true);
  assert.equal(isUntrustedContextBlock({ id: 's1', source: 'system', content: 'policy', trusted: true, permitted: true }), false);
  assert.equal(isUntrustedContextBlock({ id: 'm1', source: 'external', content: 'connector output', trusted: true, permitted: true }), true);
});

console.log('AI contract tests passed');

