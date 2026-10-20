import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntentDecision, parseRerankDecision } from '../src/ai/small-model.ts';

test('accepts only bounded intent JSON', () => {
  const decision = parseIntentDecision({ text: '{"intents":["search","invalid"],"confidence":0.9,"modelTier":"fast","requiresClarification":false}' });
  assert.deepEqual(decision.intents, ['search']);
  assert.equal(decision.modelTier, 'fast');
  assert.equal(parseIntentDecision({ text: 'not json' }), null);
  assert.equal(parseIntentDecision({ text: '{"intents":["search"],"confidence":2,"modelTier":"fast"}' }).confidence, 1);
});

test('rerank only returns candidate ids from the supplied set', () => {
  const candidates = [
    { id: 'a', title: 'A', excerpt: 'short', score: 0.2 },
    { id: 'b', title: 'B', excerpt: 'short', score: 0.1 },
  ];
  assert.deepEqual(parseRerankDecision({ text: '{"order":["b","unknown","b","a"]}' }, candidates), ['b', 'a']);
  assert.equal(parseRerankDecision({ text: '{"order":["unknown"]}' }, candidates), null);
});
