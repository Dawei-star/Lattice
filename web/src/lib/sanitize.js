/**
 * 极简 HTML 消毒器（白名单策略）。
 *
 * 为什么需要它：Markdown 渲染器会原样输出正文里的 HTML，而正文可能来自复制粘贴的
 * 网页内容。即便这是本地单机应用，直接 innerHTML 注入原始 HTML 仍然是一条真实的 XSS 路径
 * （比如恶意笔记或剪藏内容里的 <img onerror>）。
 *
 * 做法：用浏览器原生 DOMParser 解析成文档树，自顶向下按白名单裁剪，
 * 再序列化回字符串。不引入 DOMPurify 是为了不为一个 80 行的需求加一个依赖。
 */

/** 允许保留的标签 */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR', 'DIV', 'SPAN',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'MARK', 'U', 'SUP', 'SUB',
  'CODE', 'PRE', 'KBD', 'SAMP',
  'BLOCKQUOTE', 'UL', 'OL', 'LI',
  'A', 'IMG',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
  'INPUT', 'DETAILS', 'SUMMARY',
]);

/** 命中即整个子树删除的标签（连内容一起丢弃） */
const DROP_ENTIRELY = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED',
  'APPLET', 'LINK', 'META', 'BASE', 'FORM', 'TEMPLATE', 'NOSCRIPT',
  'SVG', 'MATH', 'AUDIO', 'VIDEO', 'CANVAS',
]);

/** 允许保留的属性（全局 + 按标签） */
const GLOBAL_ATTRS = new Set(['class', 'title', 'dir', 'lang']);
const TAG_ATTRS = {
  A: new Set(['href', 'rel', 'target']),
  IMG: new Set(['src', 'alt', 'width', 'height', 'loading']),
  INPUT: new Set(['type', 'checked', 'disabled']),
  TD: new Set(['colspan', 'rowspan', 'align']),
  TH: new Set(['colspan', 'rowspan', 'align', 'scope']),
  OL: new Set(['start', 'type']),
  CODE: new Set(['class']),
  PRE: new Set(['class']),
  SPAN: new Set(['class']),
  DIV: new Set(['class']),
  DETAILS: new Set(['open']),
};

/** data-* 只放行我们自己的这几个前缀，避免任意数据集注入 */
const ALLOWED_DATA_ATTRS = new Set(['data-wiki-title', 'data-wiki-heading', 'data-embed-title', 'data-embed-state']);

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function isSafeUrl(rawValue) {
  const value = rawValue.trim();
  if (value === '') return false;
  // 相对路径与锚点放行；//host 形式的协议相对 URL 不放行——
  // 它指向外部站点（如 //evil.com/pixel.gif），属于绕过白名单的外链
  if (value.startsWith('//')) return false;
  if (value.startsWith('/') || value.startsWith('#') || value.startsWith('./') || value.startsWith('../')) return true;
  // 协议外的 data: 一律拒绝（data:text/html 可执行脚本），只允许 data:image
  if (/^data:/i.test(value)) return /^data:image\//i.test(value);

  try {
    return SAFE_URL_PROTOCOLS.has(new URL(value, window.location.origin).protocol);
  } catch {
    return false;
  }
}

function cleanElement(element) {
  const tag = element.tagName;

  if (DROP_ENTIRELY.has(tag)) {
    element.remove();
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    // 未知但无害的标签：去掉标签本身，保留内部文本
    for (const child of [...element.children]) cleanElement(child);
    element.replaceWith(...element.childNodes);
    return;
  }

  const allowed = TAG_ATTRS[tag] ?? new Set();
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    const isDataAttr = name.startsWith('data-') && ALLOWED_DATA_ATTRS.has(name);
    const isAllowed = GLOBAL_ATTRS.has(name) || allowed.has(name) || isDataAttr;

    // 任何 on* 事件处理器都不在白名单里，天然被剔除
    if (!isAllowed) {
      element.removeAttribute(attribute.name);
      continue;
    }

    if ((name === 'href' || name === 'src') && !isSafeUrl(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }

  // 外链统一加 noopener/noreferrer，避免 window.opener 劫持
  if (tag === 'A') {
    if (element.getAttribute('href')) {
      element.setAttribute('rel', 'noopener noreferrer');
      element.setAttribute('target', '_blank');
    } else {
      element.removeAttribute('target');
    }
  }

  // 复选框只允许只读展示，防止渲染结果被当成表单
  if (tag === 'INPUT' && element.getAttribute('type') !== 'checkbox') {
    element.remove();
    return;
  }
  if (tag === 'INPUT') element.setAttribute('disabled', '');

  for (const child of [...element.children]) cleanElement(child);
}

/**
 * @param {string} html
 * @returns {string} 安全可注入的 HTML
 */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div id="lattice-root">${html}</div>`, 'text/html');
  const root = doc.getElementById('lattice-root');
  if (!root) return '';

  for (const child of [...root.children]) cleanElement(child);
  return root.innerHTML;
}
