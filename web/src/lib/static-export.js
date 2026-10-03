import { renderMarkdown } from './markdown.js';

const MAX_EMBED_DEPTH = 2;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SITE_ASSET_BYTES = 25 * 1024 * 1024;
const SITE_NAME = '格物 Lattice';
const REPOSITORY_URL = 'https://github.com/Dawei-star/Lattice';

/** Build a standalone HTML document while keeping remote resources untouched. */
export async function buildStaticHtml({
  title,
  content,
  resolveTitle = () => null,
  resolveAsset = () => null,
  resolveAssetForPath = null,
  resolveEmbed = null,
  fetchImpl = globalThis.fetch,
  sourcePath = '',
  sourceFilePath = sourcePath,
  siteIndexPath = null,
  inlineImages = true,
}) {
  const body = await renderStaticBody(content, {
    resolveTitle,
    resolveAsset,
    resolveAssetForPath,
    resolveEmbed,
    sourcePath,
    sourceFilePath,
    depth: 0,
    trail: new Set(),
  });
  const root = parseFragment(body);
  if (inlineImages) await inlineVaultImages(root, fetchImpl);
  const renderedBody = root.innerHTML;
  const homeHref = siteIndexPath ? relativeExportPath(sourcePath, siteIndexPath) : REPOSITORY_URL;
  const homeLink = siteIndexPath
    ? `<a class="export-home" href="${escapeHtml(homeHref)}">知识库目录</a>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="application-name" content="${SITE_NAME}"><title>${escapeHtml(title)} · ${SITE_NAME}</title>
<style>:root{color-scheme:light;--canvas:#f4f6f9;--surface:#fff;--ink:#111827;--muted:#667085;--subtle:#98a2b3;--line:#e4e7ec;--brand:#3e55c7;--brand-soft:#e8ecff;--teal:#198f82}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.75 "Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif}a{color:inherit;text-decoration:none}.export-header,.export-footer,.export-shell{max-width:860px;margin:0 auto;padding-right:24px;padding-left:24px}.export-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:22px;padding-bottom:22px;border-bottom:1px solid var(--line)}.export-brand,.export-home{color:var(--brand);font-size:14px;font-weight:800}.export-home{margin-left:auto;font-size:12px}.export-meta{color:var(--subtle);font-size:12px}.export-shell{padding-top:54px;padding-bottom:44px}.export-shell article{overflow-wrap:anywhere;padding:34px 38px;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:0 12px 30px rgba(18,32,63,.06)}h1,h2,h3,h4,h5,h6{line-height:1.3;scroll-margin-top:16px}h1{margin-top:0;margin-bottom:24px;font-size:36px}img{display:block;max-width:100%;height:auto}pre{padding:16px;overflow:auto;background:#f2f5f8;border-radius:6px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #b7c7d7;color:#58708a}a.wiki-link{color:#4569a8}span.wiki-link.is-dangling{color:#7e8b9c;border-bottom:1px dashed #aab5c2}.note-embed{margin:16px 0;padding:12px 14px;border:1px solid #d6e0ea;border-radius:7px;background:#f8fafc}.note-embed__head{font-size:13px;font-weight:650}.note-embed__badge{margin-right:7px;color:#6b7f99;font-size:11px}.note-embed__body{margin-top:8px}.export-footer{display:flex;justify-content:space-between;gap:16px;padding-top:22px;padding-bottom:30px;color:var(--subtle);font-size:12px}.export-footer a{color:var(--brand)}@media(max-width:600px){.export-header,.export-footer,.export-shell{padding-right:18px;padding-left:18px}.export-header{align-items:flex-start;flex-direction:column;gap:3px}.export-home{margin-left:0}.export-shell{padding-top:28px}.export-shell article{padding:24px 20px}h1{font-size:29px}.export-footer{display:block}.export-footer span{display:block;margin-top:4px}}</style></head>
<body><header class="export-header"><a class="export-brand" href="${escapeHtml(homeHref)}"${siteIndexPath ? '' : ' target="_blank" rel="noreferrer"'}>${SITE_NAME}</a>${homeLink}<span class="export-meta">导出文档</span></header><main class="export-shell"><article><h1>${escapeHtml(title)}</h1>${renderedBody}</article></main><footer class="export-footer"><span>由 ${SITE_NAME} 导出</span><span><a href="${REPOSITORY_URL}" target="_blank" rel="noreferrer">查看项目源码</a> · Markdown 内容保持可迁移</span></footer></body></html>`;
}

