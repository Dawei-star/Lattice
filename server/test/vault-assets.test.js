import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getImageFile, listImageFiles } from '../src/modules/vault/vault.repository.js';

test('vault image repository lists supported files and skips hidden content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-assets-'));
  await fs.mkdir(path.join(root, '素材'), { recursive: true });
  await fs.mkdir(path.join(root, '.lattice'), { recursive: true });
  await fs.writeFile(path.join(root, '素材', '封面.PNG'), Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(path.join(root, '素材', '说明.txt'), 'ignore', 'utf8');
  await fs.writeFile(path.join(root, '.lattice', 'hidden.png'), Buffer.from([1]));

  const assets = await listImageFiles(root);
  assert.deepEqual(assets.map((asset) => asset.path), ['素材/封面.PNG']);
  assert.equal(assets[0].mimeType, 'image/png');
  assert.equal((await getImageFile(root, '素材/封面.PNG')).size, 4);
  await fs.rm(root, { recursive: true, force: true });
});

test('vault image repository rejects traversal and unsupported files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-assets-'));
  await assert.rejects(() => getImageFile(root, '../outside.png'));
  assert.equal(await getImageFile(root, 'missing.txt'), null);
  await fs.rm(root, { recursive: true, force: true });
});
