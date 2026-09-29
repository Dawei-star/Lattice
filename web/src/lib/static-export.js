import { renderMarkdown } from './markdown.js';

const MAX_EMBED_DEPTH = 2;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** Build a standalone HTML document while keeping remote resources untouched. */
export async function buildStaticHtml({
  title,
  content,
  resolveTitle = () => null,
  resolveAsset = () => null,
  resolveEmbed = null,
  fetchImpl = globalThis.fetch,
}) {
  const body = await renderStaticBody(content, {
    resolveTitle,
    resolveAsset,
    resolveEmbed,
    depth: 0,
    trail: new Set(),
  });
  const root = parseFragment(body);
  await inlineVaultImages(root, fetchImpl);
  const renderedBody = root.innerHTML;

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{max-width:860px;margin:40px auto;padding:0 24px;color:#24364b;font:16px/1.75 system-ui,sans-serif}article{overflow-wrap:anywhere}h1,h2,h3,h4,h5,h6{line-height:1.3;scroll-margin-top:16px}img{display:block;max-width:100%;height:auto}pre{padding:16px;overflow:auto;background:#f2f5f8;border-radius:6px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #b7c7d7;color:#58708a}a.wiki-link{color:#4569a8}span.wiki-link.is-dangling{color:#7e8b9c;border-bottom:1px dashed #aab5c2}.note-embed{margin:16px 0;padding:12px 14px;border:1px solid #d6e0ea;border-radius:7px;background:#f8fafc}.note-embed__head{font-size:13px;font-weight:650}.note-embed__badge{margin-right:7px;color:#6b7f99;font-size:11px}.note-embed__body{margin-top:8px}</style></head>
<body><article><h1>${escapeHtml(title)}</h1>${renderedBody}</article></body></html>`;
}

async function renderStaticBody(source, context) {
  const html = renderMarkdown(source, {
    resolveTitle: context.resolveTitle,
    resolveAsset: context.resolveAsset,
  });
  const root = parseFragment(html);
  await expandEmbeds(root, context);
  for (const embed of root.querySelectorAll('[data-embed-title], [data-embed-state]')) {
    embed.removeAttribute('data-embed-title');
    embed.removeAttribute('data-embed-state');
  }
  assignHeadingIds(root);
  rewriteWikiLinks(root, context.resolveTitle);
  return root.innerHTML;
}

async function expandEmbeds(root, context) {
  const embeds = [...root.querySelectorAll('.note-embed[data-embed-title]')];
  for (const embed of embeds) {
    const title = embed.getAttribute('data-embed-title')?.trim() ?? '';
    const body = embed.querySelector('.note-embed__body');
    if (!title || !body) continue;

    const key = title.toLowerCase();
    if (!context.resolveEmbed || context.depth >= MAX_EMBED_DEPTH || context.trail.has(key)) {
      markEmbedError(embed, context.trail.has(key) ? 'Embed cycle stopped' : 'Embed depth limit reached');
      continue;
    }

    try {
      const content = await context.resolveEmbed(title);
      if (!content?.trim()) {
        markEmbedError(embed, 'Embedded note is empty');
        continue;
      }
      body.innerHTML = await renderStaticBody(content, {
        ...context,
        depth: context.depth + 1,
        trail: new Set([...context.trail, key]),
      });
      embed.dataset.embedState = 'ready';
    } catch {
      markEmbedError(embed, 'Embedded note could not be loaded');
    }
  }
}

function rewriteWikiLinks(root, resolveTitle) {
  for (const anchor of [...root.querySelectorAll('a.wiki-link[data-wiki-title]')]) {
    const title = anchor.getAttribute('data-wiki-title')?.trim() ?? '';
    let target = null;
    try {
      target = title ? resolveTitle(title) : null;
    } catch {
      target = null;
    }

    if (!target?.filePath) {
      const label = root.ownerDocument.createElement('span');
      label.className = 'wiki-link is-dangling';
      label.textContent = anchor.textContent ?? title;
      label.title = 'Unresolved wiki link';
      anchor.replaceWith(label);
      continue;
    }

    const heading = anchor.getAttribute('data-wiki-heading');
    const suffix = heading ? `#${headingAnchor(heading)}` : '';
    anchor.setAttribute('href', `./${exportPath(target.filePath)}${suffix}`);
    anchor.removeAttribute('data-wiki-title');
    anchor.removeAttribute('data-wiki-heading');
  }
}

function assignHeadingIds(root) {
  const used = new Map();
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = headingAnchor(heading.textContent ?? 'section');
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    heading.id = count === 1 ? base : `${base}-${count}`;
  }
}

async function inlineVaultImages(root, fetchImpl) {
  if (typeof fetchImpl !== 'function') return;
  const currentOrigin = globalThis.location?.origin ?? null;

  for (const image of root.querySelectorAll('img[src]')) {
    const source = image.getAttribute('src');
    if (!source) continue;

    let url;
    try {
      url = new URL(source, globalThis.location?.href ?? 'http://localhost/');
    } catch {
      continue;
    }
    if (currentOrigin && url.origin !== currentOrigin) continue;
    if (!/(?:^|\/)api\/vault\/(?:attachment|asset)$/i.test(url.pathname)) continue;

    try {
      const response = await fetchImpl(url.href);
      if (!response?.ok) continue;
      const blob = await response.blob();
      if (!blob || blob.size > MAX_INLINE_IMAGE_BYTES) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const binary = [];
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
      }
      image.setAttribute('src', `data:${blob.type || 'application/octet-stream'};base64,${encodeBase64(binary.join(''))}`);
    } catch {
      // A missing attachment should not make the whole note impossible to export.
    }
  }
}

function markEmbedError(embed, message) {
  embed.dataset.embedState = 'error';
  const body = embed.querySelector('.note-embed__body');
  if (body) body.textContent = message;
}

function parseFragment(html) {
  if (typeof DOMParser !== 'function') throw new Error('Static export requires DOMParser');
  const document = new DOMParser().parseFromString(`<div id="lattice-export-root">${html}</div>`, 'text/html');
  return document.querySelector('#lattice-export-root');
}

function exportPath(filePath) {
  const segments = String(filePath ?? '').replaceAll('\\', '/').split('/').filter(Boolean);
  if (!segments.length) return 'note.html';
  const last = segments.length - 1;
  segments[last] = segments[last].replace(/\.md$/i, '.html');
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function headingAnchor(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function encodeBase64(value) {
  if (typeof btoa === 'function') return btoa(value);
  const buffer = globalThis.Buffer;
  return buffer ? buffer.from(value, 'binary').toString('base64') : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
