const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/;

export function splitNativeDocument(raw) {
  const prefix = raw.match(FRONTMATTER)?.[1] ?? '';
  return { prefix, content: raw.slice(prefix.length) };
}

export function createNativeDocument(title, content = '') {
  const cleanTitle = String(title).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
  const now = new Date().toISOString();
  return `---\nid: ${crypto.randomUUID()}\ntitle: ${cleanTitle}\npinned: false\ncreated_at: ${now}\nupdated_at: ${now}\n---\n${content}`;
}
