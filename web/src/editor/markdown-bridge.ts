import { MarkdownTransformer } from '@blocksuite/blocks';
import { AffineSchemas } from '@blocksuite/blocks/schemas';
import { DocCollection, Schema } from '@blocksuite/store';
import type { BlockModel, Doc } from '@blocksuite/store';
import {
  LatticeWikiReferenceBlockSchema,
  isLatticeWikiReferenceBlock,
} from './blocksuite-wiki-reference.ts';

export interface MarkdownDocProjection {
  doc: Doc;
  source: string;
}

interface MarkdownProjectionState {
  source: string;
  baseline: string;
}

const projectionStates = new WeakMap<Doc, MarkdownProjectionState>();

function createLatticeDoc() {
  const schema = new Schema().register([...AffineSchemas, LatticeWikiReferenceBlockSchema]);
  const collection = new DocCollection({ schema });
  collection.meta.initialize();
  const doc = collection.createDoc();

  return {
    doc,
    init() {
      doc.load();
      const rootId = doc.addBlock('affine:page', {});
      doc.addBlock('affine:surface', {}, rootId);
      const noteId = doc.addBlock('affine:note', {}, rootId);
      doc.addBlock('affine:paragraph', {}, noteId);
      return doc;
    },
  };
}

/** Markdown is the durable source; this Doc is a disposable runtime projection. */
export async function markdownToDoc(markdown: string, title = ''): Promise<MarkdownDocProjection> {
  const { doc, init } = createLatticeDoc();
  init();
  doc.collection.setDocMeta(doc.id, { title });

  const note = doc.getBlockByFlavour('affine:note')[0];
  if (!note) return { doc, source: markdown };

  const body = stripFrontmatter(markdown);
  // BlockSuite's importer expects a snapshot and throws for an empty body.
  // An empty Markdown note is valid; keep the initialized empty paragraph so it
  // remains directly editable in the page surface.
  if (body.trim()) {
    for (const child of [...note.children]) doc.deleteBlock(child);
    await MarkdownTransformer.importMarkdownToBlock({ doc, markdown: body, blockId: note.id });
  }
  promoteStandaloneWikiEmbeds(doc, note);
  const state: MarkdownProjectionState = { source: markdown, baseline: '' };
  state.baseline = fingerprintDoc(doc);
  projectionStates.set(doc, state);
  return { doc, source: markdown };
}

/** Export the editable block subset without writing a BlockSuite database. */
export function docToMarkdown(doc: Doc, originalSource = ''): string {
  const note = doc.getBlockByFlavour('affine:note')[0];
  if (!note) return '';
  const state = projectionStates.get(doc);
  if (state && state.source === originalSource && state.baseline === fingerprintDoc(doc)) return originalSource;
  const body = note.children.map((child) => serializeBlock(child, 0)).filter(Boolean).join('\n\n').trimEnd();
  const frontmatter = extractFrontmatter(originalSource);
  return frontmatter ? `${frontmatter}${body ? `\n\n${body}` : ''}` : body;
}

function extractFrontmatter(source: string): string {
  const match = source.replace(/\r\n?/g, '\n').match(/^---\n[\s\S]*?\n---(?=\n|$)/);
  return match?.[0] ?? '';
}

function stripFrontmatter(source: string): string {
  const normalized = source.replace(/\r\n?/g, '\n');
  const frontmatter = extractFrontmatter(normalized);
  return frontmatter ? normalized.slice(frontmatter.length) : normalized;
}

