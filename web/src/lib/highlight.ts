// AI 消息代码块高亮：内置轻量扫描器，输出 highlight.js 兼容的 class
// （hljs-keyword / hljs-string / hljs-comment / hljs-number / hljs-literal / hljs-built_in）。
// 设计取舍：不引入 highlight.js 依赖（沿用 sanitize.ts「不为小需求加依赖」的原则），
// 单遍扫描 注释/字符串/数字/关键词 覆盖常用语言的主要视觉结构；
// 后续若要升级，替换本文件实现即可，调用方与样式零改动。
// 未注册语言回退为纯文本（保留语言标签）。

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface LanguageSpec {
  keywords: Set<string>;
  builtins?: Set<string>;
  literals?: Set<string>;
  /** 行注释起始标记；`#` 类注释要求位于行首或空白之后。 */
  lineComments: string[];
  blockComments?: Array<readonly [string, string]>;
  /** 引号字符集合（含转义处理；遇换行即视为未闭合收尾）。 */
  strings: string[];
  /** 是否支持三引号长字符串（Python）。 */
  tripleQuotes?: boolean;
}

type SpecOptions = Omit<Partial<LanguageSpec>, 'builtins' | 'literals'> & {
  builtins?: string;
  literals?: string;
};

function spec(keywords: string, options: SpecOptions): LanguageSpec {
  return {
    keywords: new Set(keywords.split(/\s+/).filter(Boolean)),
    builtins: new Set((options.builtins ?? '').split(/\s+/).filter(Boolean)),
    literals: new Set((options.literals ?? '').split(/\s+/).filter(Boolean)),
    lineComments: options.lineComments ?? ['//'],
    blockComments: options.blockComments,
    strings: options.strings ?? ['"', "'"],
    tripleQuotes: options.tripleQuotes,
  };
}

const JS_SPEC = spec(
  'const let var function return if else for while do switch case break continue new typeof instanceof in of class extends super this import from export default try catch finally throw async await yield static get set delete void',
  {
    builtins: 'console window document JSON Math Object Array String Number Boolean Map Set WeakMap Promise Date RegExp Error Symbol globalThis fetch setTimeout require module exports localStorage',
    literals: 'true false null undefined NaN Infinity',
    strings: ['"', "'", '`'],
    blockComments: [['/*', '*/']],
  },
);

const LANGUAGES: Record<string, LanguageSpec> = {
  javascript: JS_SPEC,
  typescript: JS_SPEC,
  python: spec(
    'def class return if elif else for while break continue pass import from as with try except finally raise lambda global nonlocal assert yield async await del in is not and or match case',
    {
      builtins: 'print len range str int float bool list dict set tuple open type isinstance enumerate zip map filter sum min max abs sorted any all repr format input super self __init__ __name__',
      literals: 'None True False',
      lineComments: ['#'],
      strings: ['"', "'"],
      tripleQuotes: true,
    },
  ),
  rust: spec(
    'fn let mut const static if else match loop while for in break continue return pub use mod struct enum trait impl type where self Self crate super as move async await dyn ref unsafe extern',
    {
      builtins: 'println print vec String Vec Option Some None Result Ok Err Box Rc Arc HashMap BTreeMap format panic assert',
      literals: 'true false',
      strings: ['"'],
    },
  ),
  bash: spec(
    'if then else elif fi for while do done case esac function in select until return break continue local export readonly declare unset shift',
    {
      builtins: 'echo cd ls cat grep mkdir cp mv touch source alias which git',
      lineComments: ['#'],
      strings: ['"', "'"],
    },
  ),
  json: spec('', {
    literals: 'true false null',
    strings: ['"'],
    lineComments: [],
  }),
  yaml: spec('', {
    literals: 'true false null yes no on off',
    lineComments: ['#'],
    strings: ['"', "'"],
  }),
  sql: spec(
    'select from where and or not null is in like between join left right inner outer full cross on group by order having limit offset insert into values update set delete create table drop alter index view as distinct case when then else end union all exists primary key foreign references default asc desc with over partition',
    {
      lineComments: ['--'],
      blockComments: [['/*', '*/']],
      strings: ["'", '"'],
    },
  ),
  xml: spec('', {
    lineComments: [],
    blockComments: [['<!--', '-->']],
    strings: ['"', "'"],
  }),
  css: spec('', {
    lineComments: [],
    blockComments: [['/*', '*/']],
    strings: ['"', "'"],
  }),
  go: spec(
    'package import func var const type struct interface map chan go defer if else for range switch case default break continue return select fallthrough nil true false',
    {
      builtins: 'fmt println print len cap append make new panic recover',
      strings: ['"', "'", '`'],
    },
  ),
  java: spec(
    'public private protected class interface extends implements static final void int long double float boolean char byte short new return if else for while do switch case break continue try catch finally throw throws import package this super abstract synchronized volatile enum instanceof',
    {
      builtins: 'System String Math Object List Map ArrayList HashMap Integer Boolean',
      literals: 'true false null',
      strings: ['"'],
    },
  ),
  cpp: spec(
    'int char bool float double void long short unsigned signed const constexpr class struct enum union public private protected virtual override final namespace using template typename new delete this if else for while do switch case break continue return try catch throw auto nullptr static_cast',
    {
      builtins: 'std cout cin endl vector string printf scanf unique_ptr shared_ptr',
      literals: 'true false NULL',
      strings: ['"', "'"],
    },
  ),
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  html: 'xml',
  svg: 'xml',
  c: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  golang: 'go',
};

