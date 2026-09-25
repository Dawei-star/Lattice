/**
 * Markdown 语义解析（纯函数，无副作用，便于单测）。
 * 负责从正文里抽出双向链接与标签 —— 这是「类 Obsidian」体验的核心。
 *
 * 支持的语法：
 *   [[目标笔记]]              基础双链
 *   [[目标笔记|显示别名]]      带别名
 *   [[目标笔记#标题]]          指向标题
 *   ![[目标笔记]]              嵌入引用（同样记入图谱）
 *   #标签  #标签/子标签        标签
 */

/** 围栏代码块与行内代码：解析前先剔除，避免把代码里的 # 和 [[ 误判 */
const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE = /`[^`\n]*`/g;

function stripCode(text) {
  return text.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ');
}

/** 捕获组：1=是否嵌入(!)，2=目标标题，3=标题锚点，4=显示别名 */
const WIKI_LINK = /(!?)\[\[([^[\]|#]+?)(?:#([^[\]|]+?))?(?:\|([^[\]]+?))?\]\]/g;

/**
 * 抽取正文中的双向链接（同一目标只保留一条，附带出现次数）。
 * @param {string} rawContent
 * @returns {Array<{ target: string, heading: string | null, alias: string | null, isEmbed: boolean, count: number }>}
 */
export function extractWikiLinks(rawContent) {
  const text = stripCode(rawContent ?? '');
  /** @type {Map<string, { target: string, heading: string | null, alias: string | null, isEmbed: boolean, count: number }>} */
  const found = new Map();

  for (const match of text.matchAll(WIKI_LINK)) {
    const target = (match[2] ?? '').trim();
    if (!target) continue;

    const key = target.toLowerCase();
    const existing = found.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    found.set(key, {
      target,
      heading: match[3]?.trim() ?? null,
      alias: match[4]?.trim() ?? null,
      isEmbed: match[1] === '!',
      count: 1,
    });
  }

  return [...found.values()];
}

/**
 * 标签：标签必须以字母或汉字开头，避免把 #2024 这类纯数字误认为标签。
 *
 * 边界判定用「前置否定断言」而不是「前置字符白名单」：
 * 只要 # 前面不是字母/数字/下划线/#//，就算一个标签。
 * 白名单写法会把中文标点（：、，、。、「）后的标签全部漏掉。
 */
const TAG = /(?<![\p{L}\p{N}_#/])#([\p{L}\p{N}_\-/]{1,64})/gu;

/**
 * 抽取正文中的标签。
 * @param {string} rawContent
 * @returns {string[]}
 */
export function extractTags(rawContent) {
  const text = stripCode(rawContent ?? '');
  /** @type {Set<string>} */
  const tags = new Set();

  for (const match of text.matchAll(TAG)) {
    const name = match[1].replace(/[/\-_]+$/, '').trim();
    // 至少要含一个字母/汉字，#123456 这类不算标签
    if (name && /[\p{L}]/u.test(name)) tags.add(name);
  }

  return [...tags];
}

/**
 * 中英混排字数统计：汉字按字计，拉丁字母按词计。
 * @param {string} text
 */
export function computeWordCount(text) {
  const cjk = (text ?? '').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin = (text ?? '').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return cjk + latin;
}

/**
 * Markdown 转纯文本：去掉语法符号，保留可读内容，用于列表摘要与搜索片段。
 * 刻意不生成 HTML —— 前端拿到纯文本后自行高亮，从根本上规避 XSS。
 * @param {string} markdown
 */
export function toPlainText(markdown) {
  return (markdown ?? '')
    // 只去掉围栏标记行，保留其中的代码内容 —— 摘要是给人看的，代码也是内容
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, ' ')
    // 行内代码去掉反引号但保留内容，同样是为了不丢信息
    .replace(INLINE_CODE, (matched) => matched.slice(1, -1))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/!?\[\[([^[\]|#]+?)(?:#([^[\]|]+?))?(?:\|([^[\]]+?))?\]\]/g, (_m, target, _heading, alias) => alias || target)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`~>]/g, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从正文首行推断标题（新建笔记时若未指定标题，用一级标题或首行非空文本兜底）。
 *
 * 需要显式跟踪代码围栏状态：只按「行首是不是 ```」跳过是不够的，
 * 围栏内部的内容行同样不能被当成候选标题，否则一篇以代码开头的笔记会被命名为 "code"。
 * @param {string} content
 */
export function inferTitle(content) {
  const lines = (content ?? '').split('\n');
  /** @type {string[]} */
  const candidates = [];
  let insideFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^(```|~~~)/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence || line.length === 0) continue;

    candidates.push(line);
  }

  const heading = candidates.find((line) => /^#{1,6}\s+\S/.test(line));
  if (heading) return heading.replace(/^#{1,6}\s+/, '').slice(0, 200);

  const firstText = candidates[0];
  if (firstText) return firstText.replace(/[*_`>~]/g, '').slice(0, 200);

  return '未命名笔记';
}
