import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { scanMarkdownVault } = await import('../../scripts/p2-roundtrip-scan-core.mjs');

const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-p2-roundtrip-'));
try {
  await mkdir(path.join(root, 'Daily', 'Nested'), { recursive: true });
  await mkdir(path.join(root, '.lattice'), { recursive: true });
  const fixture = (index) => `---\ntags: [p2, sample-${index}]\n---\n\n# 笔记 ${index}\n\n正文 [[目标笔记]] 与 ![[嵌入笔记]]。\n\n- [ ] 待办 ${index}\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``;
  const original = fixture(0);

  for (let index = 0; index < 220; index += 1) {
    const directory = index % 2 === 0 ? path.join(root, 'Daily') : path.join(root, 'Daily', 'Nested');
    await writeFile(path.join(directory, `note-${String(index).padStart(3, '0')}.md`), fixture(index), 'utf8');
  }
  await writeFile(path.join(root, '.lattice', 'ignored.md'), fixture('ignored'), 'utf8');
  const before = await readFile(path.join(root, 'Daily', 'note-000.md'), 'utf8');

  const report = await scanMarkdownVault(root);
  assert.equal(report.summary.total, 220);
  assert.equal(report.summary.changed, 0);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.entries.length, 220);
  assert.equal(await readFile(path.join(root, 'Daily', 'note-000.md'), 'utf8'), before);
  assert.equal(await readFile(path.join(root, 'Daily', 'note-000.md'), 'utf8'), original);

  const limited = await scanMarkdownVault(root, { limit: 5 });
  assert.equal(limited.summary.total, 5);
  console.log('round-trip vault scan tests passed (220 files, read-only)');
} finally {
  await rm(root, { recursive: true, force: true });
}
