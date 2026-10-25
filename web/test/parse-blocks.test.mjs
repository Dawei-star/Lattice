import assert from 'node:assert/strict';
import { parseBlocks, parseBlocksIncremental } from '../src/ai/parse-blocks.ts';

// --- 基本分类 -----------------------------------------------------------------
const markdownOnly = parseBlocks('第一段文字。\n\n第二段文字。');
assert.equal(markdownOnly.length, 1);
assert.equal(markdownOnly[0].kind, 'markdown');
assert.equal(markdownOnly[0].closed, true);

const fenced = parseBlocks('前文\n```js\nconst x = 1;\n```\n后文');
assert.deepEqual(fenced.map((block) => block.kind), ['markdown', 'code', 'markdown']);
assert.equal(fenced[1].language, 'js');
assert.equal(fenced[1].closed, true);
assert.equal(fenced[1].source, '```js\nconst x = 1;\n```');

assert.equal(parseBlocks('```mermaid\ngraph TD; A-->B;\n```')[0].kind, 'mermaid');
assert.equal(parseBlocks('$$\nE = mc^2\n$$')[0].kind, 'math');
assert.equal(parseBlocks('~~~python\nprint(1)\n~~~')[0].kind, 'code');

const table = parseBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n正文');
assert.equal(table[0].kind, 'table');
assert.equal(table[0].source, '| a | b |\n| --- | --- |\n| 1 | 2 |');
assert.equal(table[1].kind, 'markdown');

// --- 流式尾部：未闭合围栏 -------------------------------------------------------
const streaming = parseBlocks('正文\n```ts\nconst partial');
assert.deepEqual(streaming.map((block) => block.kind), ['markdown', 'code']);
assert.equal(streaming[1].closed, false);
assert.equal(streaming[1].source, '```ts\nconst partial');

const mathStreaming = parseBlocks('$$\nE=mc');
assert.equal(mathStreaming[0].kind, 'math');
assert.equal(mathStreaming[0].closed, false);

// --- 增量：已稳定块整体复用（引用同一对象 = 零重解析证明） -------------------------
// 纯 markdown 尾段每帧都会并入重解析（必须合并，否则渲染层拆容器）；
// 身份复用的判据锚在「最后的已闭合特殊块」之前的部分。
const withFence = parseBlocks('第一段文字。\n\n```js\nconst x = 1;\n```');
const withFenceGrown = parseBlocksIncremental(
  `${withFence.map((block) => block.source).join('\n')}\n`,
  withFence,
);
assert.equal(withFenceGrown.length, withFence.length);
assert.strictEqual(withFenceGrown[0], withFence[0], '闭合特殊块之前的块必须复用引用');
assert.strictEqual(withFenceGrown[1], withFence[1]);

const base = parseBlocks('段落一\n\n```js\nx = 1\n```');
const grown = parseBlocksIncremental(`${base.map((block) => block.source).join('\n')}\n\n段落三`, base);
assert.deepEqual(grown.map((block) => block.kind), ['markdown', 'code', 'markdown']);
assert.strictEqual(grown[0], base[0]);
assert.strictEqual(grown[1], base[1]);
assert.equal(grown[2].source, '\n\n段落三');

// --- 增量：开放尾部块重解析，更早的块保持引用 ------------------------------------
const tailOpen = parseBlocks('前文\n```js\nconst a = 1;');
const tailClosed = parseBlocksIncremental('前文\n```js\nconst a = 1;\n```', tailOpen);
assert.deepEqual(tailClosed.map((block) => block.kind), ['markdown', 'code']);
assert.strictEqual(tailClosed[0], tailOpen[0], '稳定前缀复用');
assert.equal(tailClosed[1].closed, true);

const tailGrown = parseBlocksIncremental('前文\n```js\nconst a = 1;\n```\n结束', tailClosed);
assert.strictEqual(tailGrown[0], tailOpen[0]);
assert.strictEqual(tailGrown[1], tailClosed[1]);
assert.equal(tailGrown[2].kind, 'markdown');

// --- 增量：内容收缩/编辑 → 退回全量 --------------------------------------------
const edited = parseBlocksIncremental('完全不同的内容', base);
assert.notStrictEqual(edited[0], base[0]);

// --- 空输入 -------------------------------------------------------------------
assert.deepEqual(parseBlocks(''), []);
assert.deepEqual(parseBlocksIncremental('', []), []);

// --- 表格后的正文与空行混合 -----------------------------------------------------
const mixed = parseBlocks('intro\n\n| a |\n| - |\n| 1 |\n\noutro');
assert.deepEqual(mixed.map((block) => block.kind), ['markdown', 'table', 'markdown']);
assert.equal(mixed[0].source, 'intro\n');
assert.equal(mixed[2].source, '\noutro');

// --- 流式增量全链：模拟 12 轮追加，只有尾部块在换新 ------------------------------
let content = '知识库说明\n\n```js\nconst a = 1;\n```\n\n结论：';
let blocks = parseBlocks(content);
const stableRefs = [blocks[0]];
for (let round = 0; round < 12; round += 1) {
  content += ` 追加 ${round}。`;
  const next = parseBlocksIncremental(content, blocks);
  assert.strictEqual(next[0], stableRefs[0], `第 ${round} 轮仍复用首块`);
  blocks = next;
}
assert.deepEqual(blocks.map((block) => block.kind), ['markdown', 'code', 'markdown']);

console.log('parse-blocks tests passed');