/**
 * Build a deployable static site from note details.
 * @param {{ notes?: Array<{ id?: string, title: string, content?: string, filePath?: string }>, resolveAssetUrl?: (note: object, reference: string) => string|null, fetchImpl?: typeof fetch, siteTitle?: string }} options
 * @returns {Promise<{ files: Array<{ path: string, content: string|Uint8Array }>, noteCount: number, assetCount: number, byteCount: number }>}
 */
export async function buildStaticSite({
  notes = [],
  resolveAssetUrl = () => null,
  fetchImpl = globalThis.fetch,
  siteTitle = SITE_NAME,
}) {
  const normalizedNotes = normalizeSiteNotes(notes);
  const notesByPath = new Map(normalizedNotes.map((note) => [normalizeFilePath(note.filePath), note]));
  const titleIndex = new Map();
  for (const note of normalizedNotes) {
    const key = note.title.trim().toLowerCase();
    if (!titleIndex.has(key)) titleIndex.set(key, note);
  }
  const resolveTitle = (title) => titleIndex.get(String(title ?? '').trim().toLowerCase()) ?? null;
  const assets = new Map();
  const collectAsset = (reference, sourceFilePath) => {
    const sourceNote = notesByPath.get(normalizeFilePath(sourceFilePath));
    if (!sourceNote) return null;
    const sourceUrl = resolveAssetUrl(sourceNote, reference);
    if (!sourceUrl) return null;
    const assetPath = assetOutputPath(sourceUrl, reference);
    assets.set(assetPath, { url: sourceUrl });
    return sourceUrl;
  };
  const createEmbedResolver = () => async (title) => {
    const embedded = resolveTitle(title);
    return embedded ? { content: embedded.content ?? '', filePath: embedded.filePath } : null;
  };

  // First render discovers every image URL, including images inside expanded embeds.
  for (const note of normalizedNotes) {
    await buildStaticHtml({
      title: note.title,
      content: note.content,
      resolveTitle,
      resolveAsset: (reference) => collectAsset(reference, note.filePath),
      resolveAssetForPath: collectAsset,
      resolveEmbed: createEmbedResolver(),
      sourcePath: note.outputPath,
      sourceFilePath: note.filePath,
      inlineImages: false,
    });
  }

  const downloadedAssets = new Map();
  if (typeof fetchImpl === 'function') {
    await Promise.all([...assets.entries()].map(async ([assetPath, asset]) => {
      try {
        const response = await fetchImpl(asset.url);
        if (!response?.ok) return;
        const blob = await response.blob();
        if (!blob || blob.size > MAX_SITE_ASSET_BYTES) return;
        downloadedAssets.set(assetPath, {
          content: new Uint8Array(await blob.arrayBuffer()),
          size: blob.size,
        });
      } catch {
        // A missing asset should not prevent the rest of the Vault from exporting.
      }
    }));
  }

  const files = [];
  for (const note of normalizedNotes) {
    const html = await buildStaticHtml({
      title: note.title,
      content: note.content,
      resolveTitle,
      resolveAsset: (reference) => resolveStaticAsset(reference, note.filePath, note.outputPath),
      resolveAssetForPath: (reference, sourceFilePath) => resolveStaticAsset(reference, sourceFilePath, note.outputPath),
      resolveEmbed: createEmbedResolver(),
      sourcePath: note.outputPath,
      sourceFilePath: note.filePath,
      siteIndexPath: 'index.html',
      inlineImages: false,
    });
    files.push({ path: note.outputPath, content: html });
  }
  for (const [path, asset] of downloadedAssets) files.push({ path, content: asset.content });
  files.unshift({ path: 'index.html', content: buildStaticIndex({ siteTitle, notes: normalizedNotes }) });

  return {
    files,
    noteCount: normalizedNotes.length,
    assetCount: downloadedAssets.size,
    byteCount: files.reduce((total, file) => total + contentByteLength(file.content), 0),
  };

  function resolveStaticAsset(reference, sourceFilePath, currentOutputPath) {
    const sourceNote = notesByPath.get(normalizeFilePath(sourceFilePath));
    if (!sourceNote) return null;
    const sourceUrl = resolveAssetUrl(sourceNote, reference);
    if (!sourceUrl) return null;
    const assetPath = assetOutputPath(sourceUrl, reference);
    const outputPath = sourceNote.outputPath ?? currentOutputPath;
    return downloadedAssets.has(assetPath) ? relativeExportPath(outputPath, assetPath) : null;
  }
}

