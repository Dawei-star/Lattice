import { randomUUID } from 'node:crypto';

import { createHash } from 'node:crypto';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED_FIELDS = new Set(['id', 'title', 'pinned', 'created_at', 'updated_at']);

/** 与磁盘字节一一对应的投影指纹：同步引擎用它跳过未变化的文件。 */
export function hashDocument(note) {
  return createHash('sha256').update(serializeMarkdownDocument(note)).digest('hex');
}

export function hashRaw(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

export function parseMarkdownDocument(raw, relativePath) {
  const match = raw.match(FRONTMATTER_RE);
  const fields = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(key) || key in fields) continue;
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
    properties: Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => !RESERVED_FIELDS.has(key))
        .map(([key, value]) => [key, parsePropertyValue(value)]),
    ),
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
    ...serializeProperties(note.properties),
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${note.content ?? ''}`;
}

function frontmatterValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => frontmatterValue(item)));
  return String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
}

function serializeProperties(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties)
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(key) && !RESERVED_FIELDS.has(key))
    .sort()
    .map((key) => `${key}: ${frontmatterValue(properties[key])}`);
}

function parsePropertyValue(value) {
  const source = String(value ?? '').trim();
  if (source === 'true') return true;
  if (source === 'false') return false;
  if (source === 'null') return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(source)) return Number(source);
  if (source.startsWith('[') && source.endsWith(']')) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) return parsed.slice(0, 50).map((item) => String(item));
    } catch {
      // Preserve malformed list-like values as strings instead of dropping user data.
    }
  }
  if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) {
    return source.slice(1, -1);
  }
  return source;
}
