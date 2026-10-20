import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { docToMarkdown, markdownToDoc, normalizeMarkdownForComparison } from '../web/src/editor/markdown-bridge.ts';

const IGNORED_DIRECTORIES = new Set(['.git', '.lattice', '.obsidian', 'node_modules']);

/** Read-only Markdown -> Doc -> Markdown scan. The root is never written. */
export async function scanMarkdownVault(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const limit = options.limit === undefined ? null : Math.max(0, Math.floor(options.limit));
  const files = (await collectMarkdownFiles(absoluteRoot))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .slice(0, limit ?? undefined);
  const entries = [];

  for (const filePath of files) {
    const relativePath = path.relative(absoluteRoot, filePath).split(path.sep).join('/');
    const source = await readFile(filePath, 'utf8');
    const baseEntry = {
      path: relativePath,
      status: 'error',
      sourceBytes: Buffer.byteLength(source, 'utf8'),
    };

    try {
      const projection = await markdownToDoc(source, path.basename(filePath, path.extname(filePath)));
      try {
        const output = docToMarkdown(projection.doc, source);
        const sourceNormalized = normalizeMarkdownForComparison(source);
        const outputNormalized = normalizeMarkdownForComparison(output);
        const firstDifference = sourceNormalized === outputNormalized
          ? undefined
          : findFirstDifference(sourceNormalized, outputNormalized);
        entries.push({
          ...baseEntry,
          status: firstDifference === undefined ? 'pass' : 'changed',
          outputBytes: Buffer.byteLength(output, 'utf8'),
          ...(firstDifference === undefined ? {} : {
            firstDifference,
            sourceExcerpt: excerptAt(sourceNormalized, firstDifference),
            outputExcerpt: excerptAt(outputNormalized, firstDifference),
          }),
        });
      } finally {
        projection.doc.dispose();
        projection.doc.collection.dispose();
      }
    } catch (error) {
      entries.push({
        ...baseEntry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = {
    total: entries.length,
    passed: entries.filter(entry => entry.status === 'pass').length,
    changed: entries.filter(entry => entry.status === 'changed').length,
    errors: entries.filter(entry => entry.status === 'error').length,
  };

  return {
    version: 1,
    root: absoluteRoot,
    scannedAt: new Date().toISOString(),
    limit,
    summary,
    entries,
  };
}

async function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...await collectMarkdownFiles(path.join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path.join(directory, entry.name));
  }
  return files;
}

function findFirstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return limit;
}

function excerptAt(value, index) {
  const start = Math.max(0, index - 40);
  return value.slice(start, index + 80).replace(/\n/g, '\\n');
}
