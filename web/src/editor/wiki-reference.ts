export interface WikiReference {
  kind: 'link' | 'embed';
  title: string;
  heading?: string;
  alias?: string;
  raw: string;
  start: number;
  end: number;
}

const WIKI_REFERENCE = /(!?)\[\[([^\[\]|#]+?)(?:#([^\[\]|]+?))?(?:\|([^\[\]]+?))?\]\]/g;
const CODE_SPAN = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

/** Parse wiki references from one BlockSuite text block without changing its source text. */
export function parseWikiReferences(source: string | null | undefined): WikiReference[] {
  const references: WikiReference[] = [];
  const text = String(source ?? '');
  let cursor = 0;
  for (const code of text.matchAll(CODE_SPAN)) {
    collectReferences(text.slice(cursor, code.index), cursor, references);
    cursor = (code.index ?? 0) + code[0].length;
  }
  collectReferences(text.slice(cursor), cursor, references);
  return references;
}

function collectReferences(source: string, offset: number, references: WikiReference[]) {
  for (const match of source.matchAll(WIKI_REFERENCE)) {
    const title = match[2].trim();
    if (!title) continue;
    const start = offset + (match.index ?? 0);
    references.push({
      kind: match[1] === '!' ? 'embed' : 'link',
      title,
      heading: match[3]?.trim() || undefined,
      alias: match[4]?.trim() || undefined,
      raw: match[0],
      start,
      end: start + match[0].length,
    });
  }
}

/** Return the reference when a block consists only of one block embed. */
export function parseStandaloneEmbed(source: string | null | undefined): WikiReference | null {
  const trimmed = String(source ?? '').trim();
  const references = parseWikiReferences(trimmed);
  return references.length === 1
    && references[0].kind === 'embed'
    && references[0].raw === trimmed
    ? references[0]
    : null;
}
