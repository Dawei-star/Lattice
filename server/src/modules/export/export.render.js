/**
 * 静态站点导出的 Markdown → HTML 渲染器。
 *
 * 与前端实时渲染管线（web/src/lib/markdown.js）是「同源不同用」：
 *   - 前端：双链/嵌入是运行时的交互锚点（点击调 API 载入）；
 *   - 导出：所有内容在生成时已知，双链解析成指向兄弟页面的相对链接、
 *           块级嵌入直接内联目标正文，产出自包含、可离线打开的静态 HTML。
 *
 * 安全：导出页面可能被发布到公网，用户笔记里的手写 HTML / javascript: 链接
 * 必须失效。这里覆写 marked 的 html / link / image 渲染钩子，并为标题生成稳定 id：
 *   - html：把原文里的裸 HTML 转义成纯文本；
 *   - link / image：只放行 http(s)、mailto、站内相对与 # 锚点，其余协议丢弃；
 *   - heading：生成 id，供 [[笔记#标题]] 深链使用。
 * 我们自己注入的标签（双链、内联结果）在 escapeHtml 之后拼接，天然可信。
 */
import { Marked } from 'marked';

/** 与前端保持一致的双链语法捕获组：1=是否嵌入(!)，2=目标，3=标题锚点，4=别名 */
export const WIKI_LINK = /(!?)\[\[([^[\]|#]+?)(?:#([^[\]|]+?))?(?:\|([^[\]]+?))?\]\]/g;
/** 独占一行的块级嵌入 */
export const BLOCK_EMBED = /^[ \t]*!\[\[([^[\]|#]+?)(?:#([^[\]|]+?))?(?:\|[^[\]]+?)?\]\][ \t]*$/;

export const BLOCK_TOKEN = /@@LATTICE_BLOCK_(\d+)@@/g;
export const INLINE_TOKEN = /@@LATTICE_TOKEN_(\d+)@@/g;

const ALLOWED_URL = /^(?:https?:|mailto:)/i;
const DANGEROUS_URL = /^\s*(?:javascript|data|vbscript|file):/i;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** GitHub 风格标题锚点：小写、空格转连字符，保留 CJK 与字母数字 */
export function slugifyHeading(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 仅放行安全 URL；返回 null 表示应丢弃该链接/图片地址 */
export function sanitizeUrl(url) {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  if (DANGEROUS_URL.test(raw)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (!hasScheme) return raw; // 相对路径 / #锚点 / ./ ../ 放行
  return ALLOWED_URL.test(raw) ? raw : null;
}

/**
 * 覆写渲染钩子，产出「只渲染安全内容」的 renderer。
 * 用普通对象方法（marked v14 经 use() 注入并把 this 绑定到带 parser 的上下文），
 * 因此方法内可用 this.parser.parseInline 递归渲染子 token。
 */
const safeRenderer = {
  // 裸 HTML → 转义为文本，杜绝 <script> / onerror 注入
  html(token) {
    const raw = typeof token === 'string' ? token : token.text ?? '';
    return escapeHtml(raw);
  },

  link(token) {
    const label = this.parser.parseInline(token.tokens);
    const href = sanitizeUrl(token.href);
    if (!href) return label || escapeHtml(token.text ?? '');
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    return `<a href="${escapeHtml(href)}" rel="noopener noreferrer"${title}>${label}</a>`;
  },

  image(token) {
    const alt = escapeHtml(token.text ?? token.title ?? '');
    const href = sanitizeUrl(token.href);
    if (!href) return alt ? `【图片：${alt}】` : '';
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    return `<img src="${escapeHtml(href)}" alt="${alt}" loading="lazy"${title}>`;
  },

  heading(token) {
    const inner = this.parser.parseInline(token.tokens);
    const plain = inner.replace(/<[^>]+>/g, '');
    const id = slugifyHeading(plain);
    const anchor = id ? ` id="${escapeHtml(id)}"` : '';
    return `<h${token.depth}${anchor}>${inner}</h${token.depth}>\n`;
  },
};

const md = new Marked({ gfm: true, breaks: false });
md.use({ renderer: safeRenderer });

/**
 * 渲染一段 Markdown 为安全 HTML（不处理双链/嵌入，交给上层先做占位）。
 * @param {string} source
 * @returns {string}
 */
export function renderToHtml(source) {
  const out = md.parse(source ?? '', { async: false });
  return typeof out === 'string' ? out : '';
}
