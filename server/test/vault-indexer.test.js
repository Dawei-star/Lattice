import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildProjection } from '../src/vault/indexer.js';

test('rebuildProjection exposes the expected contract', () => {
  assert.equal(typeof rebuildProjection, 'function');
});
