import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';

installDom();
const { renderMarkdown } = await import('../src/lib/markdown.js');

const html = renderMarkdown('```md\n[[Do not link]]\n```\n\n[[Open me]]', {
  resolveTitle: (title) => (title === 'Open me' ? { id: 'note-1' } : null),
});

assert.match(html, /<code class="language-md">\[\[Do not link\]\][\s\S]*<\/code>/);
assert.match(html, /data-wiki-title="Open me"/);
assert.equal((html.match(/data-wiki-title=/g) ?? []).length, 1);
console.log('markdown code fence tests passed');