function serializeBlock(block: BlockModel, depth: number): string {
  const indent = '  '.repeat(depth);
  const props = block as BlockModel & {
    type?: string;
    text?: { toString(): string };
    language?: string | null;
    latex?: string | null;
    checked?: boolean;
    children: BlockModel[];
    columns?: Array<{ id: string; name?: string; type?: string }>;
    cells?: Record<string, Record<string, { value?: { toString(): string } | string }>>;
  };

  if (block.flavour === 'affine:paragraph') {
    const text = props.text?.toString() ?? '';
    const type = props.type ?? 'text';
    const prefix = type.startsWith('h') ? `${'#'.repeat(Number(type.slice(1)))} ` : type === 'quote' ? '> ' : '';
    return `${indent}${prefix}${text}`;
  }

  if (isLatticeWikiReferenceBlock(block)) {
    return `${indent}${props.text?.toString() ?? ''}`;
  }

  if (block.flavour === 'affine:list') {
    const text = props.text?.toString() ?? '';
    const type = props.type ?? 'bulleted';
    const prefix = type === 'numbered' ? '1. ' : type === 'todo' ? `- [${props.checked ? 'x' : ' '}] ` : '- ';
    const children = props.children.map((child) => serializeBlock(child, depth + 1)).filter(Boolean);
    return `${indent}${prefix}${text}${children.length ? `\n${children.join('\n')}` : ''}`;
  }

  if (block.flavour === 'affine:database') return serializeDatabase(props, indent);

  if (block.flavour === 'affine:code') {
    const language = props.language ?? '';
    return `${indent}\`\`\`${language}\n${props.text?.toString() ?? ''}\n${indent}\`\`\``;
  }

  if (block.flavour === 'affine:latex') {
    return `${indent}$$\n${props.latex ?? ''}\n${indent}$$`;
  }

  if (block.flavour === 'affine:divider') return `${indent}---`;

  const children = props.children.map((child) => serializeBlock(child, depth)).filter(Boolean);
  return children.length
    ? `${indent}<!-- BlockSuite block: ${block.flavour} -->\n${children.join('\n\n')}`
    : `${indent}<!-- BlockSuite block: ${block.flavour} -->`;
}

function serializeDatabase(block: BlockModel & {
  children: BlockModel[];
  columns?: Array<{ id: string; name?: string }>;
  cells?: Record<string, Record<string, { value?: { toString(): string } | string }>>;
}, indent: string): string {
  const columns = Array.isArray(block.columns) ? block.columns : [];
  if (!columns.length) return `${indent}<!-- BlockSuite block: affine:database -->`;

  const header = columns.map((column) => escapeTableCell(column.name ?? '')).join(' | ');
  const separator = columns.map(() => '---').join(' | ');
  const rows = block.children.map((row) => columns.map((column, index) => {
    if (index === 0) return escapeTableCell(readText(row));
    const value = block.cells?.[row.id]?.[column.id]?.value;
    return escapeTableCell(typeof value === 'string' ? value : value?.toString?.() ?? '');
  }).join(' | '));

  return `${indent}| ${header} |\n${indent}| ${separator} |${rows.length ? `\n${rows.map((row) => `${indent}| ${row} |`).join('\n')}` : ''}`;
}

function escapeTableCell(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function readText(block: BlockModel & { text?: { toString(): string } }): string {
  return block.text?.toString() ?? '';
}

function fingerprintDoc(doc: Doc): string {
  const note = doc.getBlockByFlavour('affine:note')[0];
  return note ? note.children.map((block) => fingerprintBlock(block)).join('\u001f') : '';
}

function fingerprintBlock(block: BlockModel): string {
  const props = block as BlockModel & {
    type?: string;
    text?: { toString(): string };
    language?: string | null;
    latex?: string | null;
    checked?: boolean;
    columns?: unknown;
    cells?: unknown;
    children: BlockModel[];
  };
  return JSON.stringify([
    block.flavour,
    props.type ?? null,
    props.text?.toString() ?? null,
    props.language ?? null,
    props.latex ?? null,
    props.checked ?? null,
    props.columns ?? null,
    props.cells ?? null,
    props.children.map((child) => fingerprintBlock(child)),
  ]);
}

function promoteStandaloneWikiEmbeds(doc: Doc, note: BlockModel) {
  note.children.slice().forEach((child, index) => {
    const props = child as BlockModel & { text?: { toString(): string } };
    const text = props.text?.toString() ?? '';
    if (!/^\s*!\[\[[^\[\]|#]+?(?:#[^\[\]|]+?)?(?:\|[^\[\]]+?)?\]\]\s*$/.test(text)) return;

    const promotedId = doc.addBlock(
      'affine:embed-lattice-wiki-reference',
      { text: new doc.Text(text) },
      note.id,
      index,
    );
    doc.deleteBlock(child);
    if (!promotedId) return;
  });
}

/** Normalize layout whitespace for semantic round-trip assertions. */
export function normalizeMarkdownForComparison(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}
