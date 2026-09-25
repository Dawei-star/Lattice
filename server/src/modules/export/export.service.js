/**
 * 静态站点导出服务：把整个知识库渲染成自包含、可离线打开的静态 HTML 站点，
 * 落盘到 EXPORT_DIR/<时间戳>/，并在 app 里以 /export/* 只读托管，便于本地预览。
 *
 * 目录结构（相对路径决定页面上所有链接的基准）：
 *   index.html              首页：按目录分组 + 标签索引
 *   notes/<slug-id>.html    每篇笔记一页
 *   assets/style.css        全站样式（明暗双模，适配打印）
 *   attachments/<stored>    被正文引用到的附件文件副本
 *
 * 链接策略：
 *   笔记页在 notes/ 下，故同目录笔记互链用裸文件名，回首页用 ../index.html，
 *   附件用 ../attachments/<stored>，样式用 ../assets/style.css。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import { BadRequestError } from '../../lib/errors.js';
import { extractTags, toPlainText } from '../../lib/markdown.js';
import * as notesRepository from '../notes/notes.repository.js';
import * as foldersRepository from '../folders/folders.repository.js';
import {
  BLOCK_EMBED,
  BLOCK_TOKEN,
  INLINE_TOKEN,
  WIKI_LINK,
  escapeHtml,
  renderToHtml,
  slugifyHeading,
} from './export.render.js';

const EMBED_MAX_DEPTH = 4;
const ATTACH_REF = /\/attachments\/([0-9a-fA-F-]{36}\.[a-z0-9]+)/g;

/** 生成安全文件名主干：去掉文件系统/URL 非法字符，保留 CJK 与字母数字 */
function slugifyFile(title) {
  return (
    String(title ?? '')
      .replace(/[\\/:*?"<>|#%{}^~\[\]`\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'note'
  );
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** 标题 → 笔记 的解析表；同名取 updatedAt 最新的一篇（与前端 findByTitle 语义一致） */
function buildTitleIndex(notes) {
  const index = new Map();
  for (const note of notes) {
    const key = note.title.toLowerCase();
    const existing = index.get(key);
    if (!existing || note.updatedAt > existing.updatedAt) index.set(key, note);
  }
  return index;
}

/** 目录 id → 从根到该目录的路径段数组 */
function buildFolderPathMap(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map();

  function pathOf(id, guard = new Set()) {
    if (!id || guard.has(id)) return [];
    const cached = cache.get(id);
    if (cached) return cached;
    const folder = byId.get(id);
    if (!folder) return [];
    guard.add(id);
    const parent = pathOf(folder.parentId, guard);
    const result = [...parent, folder.name];
    cache.set(id, result);
    return result;
  }

  return { pathOf };
}

/**
 * 渲染单篇笔记正文为 HTML 片段（已解析双链 / 内联块级嵌入）。
 * 与 renderBody 递归协同，cycle/深度受 stack 与 depth 约束。
 */
function renderMarkdownToFragment(markdown, ctx) {
  const blockTokens = [];
  const inlineTokens = [];

  // 第一步：独占一行的块级嵌入 → 块占位
  const draft = (markdown ?? '')
    .split('\n')
    .map((line) => {
      const match = line.match(BLOCK_EMBED);
      if (!match) return line;
      blockTokens.push({ title: match[1].trim(), heading: match[2]?.trim() ?? null });
      return `@@LATTICE_BLOCK_${blockTokens.length - 1}@@`;
    })
    .join('\n');

  // 第二步：行内双链 / 行内嵌入 → 行内占位
  const tokenized = draft.replace(WIKI_LINK, (match, bang, target, heading, alias) => {
    const title = target.trim();
    if (!title) return match;
    inlineTokens.push(
      renderWikiReference({
        title,
        heading: heading?.trim() ?? null,
        alias: alias?.trim() ?? null,
        isEmbed: bang === '!',
      }, ctx),
    );
    return `@@LATTICE_TOKEN_${inlineTokens.length - 1}@@`;
  });

  let html = renderToHtml(tokenized);

  // 第三步：回填块级嵌入（连同包裹它的 <p> 一起去掉，避免 div 落进 p 的非法结构）
  html = html.replace(new RegExp(`<p>\\s*${BLOCK_TOKEN.source}\\s*</p>`, 'g'), (m, i) =>
    blockTokens[Number(i)] ? renderBlockEmbed(blockTokens[Number(i)], ctx) : m,
  );
  html = html.replace(BLOCK_TOKEN, (m, i) =>
    blockTokens[Number(i)] ? renderBlockEmbed(blockTokens[Number(i)], ctx) : m,
  );

  // 第四步：回填行内占位
  html = html.replace(INLINE_TOKEN, (m, i) => inlineTokens[Number(i)] ?? '');

  return html;
}

/** 行内双链 / 嵌入引用的静态降级呈现 */
function renderWikiReference({ title, heading, alias, isEmbed }, ctx) {
  const target = ctx.resolveTarget(title);
  const label = escapeHtml(alias || title);
  const anchor = heading ? `#${slugifyHeading(heading)}` : '';

  if (isEmbed) {
    // 行内嵌入在静态站点里降级为一条带标记的链接
    if (!target) return `<span class="embed-chip is-dangling" title="目标笔记不存在">${label}</span>`;
    return `<a class="embed-chip" href="${escapeHtml(target.href + anchor)}" title="嵌入引用">${label}</a>`;
  }

  if (!target) return `<span class="wiki-link is-dangling" title="指向尚未创建的笔记">${label}</span>`;
  return `<a class="wiki-link" href="${escapeHtml(target.href + anchor)}">${label}</a>`;
}

/** 块级嵌入：内联目标笔记正文（深度 + 环保护） */
function renderBlockEmbed({ title, heading }, ctx) {
  const target = ctx.resolveTarget(title);
  const linkLabel = escapeHtml(title);
  const anchor = heading ? `#${slugifyHeading(heading)}` : '';

  if (!target) {
    return (
      `<div class="note-embed is-dangling"><div class="note-embed__head">嵌入 · <span>${linkLabel}</span></div>` +
      '<div class="note-embed__body"><span class="note-embed__hint">目标笔记尚不存在</span></div></div>'
    );
  }

  const head = `<div class="note-embed__head">嵌入 · <a class="wiki-link" href="${escapeHtml(target.href + anchor)}">${linkLabel}</a></div>`;

  if (ctx.stack.has(target.id) || ctx.depth >= EMBED_MAX_DEPTH) {
    return `<div class="note-embed">${head}<div class="note-embed__body"><span class="note-embed__hint">为避免循环引用，此处仅链接</span></div></div>`;
  }

  const inner = renderMarkdownToFragment(target.content, {
    ...ctx,
    stack: new Set([...ctx.stack, target.id]),
    depth: ctx.depth + 1,
  });
  return `<div class="note-embed">${head}<div class="note-embed__body">${inner}</div></div>`;
}

/** 把正文里同源的 /attachments/<stored> 改写为相对当前页的 ../attachments/<stored> */
function rewriteAttachmentPaths(html) {
  return html.replace(/(src|href)="\/attachments\//g, '$1="../attachments/');
}

function pageShell({ title, bodyHtml, depth = 1 }) {
  const rel = depth === 1 ? '../' : '';
  return `<!doctype html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${rel}assets/style.css">
</head>
<body>
<article class="page">
<nav class="crumb"><a href="${rel}index.html">← 返回目录</a></nav>
${bodyHtml}
</article>
</body>
</html>
`;
}

function renderNotePage(note, ctx) {
  const meta = noteMeta(note, ctx);
  const body = rewriteAttachmentPaths(
    renderMarkdownToFragment(note.content, { ...ctx, stack: new Set([note.id]), depth: 0 }),
  );
  return pageShell({
    title: note.title,
    bodyHtml:
      `<header class="note-head"><h1>${escapeHtml(note.title)}</h1>` +
      `<div class="note-meta">${meta}</div></header>` +
      `<div class="note-body">${body}</div>`,
  });
}

function noteMeta(note, ctx) {
  const parts = [];
  const folderPath = ctx.folderPath(note.folderId);
  if (folderPath.length) parts.push(`📁 ${folderPath.map(escapeHtml).join(' / ')}`);
  const updated = formatDate(note.updatedAt);
  if (updated) parts.push(`更新于 ${escapeHtml(updated)}`);
  const tags = extractTags(note.content);
  if (tags.length) {
    parts.push(
      tags
        .map((t) => `<a class="tag-chip" href="../index.html#tag-${slugifyHeading(t)}">#${escapeHtml(t)}</a>`)
        .join(' '),
    );
  }
  return parts.join(' <span class="dot">·</span> ');
}

function renderIndexPage(ctx) {
  const { notes, folders, folderPathOf, titleToFile } = ctx;
  const stats = notesRepository.statistics();

  // 按目录路径分组
  /** @type {Map<string, typeof notes>} */
  const groups = new Map();
  for (const note of notes) {
    const key = folderPathOf(note.folderId).join(' / ') || '未归类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(note);
  }
  const groupNames = [...groups.keys()].sort((a, b) => {
    if (a === '未归类') return 1;
    if (b === '未归类') return -1;
    return a.localeCompare(b, 'zh');
  });

  const sections = groupNames
    .map((name) => {
      const cards = groups.get(name)
        .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.title.localeCompare(b.title, 'zh'))
        .map((n) => noteCard(n, titleToFile))
        .join('\n');
      return `<section class="folder-group"><h2>${escapeHtml(name)}</h2><div class="cards">${cards}</div></section>`;
    })
    .join('\n');

  // 标签索引
  const tagMap = new Map();
  for (const note of notes) {
    for (const t of extractTags(note.content)) {
      if (!tagMap.has(t)) tagMap.set(t, []);
      tagMap.get(t).push(note);
    }
  }
  const tagIndex = [...tagMap.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh'))
    .map(
      ([t, list]) =>
        `<div class="tag-row" id="tag-${slugifyHeading(t)}"><span class="tag-row__name">#${escapeHtml(t)}</span>` +
        `<span class="tag-row__items">${list
          .map((n) => `<a href="notes/${encodeURIComponent(titleToFile.get(n.id))}">${escapeHtml(n.title)}</a>`)
          .join('、')}</span></div>`,
    )
    .join('\n');

  const body =
    `<header class="index-head"><h1>格物 · 知识库</h1>` +
    `<p class="index-sub">${stats.noteCount} 篇笔记 · ${stats.folderCount} 个目录 · ${stats.tagCount} 个标签 · 共 ${stats.totalWords} 字</p></header>` +
    `<nav class="index-toc"><a href="#toc-notes">目录</a><a href="#toc-tags">标签</a></nav>` +
    `<div id="toc-notes">${sections}</div>` +
    (tagIndex ? `<h2 id="toc-tags" class="index-tagsh">标签</h2><div class="tags">${tagIndex}</div>` : '');

  return pageShell({ title: '格物 · 知识库', bodyHtml: body, depth: 0 });
}

function noteCard(note, titleToFile) {
  const plain = toPlainText(note.content);
  const excerpt = escapeHtml(plain.length > 120 ? `${plain.slice(0, 120)}…` : plain);
  const updated = formatDate(note.updatedAt);
  return (
    `<a class="card" href="notes/${encodeURIComponent(titleToFile.get(note.id))}">` +
    `<h3>${note.isPinned ? '📌 ' : ''}${escapeHtml(note.title)}</h3>` +
    (excerpt ? `<p class="card__excerpt">${excerpt}</p>` : '') +
    (updated ? `<span class="card__date">${escapeHtml(updated)}</span>` : '') +
    `</a>`
  );
}

function styleCss() {
  return `:root{--bg:#f6f7f9;--panel:#fff;--ink:#20242b;--ink-soft:#5b6572;--line:#e4e8ee;--accent:#0f6153;--dangling:#b4b9c2;--code:#e5efec;max-width:1px}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--panel:#1d2027;--ink:#e6e9ef;--ink-soft:#9aa4b2;--line:#2a2e37;--accent:#46c6a8;--dangling:#4c525c;--code:#20242c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.page{max-width:760px;margin:0 auto;padding:40px 24px 96px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
img{max-width:100%;height:auto;border-radius:8px}
pre{background:var(--code);padding:14px 16px;border-radius:10px;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
:not(pre)>code{background:var(--code);padding:.1em .4em;border-radius:5px}
blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--line);color:var(--ink-soft)}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left}
hr{border:none;border-top:1px solid var(--line);margin:2em 0}
.crumb{margin-bottom:24px;font-size:14px}.crumb a{color:var(--ink-soft)}
.note-head h1{margin:.2em 0 .3em;font-size:30px;line-height:1.3}
.note-meta{color:var(--ink-soft);font-size:13px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}.note-meta .dot{opacity:.5}
.tag-chip{color:var(--accent);font-size:13px}
.wiki-link.is-dangling{color:var(--dangling);border-bottom:1px dashed var(--dangling);cursor:default;text-decoration:none}
.embed-chip{display:inline-block;padding:0 .4em;border-radius:5px;background:var(--panel);border:1px solid var(--line);font-size:.9em}
.embed-chip.is-dangling{color:var(--dangling)}
.note-embed{margin:1em 0;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;background:var(--panel);overflow:hidden}
.note-embed__head{padding:6px 12px;font-size:12px;color:var(--ink-soft);background:rgba(127,127,127,.06);border-bottom:1px solid var(--line)}
.note-embed__body{padding:4px 14px 10px}.note-embed__body>:first-child{margin-top:.3em}
.note-embed.is-dangling{border-left-color:var(--dangling)}.note-embed__hint{color:var(--dangling);font-size:13px}
.index-head h1{margin:0 0 6px;font-size:32px}.index-sub{color:var(--ink-soft);margin:0}
.index-toc{margin:20px 0;display:flex;gap:16px;font-size:14px}
.folder-group{margin:32px 0}.folder-group h2{font-size:15px;color:var(--ink-soft);text-transform:none;border-bottom:1px solid var(--line);padding-bottom:6px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:14px}
.card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;color:inherit;transition:transform .12s,box-shadow .12s}
.card:hover{text-decoration:none;transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.08)}
.card h3{margin:0 0 6px;font-size:16px}.card__excerpt{margin:0;color:var(--ink-soft);font-size:13px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card__date{display:inline-block;margin-top:10px;color:var(--dangling);font-size:12px}
.index-tagsh{margin-top:40px}.tags{display:flex;flex-direction:column;gap:8px}.tag-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.tag-row__name{min-width:120px;color:var(--accent);font-weight:600}.tag-row__items{color:var(--ink-soft)}
@media print{.crumb,.index-toc{display:none}body{background:#fff;color:#000}.card{break-inside:avoid}}`;
}

/**
 * 导出整个知识库为静态站点。
 * @returns {{ dir: string, run: string, entry: string, noteCount: number, attachmentCount: number, generatedAt: string }}
 */
export function exportStatic() {
  // 正文 + 轻量投影合并成渲染所需的完整笔记视图
  const brief = new Map(notesRepository.listBrief().map((b) => [b.id, b]));
  const notes = notesRepository.listContents().map((n) => {
    const b = brief.get(n.id) ?? {};
    return { ...n, folderId: b.folderId ?? null, isPinned: b.isPinned ?? false, updatedAt: b.updatedAt ?? '' };
  });

  if (notes.length === 0) {
    throw new BadRequestError('知识库为空，没有可导出的笔记');
  }

  const folders = foldersRepository.findAll();
  const { pathOf } = buildFolderPathMap(folders);
  const titleIndex = buildTitleIndex(notes);

  // 每篇笔记一个稳定文件名：slug + id 前 8 位（去重、避免同名互覆盖）
  const fileByNoteId = new Map();
  for (const note of notes) {
    fileByNoteId.set(note.id, `${slugifyFile(note.title)}-${note.id.slice(0, 8)}.html`);
  }
  const titleToFile = fileByNoteId; // 首页/引用统一用文件名映射

  const ctx = {
    notes,
    folders,
    titleToFile,
    folderPath: pathOf,
    folderPathOf: pathOf,
    resolveTarget(title) {
      const target = titleIndex.get(title.toLowerCase());
      if (!target) return null;
      return { id: target.id, href: fileByNoteId.get(target.id), content: target.content };
    },
  };

  const now = new Date();
  const run = `site-${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const dir = path.join(config.exportDir, run);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });

  // 渲染并写每篇笔记
  for (const note of notes) {
    const html = renderNotePage(note, ctx);
    fs.writeFileSync(path.join(dir, 'notes', fileByNoteId.get(note.id)), html, 'utf8');
  }

  // 首页
  fs.writeFileSync(path.join(dir, 'index.html'), renderIndexPage(ctx), 'utf8');
  fs.writeFileSync(path.join(dir, 'assets', 'style.css'), styleCss(), 'utf8');

  // 复制被引用到的附件
  const referenced = new Set();
  for (const note of notes) {
    for (const m of (note.content ?? '').matchAll(ATTACH_REF)) referenced.add(m[1]);
  }
  let attachmentCount = 0;
  for (const stored of referenced) {
    const src = path.join(config.attachmentsDir, stored);
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dir, 'attachments', stored));
        attachmentCount += 1;
      }
    } catch {
      // 文件缺失不阻断导出
    }
  }

  return {
    dir,
    run,
    entry: `/export/${run}/index.html`,
    noteCount: notes.length,
    attachmentCount,
    generatedAt: nowStamp(),
  };
}

function nowStamp() {
  return new Date().toISOString();
}