function normalizeSiteNotes(notes) {
  const used = new Set(['index.html']);
  return (Array.isArray(notes) ? notes : []).filter((note) => note?.title).map((note, index) => {
    const filePath = normalizeFilePath(note.filePath || `${note.title || `note-${index + 1}`}.md`);
    let outputPath = exportPath(filePath);
    if (used.has(outputPath)) outputPath = `notes/${outputPath}`;
    let suffix = 2;
    const originalPath = outputPath;
    while (used.has(outputPath)) outputPath = originalPath.replace(/\.html$/i, `-${suffix++}.html`);
    used.add(outputPath);
    return { ...note, filePath, outputPath, content: String(note.content ?? '') };
  });
}

function buildStaticIndex({ siteTitle, notes }) {
  const rows = notes.map((note) => ({ title: note.title, path: note.outputPath }));
  const serialized = JSON.stringify(rows).replace(/</g, '\\u003c');
  const list = rows.map((note) => `<li><a href="${escapeHtml(note.outputPath)}"><strong>${escapeHtml(note.title)}</strong><span>${escapeHtml(note.filePath)}</span></a></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="application-name" content="${escapeHtml(siteTitle)}"><title>${escapeHtml(siteTitle)}</title><style>:root{color-scheme:light;--canvas:#f4f6f9;--surface:#fff;--ink:#111827;--muted:#667085;--subtle:#98a2b3;--line:#e4e7ec;--brand:#3e55c7}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.6 "Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif}.site-index{max-width:900px;margin:0 auto;padding:52px 24px 70px}.site-index__eyebrow{color:var(--brand);font-size:12px;font-weight:800;letter-spacing:.08em}.site-index h1{margin:10px 0 8px;font-size:36px}.site-index__meta{color:var(--muted)}.site-index__search{width:100%;margin:28px 0 18px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);font:inherit}.site-index ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;padding:0;list-style:none}.site-index li a{display:flex;flex-direction:column;gap:3px;padding:15px 16px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);text-decoration:none}.site-index li a:hover{border-color:#9aaaf0;box-shadow:0 6px 18px rgba(18,32,63,.06)}.site-index li span{color:var(--subtle);font-size:12px;overflow-wrap:anywhere}.site-index__empty{color:var(--muted)}@media(max-width:600px){.site-index{padding:32px 18px 48px}.site-index h1{font-size:29px}}</style></head><body><main class="site-index"><span class="site-index__eyebrow">LATTICE / STATIC VAULT</span><h1>${escapeHtml(siteTitle)}</h1><p class="site-index__meta">${rows.length} 篇笔记 · 可直接部署的静态知识库</p><input class="site-index__search" type="search" placeholder="搜索笔记标题或路径" aria-label="搜索笔记"><ul>${list || '<li class="site-index__empty">暂无可导出的笔记</li>'}</ul></main><script type="application/json" id="lattice-site-index">${serialized}</script><script>const data=JSON.parse(document.getElementById('lattice-site-index').textContent);const input=document.querySelector('.site-index__search');const items=[...document.querySelectorAll('.site-index li:not(.site-index__empty)')];input.addEventListener('input',()=>{const query=input.value.trim().toLowerCase();items.forEach((item,index)=>{const entry=data[index];const haystack=(entry.title+' '+entry.path).toLowerCase();item.hidden=Boolean(query&&!haystack.includes(query));});});</script></body></html>`;
}

async function renderStaticBody(source, context) {
  const assetResolver = context.resolveAssetForPath
    ? (reference) => context.resolveAssetForPath(reference, context.sourceFilePath ?? context.sourcePath)
    : context.resolveAsset;
  const html = renderMarkdown(source, {
    resolveTitle: context.resolveTitle,
    resolveAsset: assetResolver,
  });
  const root = parseFragment(html);
  await expandEmbeds(root, context);
  for (const embed of root.querySelectorAll('[data-embed-title], [data-embed-state]')) {
    embed.removeAttribute('data-embed-title');
    embed.removeAttribute('data-embed-state');
  }
  assignHeadingIds(root);
  rewriteWikiLinks(root, context.resolveTitle, context.sourcePath);
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
      const embedded = await context.resolveEmbed(title);
      const content = typeof embedded === 'string' ? embedded : embedded?.content;
      if (!content?.trim()) {
        markEmbedError(embed, 'Embedded note is empty');
        continue;
      }
      body.innerHTML = await renderStaticBody(content, {
        ...context,
        depth: context.depth + 1,
        trail: new Set([...context.trail, key]),
        sourcePath: embedded?.filePath ? exportPath(embedded.filePath) : context.sourcePath,
        sourceFilePath: embedded?.filePath ?? context.sourceFilePath,
      });
      embed.dataset.embedState = 'ready';
    } catch {
      markEmbedError(embed, 'Embedded note could not be loaded');
    }
  }
}

