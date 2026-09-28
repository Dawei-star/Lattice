/**
 * 前端 Markdown 渲染管线。
 *
 * 顺序：抽取 [[双链]] 与 ![[嵌入]] 为占位 token → marked 解析 → 回填自定义 HTML → 消毒。
 * 必须先抽 token 再交给 marked：否则 [[...]] 的方括号会被 Markdown 的链接语法吃掉。
 *
 * 两类占位分开存放，避免索引互相污染：
 *   @@LATTICE_BLOCK_n@@  独占一行的块级嵌入（渲染成卡片并异步载入目标笔记）
 *   @@LATTICE_TOKEN_n@@  行内的双链 / 行内嵌入
 */
import { marked } from 'marked';
import { sanitizeHtml } from './sanitize.js';

marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

/** 捕获组：1=是否嵌入(!)，2=目标标题，3=标题锚点，4=显示别名 */
const WIKI_LINK = /(!?)\[\[([^[\]|#]+?)(?:#([^[\]|]+?))?(?:\|([^[\]]+?))?\]\]/g;
/** 独占一行的嵌入语法 */
const BLOCK_EMBED = /^[ \t]*!\[\[([^[\]|#]+?)(?:#([^[\]|]+?))?(?:\|[^[\]]+?)?\]\][ \t]*$/;

const BLOCK_TOKEN = /@@LATTICE_BLOCK_(\d+)@@/g;
const INLINE_TOKEN = /@@LATTICE_TOKEN_(\d+)@@/g;
const CODE_SPAN = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {string} source Markdown 正文
 * @param {{ resolveTitle?: (title: string) => { id: string } | null }} [options]
 * @returns {string} 已完成消毒、可安全注入的 HTML
 */
export function renderMarkdown(source, options = {}) {
  const resolveTitle = options.resolveTitle ?? (() => null);
  const text = source ?? '';

  /** @type {string[]} */
  const blockTokens = [];
  /** @type {string[]} */
  const inlineTokens = [];
  const pushInline = (html) => {
    inlineTokens.push(html);
    return `@@LATTICE_TOKEN_${inlineTokens.length - 1}@@`;
  };

  // ── 第一步：把独占一行的嵌入替换成块级占位 ──────────────────────
  const draft = replaceOutsideCode(text, (segment) => segment
    .split('\n')
    .map((line) => {
      const match = line.match(BLOCK_EMBED);
      if (!match) return line;
      blockTokens.push(match[1].trim());
      return `@@LATTICE_BLOCK_${blockTokens.length - 1}@@`;
    })
    .join('\n'));

  // ── 第二步：把行内双链 / 行内嵌入替换成行内占位 ────────────────
  const tokenized = replaceOutsideCode(draft, (segment) => segment.replace(WIKI_LINK, (match, bang, target, heading, alias) => {
    const title = target.trim();
    if (!title) return match;

    if (bang === '!') {
      return pushInline(
        `<span class="embed-chip" data-wiki-title="${escapeHtml(title)}" title="嵌入引用（点击打开）">${escapeHtml(title)}</span>`,
      );
    }

    const resolved = resolveTitle(title);
    const headingAttr = heading ? ` data-wiki-heading="${escapeHtml(heading.trim())}"` : '';
    const hint = resolved ? '打开这篇笔记' : '点击创建缺失的笔记';

    return pushInline(
      `<a class="wiki-link${resolved ? '' : ' is-dangling'}" href="#" data-wiki-title="${escapeHtml(title)}"${headingAttr} title="${escapeHtml(hint)}">${escapeHtml(alias?.trim() || title)}</a>`,
    );
  }));

  const parsed = marked.parse(tokenized, { async: false });
  let html = typeof parsed === 'string' ? parsed : '';

  // ── 第三步：回填块级嵌入 ──────────────────────────────────────
  // 块级嵌入被 marked 包进了 <p>，需要连同 <p> 一起去掉，否则 div 嵌在 p 里是非法结构
  html = html.replace(new RegExp(`<p>\\s*${BLOCK_TOKEN.source}\\s*</p>`, 'g'), (match, index) => {
    const title = blockTokens[Number(index)];
    return title === undefined ? match : renderBlockEmbed(title, resolveTitle);
  });
  html = html.replace(BLOCK_TOKEN, (match, index) => {
    const title = blockTokens[Number(index)];
    return title === undefined ? match : renderBlockEmbed(title, resolveTitle);
  });

  // ── 第四步：回填行内占位 ──────────────────────────────────────
  html = html.replace(INLINE_TOKEN, (match, index) => inlineTokens[Number(index)] ?? '');

  return sanitizeHtml(html);
}

function replaceOutsideCode(source, replace) {
  let result = '';
  let cursor = 0;
  for (const match of source.matchAll(CODE_SPAN)) {
    result += replace(source.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + replace(source.slice(cursor));
}

function renderBlockEmbed(title, resolveTitle) {
  const resolved = resolveTitle(title);
  const link = `<a class="wiki-link" href="#" data-wiki-title="${escapeHtml(title)}">${escapeHtml(title)}</a>`;

  if (!resolved) {
    return (
      `<div class="note-embed" data-embed-title="${escapeHtml(title)}" data-embed-state="missing">` +
      `<div class="note-embed__head"><span class="note-embed__badge">嵌入</span>${link}</div>` +
      '<div class="note-embed__body"><span class="note-embed__hint">目标笔记尚不存在，点击标题可创建</span></div>' +
      '</div>'
    );
  }

  return (
    `<div class="note-embed" data-embed-title="${escapeHtml(title)}" data-embed-state="loading">` +
    `<div class="note-embed__head"><span class="note-embed__badge">嵌入</span>${link}</div>` +
    '<div class="note-embed__body"><span class="note-embed__hint">正在载入…</span></div>' +
    '</div>'
  );
}

/**
 * 抽出正文中所有块级嵌入的目标标题，用于在渲染前并发预取内容。
 * @param {string} source
 * @returns {string[]}
 */
export function collectEmbedTargets(source) {
  const targets = [];
  const seen = new Set();

  for (const line of (source ?? '').split('\n')) {
    const match = line.match(BLOCK_EMBED);
    if (!match) continue;

    const title = match[1].trim();
    if (title && !seen.has(title.toLowerCase())) {
      seen.add(title.toLowerCase());
      targets.push(title);
    }
  }

  return targets;
}

/**
 * 把纯文本里命中的检索词包上 <mark>，用于搜索结果高亮。
 * 输出经由 escapeHtml 处理，不引入注入风险。
 * @param {string} text
 * @param {string} query
 */
export function highlightText(text, query) {
  const source = text ?? '';
  const needle = (query ?? '').trim();
  if (!needle) return escapeHtml(source);

  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();

  let result = '';
  let cursor = 0;

  for (;;) {
    const index = lowerSource.indexOf(lowerNeedle, cursor);
    if (index === -1) break;
    result += escapeHtml(source.slice(cursor, index));
    result += `<mark>${escapeHtml(source.slice(index, index + needle.length))}</mark>`;
    cursor = index + needle.length;
  }

  return result + escapeHtml(source.slice(cursor));
}
