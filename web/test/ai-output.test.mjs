import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-setup.mjs';

installDom();
const { renderMarkdown } = await import('../src/lib/markdown.ts');
const { sanitizeHtml } = await import('../src/lib/sanitize.ts');
const {
  buildAnswerNoteDraft,
  estimateCostUsd,
  formatCostLabel,
  isLoopbackEndpoint,
} = await import('../src/lib/ai-output.ts');

test('codeToolbar renders code block with language label, hljs classes and toolbar buttons', () => {
  const html = renderMarkdown('```python\nprint("hi")\n```', { codeToolbar: true });
  assert.match(html, /class="ai-code"/);
  assert.match(html, /class="ai-code__lang">python</);
  assert.match(html, /class="ai-code-copy"/);
  assert.match(html, /class="ai-code-wrap"/);
  assert.match(html, /class="hljs language-python"/);
  assert.match(html, /hljs-/);
});

test('codeToolbar falls back to escaped plain text for unregistered languages', () => {
  const html = renderMarkdown('```\n<a href="x">&amp;</a>\n```', { codeToolbar: true });
  assert.match(html, /ai-code__lang">text</);
  assert.match(html, /&lt;a href="x"&gt;&amp;amp;&lt;\/a&gt;/);
  assert.doesNotMatch(html, /hljs-/);
});

test('default renderMarkdown keeps plain marked code output (notes unaffected)', () => {
  const html = renderMarkdown('```md\n[[Do not link]]\n```');
  assert.match(html, /<code class="language-md">/);
  assert.doesNotMatch(html, /ai-code/);
});

test('sanitized code toolbar keeps buttons but strips handlers from raw html buttons', () => {
  const html = renderMarkdown('```js\nfoo()\n```', { codeToolbar: true });
  const clean = sanitizeHtml(html);
  assert.match(clean, /<button type="button" class="ai-code-copy"/);
  assert.match(clean, /<button type="button" class="ai-code-wrap"/);

  const raw = sanitizeHtml('<button type="button" onclick="alert(1)" class="evil">点我</button>');
  assert.match(raw, /<button type="button" class="evil">点我<\/button>/);
  assert.doesNotMatch(raw, /onclick/i);
});

test('estimateCostUsd computes from 1k prices and returns null when unconfigured', () => {
  assert.equal(estimateCostUsd(
    { prompt_tokens: 1000, completion_tokens: 1000 },
    { promptCostPer1kUsd: 0.001, completionCostPer1kUsd: 0.002 },
  ), 0.003);
  assert.equal(estimateCostUsd({ prompt_tokens: 500, completion_tokens: 0 }, { promptCostPer1kUsd: 0.002, completionCostPer1kUsd: 0.004 }), 0.001);
  assert.equal(estimateCostUsd({ prompt_tokens: 100 }, {}), null);
  assert.equal(estimateCostUsd(null, { promptCostPer1kUsd: 0.001, completionCostPer1kUsd: 0.002 }), null);
  assert.equal(estimateCostUsd({ prompt_tokens: 10 }, { promptCostPer1kUsd: -1, completionCostPer1kUsd: 0 }), null);
});

test('formatCostLabel keeps small amounts visible', () => {
  assert.equal(formatCostLabel(0.003123), '$0.0031');
  assert.equal(formatCostLabel(0.1234), '$0.123');
  assert.equal(formatCostLabel(1.5678), '$1.57');
});

test('isLoopbackEndpoint only accepts loopback hosts', () => {
  assert.equal(isLoopbackEndpoint('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLoopbackEndpoint('http://localhost:1234/v1'), true);
  assert.equal(isLoopbackEndpoint('http://[::1]:8080/v1'), true);
  assert.equal(isLoopbackEndpoint('https://api.deepseek.com/v1'), false);
  assert.equal(isLoopbackEndpoint('http://192.168.1.5:8000/v1'), false);
  assert.equal(isLoopbackEndpoint('not a url'), false);
});

test('buildAnswerNoteDraft converts references to deduplicated wikilinks', () => {
  const draft = buildAnswerNoteDraft({
    content: '# 量子笔记总结\n\n正文内容',
    references: [
      { title: '量子力学', number: 1 },
      { title: '量子力学', number: 2 },
      { title: '波函数', number: 3, anchor: '第二节' },
      { number: 4 },
    ],
  });
  assert.equal(draft.title, '量子笔记总结');
  assert.match(draft.content, /^# 量子笔记总结/);
  assert.match(draft.content, /## 来源/);
  assert.equal((draft.content.match(/\[\[量子力学\]\]/g) ?? []).length, 1);
  assert.match(draft.content, /\[\[波函数#第二节\]\]/);
  assert.doesNotMatch(draft.content, /\[\[#?\]\]/);
});

test('buildAnswerNoteDraft without references keeps content and derives a title', () => {
  const draft = buildAnswerNoteDraft({ content: 'plain answer without heading\n\n- item' });
  assert.equal(draft.title, 'plain answer without heading');
  assert.equal(draft.content, 'plain answer without heading\n\n- item');
});
