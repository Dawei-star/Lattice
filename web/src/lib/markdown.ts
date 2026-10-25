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
import { Marked, marked } from 'marked';
import { sanitizeHtml } from './sanitize.ts';
import { highlightCode, isHighlightLanguage, normalizeLanguageLabel } from './highlight.ts';

// headerIds / mangle 在 marked v5+ 已移除，v14 传了也只是静默忽略，不再保留
marked.setOptions({ gfm: true, breaks: false });

// AI 消息专用实例：代码围栏渲染为带工具栏的增强块（语言标签/复制/换行/高亮）。
// 笔记正文与静态导出走全局 marked 实例，输出保持 marked 默认，互不影响。
const TOOLBAR_MARKED = new Marked({ gfm: true, breaks: false });
TOOLBAR_MARKED.use({
  renderer: {
    // 兼容两种签名：v13+ 的 token 对象与旧版的 (code, lang) 位置参数
    code(tokenOrText: unknown, legacyLang?: string): string {
      const token = tokenOrText as { text?: unknown; lang?: unknown } | null;
      const source = token && typeof token === 'object'
        ? String(token.text ?? '')
        : String(tokenOrText ?? '');
      const langRaw = token && typeof token === 'object' ? token.lang : legacyLang;
      const lang = normalizeLanguageLabel(String(langRaw ?? ''));
      const codeClass = isHighlightLanguage(lang) ? `hljs language-${lang}` : '';
      return (
        '<div class="ai-code">' +
        '<div class="ai-code__head">' +
        `<span class="ai-code__lang">${lang ? escapeHtml(lang) : 'text'}</span>` +
        '<span class="ai-code__tools">' +
        '<button type="button" class="ai-code-wrap" aria-label="切换自动换行">换行</button>' +
        '<button type="button" class="ai-code-copy" aria-label="复制代码">复制</button>' +
        '</span></div>' +
        `<pre><code${codeClass ? ` class="${codeClass}"` : ''}>${highlightCode(source.replace(/\n$/, ''), lang)}</code></pre>` +
        '</div>\n'
      );
    },
  },
});

