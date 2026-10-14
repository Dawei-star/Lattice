const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/;

/** 拆分结果：frontmatter 前缀（含围栏）与其余正文。 */
export interface SplitNativeDocument {
  prefix: string;
  content: string;
}

/** 把原生笔记原文拆成 frontmatter 前缀与正文（无 frontmatter 时 prefix 为空串）。 */
export function splitNativeDocument(raw: string): SplitNativeDocument {
  const prefix = raw.match(FRONTMATTER)?.[1] ?? '';
  return { prefix, content: raw.slice(prefix.length) };
}

/** 生成带 frontmatter 的新笔记原文（id 由 crypto.randomUUID 生成，时间戳取当前时刻）。 */
export function createNativeDocument(title: string, content = ''): string {
  const cleanTitle = String(title).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
  const now = new Date().toISOString();
  return `---\nid: ${crypto.randomUUID()}\ntitle: ${cleanTitle}\npinned: false\ncreated_at: ${now}\nupdated_at: ${now}\n---\n${content}`;
}
