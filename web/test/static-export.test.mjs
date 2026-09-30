import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';

installDom();
const { buildStaticHtml } = await import('../src/lib/static-export.js');

const notes = new Map([
  ['linked note', { id: 'linked-id', filePath: 'Guides/Linked note.md' }],
  ['embedded', { id: 'embedded-id', filePath: 'Embedded.md' }],
]);

let fetchCalls = 0;
const html = await buildStaticHtml({
  title: 'Exported note',
  content: '# Intro\n\n[[Linked note#Intro]]\n\n![[Embedded]]\n\n![Cover](attachments/cover.png)',
  resolveTitle: (title) => notes.get(title.toLowerCase()) ?? null,
  resolveAsset: () => '/api/vault/attachment?path=attachments%2Fcover.png',
  resolveEmbed: async (title) => (title === 'Embedded' ? '## Embedded content' : null),
  fetchImpl: async () => { fetchCalls += 1; return {
    ok: true,
    blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
  }; },
});

assert.equal(fetchCalls, 1);
assert.match(html, /<title>Exported note · 格物 Lattice<\/title>/);
assert.match(html, /class="export-brand" href="https:\/\/github\.com\/Dawei-star\/Lattice"/);
assert.match(html, /由 格物 Lattice 导出/);
assert.match(html, /href="\.\/Guides\/Linked%20note\.html#intro"/);
assert.match(html, /Embedded content/);
assert.match(html, /src="data:image\/png;base64,/);
assert.doesNotMatch(html, /data-wiki-title=/);
assert.doesNotMatch(html, /data-embed-title=/);

const cyclic = await buildStaticHtml({
  title: 'Cycle',
  content: '![[Loop]]',
  resolveTitle: () => ({ id: 'loop-id', filePath: 'Loop.md' }),
  resolveEmbed: async () => '![[Loop]]',
  fetchImpl: null,
});
assert.match(cyclic, /Embed cycle stopped/);

console.log('static export tests passed');
