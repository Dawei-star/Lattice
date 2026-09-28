import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultAdapter } from '../src/vault/vault.adapter.js';

test('VaultAdapter scans nested markdown and writes frontmatter atomically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-vault-'));
  const vault = new VaultAdapter(root);
  await fs.mkdir(path.join(root, '工程'), { recursive: true });
  await fs.writeFile(path.join(root, '工程', '设计.md'), '# 设计\n\n[[实现]]\n', 'utf8');

  const notes = await vault.scan();
  const folders = await vault.scanFolders();
  assert.equal(notes.length, 1);
  assert.deepEqual(folders, ['工程']);
  assert.equal(notes[0].title, '设计');
  assert.match(await fs.readFile(path.join(root, '工程', '设计.md'), 'utf8'), /^---\n/);

  await vault.write({
    id: notes[0].id,
    title: '设计',
    content: '# 更新后的设计\n',
    filePath: '工程/设计.md',
    isPinned: true,
    createdAt: notes[0].createdAt,
    updatedAt: new Date().toISOString(),
  });
  assert.match(await fs.readFile(path.join(root, '工程', '设计.md'), 'utf8'), /更新后的设计/);
  await fs.rm(root, { recursive: true, force: true });
});
