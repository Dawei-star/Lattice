import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiRetrievalCacheKey, createAiRetrievalCache } from '../src/ai/retrieval-cache.ts';

const permission = {
  actor: 'user-1',
  role: 'editor',
  scopeId: 'project-a',
  permissionVersion: 'acl-1',
  contentVersion: 'content-1',
};

const request = {
  query: '权限过滤',
  queries: ['权限过滤', '权限内容'],
  limit: 12,
  allowedPaths: ['b.md', 'a.md'],
  permissionContext: permission,
};

test('retrieval cache key includes permission and content identity', () => {
  const base = buildAiRetrievalCacheKey(request);
  assert.equal(base, buildAiRetrievalCacheKey({ ...request, allowedPaths: ['a.md', 'b.md'] }));
  assert.notEqual(base, buildAiRetrievalCacheKey({ ...request, permissionContext: { ...permission, role: 'viewer' } }));
  assert.notEqual(base, buildAiRetrievalCacheKey({ ...request, permissionContext: { ...permission, permissionVersion: 'acl-2' } }));
  assert.notEqual(base, buildAiRetrievalCacheKey({ ...request, permissionContext: { ...permission, contentVersion: 'content-2' } }));
});

test('retrieval cache expires and coalesces concurrent reads', async () => {
  let clock = 1000;
  let loads = 0;
  const cache = createAiRetrievalCache({ ttlMs: 50, now: () => clock });
  const loader = async () => {
    loads += 1;
    await Promise.resolve();
    return { blocks: ['allowed'] };
  };
  const [first, second] = await Promise.all([cache.run(request, loader), cache.run(request, loader)]);
  assert.deepEqual(first, second);
  assert.equal(loads, 1);
  assert.deepEqual(await cache.run(request, loader), { blocks: ['allowed'] });
  assert.equal(loads, 1);
  clock += 51;
  assert.deepEqual(await cache.run(request, loader), { blocks: ['allowed'] });
  assert.equal(loads, 2);
});

console.log('AI retrieval cache tests passed');
