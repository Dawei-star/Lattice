import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';

installDom();
const { parseOutline, renderMarkdown } = await import('../src/lib/markdown.js');
const { resolveAttachmentPath, relativeAttachmentReference } = await import('../src/api/vault-files.js');

const html = renderMarkdown('```md\n[[Do not link]]\n```\n\n[[Open me]]', {
  resolveTitle: (title) => (title === 'Open me' ? { id: 'note-1' } : null),
});

assert.match(html, /<code class="language-md">\[\[Do not link\]\][\s\S]*<\/code>/);
assert.match(html, /data-wiki-title="Open me"/);
assert.equal((html.match(/data-wiki-title=/g) ?? []).length, 1);

const outline = parseOutline('# Root\n\n```md\n## ignored\n```\n\n### Child ###');
assert.deepEqual(outline.map(({ level, text }) => ({ level, text })), [
  { level: 1, text: 'Root' },
  { level: 3, text: 'Child' },
]);
assert.equal(outline[1].start, '# Root\n\n```md\n## ignored\n```\n\n'.length);

const attachmentHtml = renderMarkdown('![cover](../attachments/cover.png)', {
  resolveAsset: (reference) => `http://localhost:5177/api/vault/attachment?path=${encodeURIComponent(reference)}`,
});
assert.match(attachmentHtml, /src="http:\/\/localhost:5177\/api\/vault\/attachment\?path=/);
assert.equal(resolveAttachmentPath('Daily/2026-09-29.md', '../attachments/cover.png'), 'attachments/cover.png');
assert.equal(resolveAttachmentPath('Daily/2026-09-29.md', 'attachments/cover.png'), 'attachments/cover.png');
assert.equal(relativeAttachmentReference('Daily/2026-09-29.md', 'attachments/cover.png'), '../attachments/cover.png');
assert.equal(resolveAttachmentPath('Note.md', 'https://example.com/cover.png'), null);
console.log('markdown code fence tests passed');
