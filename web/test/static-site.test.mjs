import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';

installDom();
const { buildStaticSite } = await import('../src/lib/static-export.js');

const notes = [
  {
    title: 'Alpha',
    filePath: 'Guides/Alpha.md',
    content: '# Alpha\n\n[[Nested note]]\n\n![[Nested note]]\n\n![Cover](../attachments/cover.png)',
  },
  {
    title: 'Nested note',
    filePath: 'Projects/Nested note.md',
    content: '## Nested content',
  },
];

let fetchCount = 0;
const site = await buildStaticSite({
  notes,
  resolveAssetUrl: (_note, reference) => reference.includes('cover.png')
    ? '/api/vault/attachment?path=attachments%2Fcover.png'
    : null,
  fetchImpl: async () => {
    fetchCount += 1;
    return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) };
  },
});

assert.equal(site.noteCount, 2);
assert.equal(site.assetCount, 1);
assert.equal(fetchCount, 1);
assert.deepEqual(site.files.map((file) => file.path), [
  'index.html',
  'Guides/Alpha.html',
  'Projects/Nested%20note.html',
  'assets/attachments/cover.png',
]);

const alpha = site.files.find((file) => file.path === 'Guides/Alpha.html').content;
assert.match(alpha, /href="\.\.\/Projects\/Nested%20note\.html"/);
assert.match(alpha, /src="\.\.\/assets\/attachments\/cover\.png"/);
assert.match(alpha, /Nested content/);
assert.match(site.files[0].content, /搜索笔记标题或路径/);

console.log('static site tests passed');
