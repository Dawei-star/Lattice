import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVaultRelativePath, resolveVaultPath } from '../src/vault/path.js';

test('normalizeVaultRelativePath accepts nested markdown paths', () => {
  assert.equal(normalizeVaultRelativePath('工程/架构设计'), '工程/架构设计.md');
  assert.equal(normalizeVaultRelativePath('工程\\架构设计.md'), '工程/架构设计.md');
});

test('normalizeVaultRelativePath rejects traversal and absolute paths', () => {
  for (const value of ['../secret', '/secret', 'C:/secret', 'a/../secret', 'bad:name']) {
    assert.throws(() => normalizeVaultRelativePath(value));
  }
});

test('resolveVaultPath stays inside the vault root', () => {
  const resolved = resolveVaultPath('C:/vault', 'notes/today.md');
  assert.equal(resolved, 'C:\\vault\\notes\\today.md');
});
