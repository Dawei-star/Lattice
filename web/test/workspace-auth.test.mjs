import assert from 'node:assert/strict';

const storage = new Map();
const session = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
});
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key) => session.get(key) ?? null,
    setItem: (key, value) => session.set(key, String(value)),
    removeItem: (key) => session.delete(key),
  },
});

const { getWorkspaceAccessToken, workspaceHeaders } = await import('../src/api/workspace-auth.js');

storage.set('lattice-ai-settings-v1', JSON.stringify({ accessToken: '  workspace-token-1234567890  ' }));
assert.equal(getWorkspaceAccessToken(), 'workspace-token-1234567890');
assert.equal(JSON.parse(session.get('lattice-ai-session-v1')).accessToken, 'workspace-token-1234567890');
assert.equal(JSON.parse(storage.get('lattice-ai-settings-v1')).accessToken, '');
assert.deepEqual(workspaceHeaders({ Authorization: 'Bearer ai-token' }), {
  Authorization: 'Bearer ai-token',
  'X-Workspace-Token': 'workspace-token-1234567890',
});

session.clear();
storage.set('lattice-ai-settings-v1', '{invalid');
assert.equal(getWorkspaceAccessToken(), '');
assert.deepEqual(workspaceHeaders({ Accept: 'application/json' }), { Accept: 'application/json' });

console.log('workspace-auth.test.mjs: PASS');
