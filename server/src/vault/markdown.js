import { randomUUID } from 'node:crypto';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMarkdownDocument(raw, relativePath) {
  const match = raw.match(FRONTMATTER_RE);
  const fields = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      if (!['id', 'title', 'pinned', 'created_at', 'updated_at'].includes(key) || key in fields) continue;
      fields[key] = line.slice(separator + 1).trim();
    }
  }

  const content = match ? raw.slice(match[0].length) : raw;
  const fallbackTitle = relativePath.split('/').at(-1).replace(/\.md$/i, '');
  return {
    id: UUID_RE.test(fields.id ?? '') ? fields.id : randomUUID(),
    title: fields.title || fallbackTitle,
    content,
    folderPath: relativePath.split('/').slice(0, -1).join('/'),
    filePath: relativePath,
    isPinned: fields.pinned === 'true',
    createdAt: fields.created_at || null,
    updatedAt: fields.updated_at || null,
    hasFrontmatter: Boolean(match),
  };
}

export function serializeMarkdownDocument(note) {
  const frontmatter = [
    '---',
    `id: ${frontmatterValue(note.id)}`,
    `title: ${frontmatterValue(note.title)}`,
    `pinned: ${note.isPinned ? 'true' : 'false'}`,
    `created_at: ${frontmatterValue(note.createdAt)}`,
    `updated_at: ${frontmatterValue(note.updatedAt)}`,
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${note.content ?? ''}`;
}

function frontmatterValue(value) {
  return String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
}