/** 捕获组：1=是否嵌入(!)，2=目标标题，3=标题锚点，4=显示别名 */
const WIKI_LINK = /(!?)\[\[([^[\]|#]+?)(?:#([^[\]|]+?))?(?:\|([^[\]]+?))?\]\]/g;
/** 独占一行的嵌入语法 */
const BLOCK_EMBED = /^[ \t]*!\[\[([^[\]|#]+?)(?:#([^[\]|]+?))?(?:\|[^[\]]+?)?\]\][ \t]*$/;

const BLOCK_TOKEN = /@@LATTICE_BLOCK_(\d+)@@/g;
const INLINE_TOKEN = /@@LATTICE_TOKEN_(\d+)@@/g;
const CODE_SPAN = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

/** renderMarkdown 的选项。 */
export interface RenderMarkdownOptions {
  /** 双链标题解析器：返回真值表示笔记已存在（返回对象可携带 id/filePath 等字段） */
  resolveTitle?: (title: string) => unknown;
  /** 资源引用 → 可访问 URL（返回 null 表示无法解析） */
  resolveAsset?: ((reference: string) => string | null) | null;
  /** AI 消息专用：代码围栏渲染为带语言标签/复制/换行工具栏的增强块（默认 false 走 marked 原样输出） */
  codeToolbar?: boolean;
}

/** 编辑器大纲条目（start 为源文本偏移量）。 */
export interface OutlineEntry {
  level: number;
  text: string;
  start: number;
  index: number;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渲染 Markdown：已完成消毒、可安全注入的 HTML。
 */
export function renderMarkdown(source: string | null | undefined, options: RenderMarkdownOptions = {}): string {
  const resolveTitle = options.resolveTitle ?? (() => null);
  const resolveAsset = options.resolveAsset ?? (() => null);
  const text = source ?? '';

  const blockTokens: string[] = [];
  const inlineTokens: string[] = [];
  const pushInline = (html: string): string => {
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
  const tokenized = replaceOutsideCode(draft, (segment) => segment.replace(WIKI_LINK, (match: string, bang: string, target: string, heading: string, alias: string) => {
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

  const parsed = (options.codeToolbar ? TOOLBAR_MARKED : marked).parse(tokenized, { async: false });
  let html = typeof parsed === 'string' ? parsed : '';
  html = rewriteAssetUrls(html, resolveAsset);

  // ── 第三步：回填块级嵌入 ──────────────────────────────────────
  // 块级嵌入被 marked 包进了 <p>，需要连同 <p> 一起去掉，否则 div 嵌在 p 里是非法结构
  html = html.replace(new RegExp(`<p>\\s*${BLOCK_TOKEN.source}\\s*</p>`, 'g'), (match: string, index: string) => {
    const title = blockTokens[Number(index)];
    return title === undefined ? match : renderBlockEmbed(title, resolveTitle);
  });
  html = html.replace(BLOCK_TOKEN, (match: string, index: string) => {
    const title = blockTokens[Number(index)];
    return title === undefined ? match : renderBlockEmbed(title, resolveTitle);
  });

  // ── 第四步：回填行内占位 ──────────────────────────────────────
  html = html.replace(INLINE_TOKEN, (match: string, index: string) => inlineTokens[Number(index)] ?? '');

  return sanitizeHtml(html);
}

function rewriteAssetUrls(html: string, resolveAsset: (reference: string) => string | null): string {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)("[^>]*>)/gi, (match: string, prefix: string, source: string, suffix: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) return match;
    try {
      const resolved = resolveAsset(source);
      return resolved ? `${prefix}${escapeHtml(resolved)}${suffix}` : match;
    } catch {
      return match;
    }
  });
}

function replaceOutsideCode(source: string, replace: (segment: string) => string): string {
  let result = '';
  let cursor = 0;
  for (const match of source.matchAll(CODE_SPAN)) {
    result += replace(source.slice(cursor, match.index));
    result += match[0];
    cursor = match.index! + match[0].length;
  }
  return result + replace(source.slice(cursor));
}

function renderBlockEmbed(title: string, resolveTitle: (title: string) => unknown): string {
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
 */
export function collectEmbedTargets(source: string | null | undefined): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();

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
 */
export function highlightText(text: string | null | undefined, query: string | null | undefined): string {
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

/**
 * Extract headings for the editor outline without treating fenced code as
 * document structure. `start` is a source offset, so editors can jump without
 * reparsing the document or keeping a second document model.
 */
export function parseOutline(source: string | null | undefined): OutlineEntry[] {
  const headings: OutlineEntry[] = [];
  let offset = 0;
  let insideFence = false;

  for (const line of String(source ?? '').split('\n')) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence) {
      insideFence = !insideFence;
    } else if (!insideFence) {
      const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
      if (match) {
        const text = match[2].replace(/\s+#+\s*$/, '').trim();
        if (text) {
          headings.push({
            level: match[1].length,
            text,
            start: offset,
            index: headings.length,
          });
        }
      }
    }
    offset += line.length + 1;
  }

  return headings;
}

/** Stable heading comparison used by the editor and AI note navigation. */
export function headingAnchor(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** Locate an excerpt in Markdown while tolerating line wrapping differences. */
export function findMarkdownSourceMatch(source: string | null | undefined, excerpt: string | null | undefined): { start: number; end: number } | null {
  const text = String(source ?? '');
  const needle = String(excerpt ?? '').replace(/\s+/g, ' ').trim();
  if (!text || !needle) return null;
  const direct = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (direct >= 0) return { start: direct, end: direct + needle.length };
  const compactText = text.replace(/\s+/g, ' ');
  const compactIndex = compactText.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (compactIndex < 0) return null;
  let sourceIndex = 0;
  let compactCursor = 0;
  while (sourceIndex < text.length && compactCursor < compactIndex) {
    if (/\s/.test(text[sourceIndex])) {
      while (sourceIndex < text.length && /\s/.test(text[sourceIndex])) sourceIndex += 1;
      compactCursor += 1;
    } else {
      sourceIndex += 1;
      compactCursor += 1;
    }
  }
  return { start: sourceIndex, end: Math.min(text.length, sourceIndex + needle.length) };
}