/** 把围栏信息串归一成语言标签：取首段、小写。 */
export function normalizeLanguageLabel(language: string | null | undefined): string {
  const value = String(language ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
  return /^[a-z0-9+#._-]*$/.test(value) ? value : '';
}

function resolveSpec(language: string): LanguageSpec | null {
  const name = LANGUAGE_ALIASES[language] ?? language;
  return LANGUAGES[name] ?? null;
}

/** 语言是否支持高亮（决定是否挂 hljs class）。 */
export function isHighlightLanguage(language: string): boolean {
  return language !== '' && resolveSpec(language) !== null;
}

function span(className: string, text: string): string {
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

/** 单遍扫描：块注释 → 行注释 → 三引号 → 字符串 → 数字 → 词。 */
export function highlightCode(code: string, language: string): string {
  const languageSpec = resolveSpec(language);
  if (!languageSpec) return escapeHtml(code);
  const { keywords, builtins, literals, lineComments, blockComments, strings, tripleQuotes } = languageSpec;

  let out = '';
  let index = 0;
  while (index < code.length) {
    const rest = code.slice(index);
    const current = code[index];

    const block = blockComments?.find(([open]) => rest.startsWith(open));
    if (block) {
      const end = code.indexOf(block[1], index + block[0].length);
      const stop = end === -1 ? code.length : end + block[1].length;
      out += span('hljs-comment', code.slice(index, stop));
      index = stop;
      continue;
    }

    // `#` 行注释只认行首/空白之后，避免 bash 的 $# 与 python 的 a#b 误伤
    const line = lineComments.find((open) =>
      rest.startsWith(open) && (open !== '#' || index === 0 || /\s/.test(code[index - 1])));
    if (line) {
      let end = code.indexOf('\n', index);
      if (end === -1) end = code.length;
      out += span('hljs-comment', code.slice(index, end));
      index = end;
      continue;
    }

    if (tripleQuotes && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3);
      const end = code.indexOf(quote, index + 3);
      const stop = end === -1 ? code.length : end + 3;
      out += span('hljs-string', code.slice(index, stop));
      index = stop;
      continue;
    }

    const quote = strings.find((candidate) => current === candidate);
    if (quote) {
      let cursor = index + 1;
      while (cursor < code.length) {
        if (code[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (code[cursor] === quote) break;
        // 未闭合的引号收到行尾为止（反引号模板串允许跨行）
        if (code[cursor] === '\n' && quote !== '`') break;
        cursor += 1;
      }
      const stop = cursor < code.length && code[cursor] === quote ? cursor + 1 : cursor;
      out += span('hljs-string', code.slice(index, stop));
      index = stop;
      continue;
    }

    if (/[0-9]/.test(current) && (index === 0 || !/[\w$]/.test(code[index - 1]))) {
      const match = rest.match(/^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z%]*)/);
      if (match && match[0]) {
        out += span('hljs-number', match[0]);
        index += match[0].length;
        continue;
      }
    }

    const word = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (word) {
      const token = word[0];
      const lower = token.toLowerCase();
      if (keywords.has(token) || keywords.has(lower)) out += span('hljs-keyword', token);
      else if (literals?.has(token) || literals?.has(lower)) out += span('hljs-literal', token);
      else if (builtins?.has(token) || builtins?.has(lower)) out += span('hljs-built_in', token);
      else out += escapeHtml(token);
      index += token.length;
      continue;
    }

    out += escapeHtml(current);
    index += 1;
  }
  return out;
}
