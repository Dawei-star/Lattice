import { randomUUID } from 'node:crypto';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMarkdownDocument(raw, relativePath) {
  const match = raw.match(FRONTMATTER_RE);
  const fields = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 1) continue;
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }

  const content = match ? raw.slice(match[0].length) : raw;
  const fallbackTitle = relativePath.split('/').at(-1).replace(/\.md$/i, '');
  return {
    id: fields.id || randomUUID(),
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
    `id: ${note.id}`,
    `title: ${note.title}`,
    `pinned: ${note.isPinned ? 'true' : 'false'}`,
    `created_at: ${note.createdAt}`,
    `updated_at: ${note.updatedAt}`,
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${note.content ?? ''}`;
}
