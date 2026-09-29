import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../src/vault/markdown.js';

test('frontmatter values cannot inject additional fields', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const parsed = parseMarkdownDocument(`---\nid: ${id}\ntitle: Safe\nid: forged\n---\nbody`, 'note.md');
  assert.equal(parsed.id, id);
  assert.equal(parsed.title, 'Safe');

  const serialized = serializeMarkdownDocument({
    id,
    title: 'Safe\nid: forged',
    content: 'body',
    isPinned: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  });
  assert.equal((serialized.match(/^id:/gm) ?? []).length, 1);
  assert.match(serialized, /^title: Safe id: forged$/m);
});

test('frontmatter properties survive parse and serialization without replacing reserved fields', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const parsed = parseMarkdownDocument(`---\nid: ${id}\ntitle: Properties\nstatus: active\npriority: 2\ntags: ["ai", "notes"]\n---\nbody`, 'note.md');
  assert.deepEqual(parsed.properties, { priority: 2, status: 'active', tags: ['ai', 'notes'] });

  const serialized = serializeMarkdownDocument({
    id,
    title: 'Properties',
    content: 'body',
    isPinned: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    properties: { status: 'done', priority: 3, id: 'must-not-replace' },
  });
  assert.match(serialized, /^priority: 3$/m);
  assert.match(serialized, /^status: done$/m);
  assert.equal((serialized.match(/^id:/gm) ?? []).length, 1);
});
