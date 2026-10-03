import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultAdapter } from '../src/vault/vault.adapter.js';
import { parseMarkdownDocument } from '../src/vault/markdown.js';

test('VaultAdapter lists nested markdown and writes frontmatter atomically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-vault-'));
  const vault = new VaultAdapter(root);
  await fs.mkdir(path.join(root, '工程'), { recursive: true });
  await fs.writeFile(path.join(root, '工程', '设计.md'), '# 设计\n\n[[实现]]\n', 'utf8');

  const paths = await vault.listMarkdownPathsAsync();
  const folders = await vault.scanFolders();
  assert.deepEqual(paths, ['工程/设计.md']);
  assert.deepEqual(folders, ['工程']);

  const note = {
    id: '11111111-1111-4111-8111-111111111111',
    title: '设计',
    content: '# 更新后的设计\n',
    filePath: '工程/设计.md',
    isPinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await vault.write(note);
  const raw = await fs.readFile(path.join(root, '工程', '设计.md'), 'utf8');
  assert.match(raw, /^---\n/);
  assert.equal(parseMarkdownDocument(raw, '工程/设计.md').title, '设计');
  assert.match(raw, /更新后的设计/);
  await fs.rm(root, { recursive: true, force: true });
});
