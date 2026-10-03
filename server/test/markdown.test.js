/**
 * Markdown 解析的单元测试。
 * 这些函数是整个双链体验的地基，且全是纯函数，适合用最快的单测覆盖。
 *   npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWordCount,
  extractNoteTags,
  extractTags,
  extractWikiLinks,
  inferTitle,
  toPlainText,
} from '../src/lib/markdown.js';

describe('extractWikiLinks', () => {
  it('解析基础双链', () => {
    const links = extractWikiLinks('参考 [[架构分层说明]] 的内容');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, '架构分层说明');
    assert.equal(links[0].isEmbed, false);
  });

  it('解析别名与标题锚点', () => {
    const links = extractWikiLinks('[[目标|显示名]] 与 [[目标2#小节]]');
    assert.deepEqual(
      links.map((link) => [link.target, link.alias, link.heading]),
      [
        ['目标', '显示名', null],
        ['目标2', null, '小节'],
      ],
    );
  });

  it('识别嵌入语法', () => {
    const links = extractWikiLinks('![[被嵌入的笔记]]');
    assert.equal(links[0].isEmbed, true);
    assert.equal(links[0].target, '被嵌入的笔记');
  });

  it('同一目标去重并累计出现次数', () => {
    const links = extractWikiLinks('[[A]] 和 [[A]] 再来一次 [[ a ]]');
    assert.equal(links.length, 1);
    assert.equal(links[0].count, 3);
  });

  it('忽略代码块与行内代码里的双链', () => {
    const source = ['```', '[[代码块里的不应被解析]]', '```', '', '`[[行内的也不应]]`'].join('\n');
    assert.equal(extractWikiLinks(source).length, 0);
  });

  it('忽略空的链接目标', () => {
    assert.equal(extractWikiLinks('[[]] 和 [[   ]]').length, 0);
  });
});

describe('extractTags', () => {
  it('解析中文冒号后的标签', () => {
    // 回归用例：早期实现用「前置字符白名单」，会漏掉中文标点后的标签
    assert.deepEqual(extractTags('标签：#入门 #方法论'), ['入门', '方法论']);
  });

  it('解析各种标点之后的标签', () => {
    assert.deepEqual(extractTags('标签：#想法 #灵感 #待办、#归档，收工'), [
      '想法',
      '灵感',
      '待办',
      '归档',
    ]);
  });

  it('紧贴在文字后面的 # 不算标签（与 Obsidian 语义一致）', () => {
    // `#` 之前若是字母/数字/汉字，说明它是词的一部分，不应被识别为标签
    assert.deepEqual(extractTags('以及#灵感 都没空格'), []);
  });

  it('解析行首标签与斜杠嵌套标签', () => {
    assert.deepEqual(extractTags('#工程/前端 是嵌套标签'), ['工程/前端']);
  });

  it('不把 Markdown 标题当成标签', () => {
    assert.deepEqual(extractTags('# 一级标题\n## 二级标题'), []);
  });

  it('不把井号紧跟字母数字的情况误判', () => {
    assert.deepEqual(extractTags('abc#def 和 https://example.com#anchor'), []);
  });

  it('纯数字不算标签', () => {
    assert.deepEqual(extractTags('#2024 是年份'), []);
  });

  it('忽略代码块里的井号', () => {
    assert.deepEqual(extractTags('```\n#注释\n```'), []);
  });

  it('去重', () => {
    assert.deepEqual(extractTags('#A #A #a'), ['A', 'a']);
  });

  it('行首无空格的中文标题不算标签（中文笔记常见 #需求 写法）', () => {
    // 回归用例：导入 Obsidian 的 md 后每个无空格标题都被当成了标签
    assert.deepEqual(extractTags('#需求\n正文提到 #灵感 标签\n##背景'), ['灵感']);
  });

  it('十六进制色值不算标签', () => {
    assert.deepEqual(extractTags('色值 #ffffff 与 #00ff00 和 #fff'), []);
  });

  it('带数字的短标签不被误判为色值（#e2e 是标签，不是 #e2e 色值）', () => {
    // 回归用例：MCP E2E 用 #e2e 当标签，一度被 3 位十六进制色值规则误排除
    assert.deepEqual(extractTags('端到端测试 #e2e'), ['e2e']);
    assert.deepEqual(extractTags('区间 #a1'), ['a1']);
  });

  it('行首的嵌套标签仍然保留', () => {
    assert.deepEqual(extractTags('#工程/前端 属于嵌套标签'), ['工程/前端']);
  });
});

describe('extractNoteTags', () => {
  it('合并正文标签与 frontmatter tags（YAML 数组）', () => {
    assert.deepEqual(
      extractNoteTags('正文 #内联', { tags: ['阅读', '随笔'] }),
      ['内联', '阅读', '随笔'],
    );
  });

  it('frontmatter tags 为逗号分隔字符串时也能解析', () => {
    assert.deepEqual(extractNoteTags('', { tags: '阅读, 随笔' }), ['阅读', '随笔']);
  });

  it('去掉标签里的前导 # 并去重', () => {
    assert.deepEqual(extractNoteTags('#阅读', { tags: ['#阅读', '随笔'] }), ['阅读', '随笔']);
  });
});

describe('computeWordCount', () => {
  it('汉字按字计、拉丁按词计', () => {
    assert.equal(computeWordCount('你好世界'), 4);
    assert.equal(computeWordCount('hello world'), 2);
    assert.equal(computeWordCount('你好 lattice world'), 4);
  });

  it('空内容为 0', () => {
    assert.equal(computeWordCount(''), 0);
    assert.equal(computeWordCount(undefined), 0);
  });
});

describe('inferTitle', () => {
  it('优先取一级标题', () => {
    assert.equal(inferTitle('## 二级\n\n正文'), '二级');
  });

  it('没有标题时取首个非空行', () => {
    assert.equal(inferTitle('\n\n**加粗的** 首行'), '加粗的 首行');
  });

  it('跳过代码围栏及其内部内容', () => {
    assert.equal(inferTitle('```\ncode\n```\n\n真正的首行'), '真正的首行');
  });

  it('完全为空时给出兜底标题', () => {
    assert.equal(inferTitle(''), '未命名笔记');
  });
});

describe('toPlainText', () => {
  it('剥离 Markdown 语法但保留代码内容', () => {
    // 摘要是给人看的，代码块与行内代码的内容不能被丢掉
    assert.equal(toPlainText('# 标题\n\n**粗体** 与 `代码`'), '标题 粗体 与 代码');
  });

  it('保留代码块里的内容', () => {
    // 围栏行（含语言标识）被去掉，代码内容保留
    assert.equal(toPlainText('```js\nconst a = 1;\n```'), 'const a = 1;');
  });

  it('双链只保留显示文本', () => {
    assert.equal(toPlainText('参见 [[目标笔记|别名]] 与 [[另一个]]'), '参见 别名 与 另一个');
  });

  it('图片保留 alt 文本', () => {
    assert.equal(toPlainText('![示意图](/a.png)'), '示意图');
  });
});