function rewriteWikiLinks(root, resolveTitle, sourcePath = '') {
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
    anchor.setAttribute('href', `${relativeExportPath(sourcePath, exportPath(target.filePath))}${suffix}`);
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

export function exportPath(filePath) {
  const segments = String(filePath ?? '').replaceAll('\\', '/').split('/').filter(Boolean);
  if (!segments.length) return 'note.html';
  const last = segments.length - 1;
  segments[last] = segments[last].replace(/\.(?:md|markdown)$/i, '.html');
  if (!/\.html$/i.test(segments[last])) segments[last] += '.html';
  return encodePathSegments(segments);
}

export function relativeExportPath(fromPath, toPath) {
  const hasSourceFile = Boolean(String(fromPath ?? '').trim());
  const from = String(fromPath ?? '').split('/').filter(Boolean);
  const to = String(toPath ?? '').split('/').filter(Boolean);
  from.pop();
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const relative = [...Array(from.length - common).fill('..'), ...to.slice(common)];
  if (!relative.length) return './';
  const encoded = relative.map((segment) => {
    if (segment === '..') return segment;
    try {
      return encodeURIComponent(decodeURIComponent(segment));
    } catch {
      return encodeURIComponent(segment);
    }
  }).join('/');
  return hasSourceFile ? encoded : `./${encoded}`;
}

function encodePathSegments(segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function assetOutputPath(sourceUrl, reference) {
  let candidate = '';
  try {
    const parsed = new URL(sourceUrl, globalThis.location?.href ?? 'http://localhost/');
    candidate = parsed.searchParams.get('path') || '';
  } catch {
    candidate = '';
  }
  if (!candidate) candidate = String(reference ?? '').split(/[?#]/, 1)[0];
  const segments = String(candidate).replaceAll('\\', '/').split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
  return `assets/${encodePathSegments(segments.length ? segments : ['asset.bin'])}`;
}

function normalizeFilePath(filePath) {
  return String(filePath ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').split('/').filter((segment) => segment && segment !== '.' && segment !== '..').join('/');
}

function contentByteLength(content) {
  if (content instanceof Uint8Array) return content.byteLength;
  return new TextEncoder().encode(String(content ?? '')).byteLength;
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
