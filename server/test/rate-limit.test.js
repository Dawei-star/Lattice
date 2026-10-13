import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/middleware/rateLimit.js';

function responseDouble() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) { headers.set(name, String(value)); },
  };
}

test('rate limiter returns quota headers and rejects after the fixed window quota', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, key: 'test' });
  const req = { socket: { remoteAddress: '127.0.0.1' }, get: () => undefined };

  const firstResponse = responseDouble();
  let firstError = null;
  limiter(req, firstResponse, (error = null) => { firstError = error; });
  assert.equal(firstError, null);
  assert.equal(firstResponse.headers.get('X-RateLimit-Remaining'), '1');

  const secondResponse = responseDouble();
  let secondError = null;
  limiter(req, secondResponse, (error = null) => { secondError = error; });
  assert.equal(secondError, null);
  assert.equal(secondResponse.headers.get('X-RateLimit-Remaining'), '0');

  const thirdResponse = responseDouble();
  let thirdError = null;
  limiter(req, thirdResponse, (error) => { thirdError = error; });
  assert.equal(thirdError?.code, 'RATE_LIMITED');
  assert.equal(thirdResponse.headers.get('Retry-After'), '60');
  assert.equal(thirdResponse.headers.get('X-RateLimit-Limit'), '2');
});
