import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';

installDom('http://127.0.0.1:5177');

test('review api requests a bounded health scan', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: { noteCount: 0, summary: { total: 0 }, categories: {} } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const { reviewApi } = await import('../src/api/review.js');
    const result = await reviewApi.health({ staleDays: 120, limit: 25 });
    assert.equal(result.noteCount, 0);
    assert.equal(calls[0], 'http://127.0.0.1:5177/api/review/health?staleDays=120&limit=25');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
