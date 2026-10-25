import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-setup.mjs';

installDom();
const { sanitizeHtml } = await import('../src/lib/sanitize.ts');
const { renderMarkdown } = await import('../src/lib/markdown.ts');

test('sanitizeHtml recursively cleans children of unknown tags', () => {
  const result = sanitizeHtml('<font><img src="x" onerror="alert(1)"></font>');

  assert.equal(result, '<img src="x">');
  assert.doesNotMatch(result, /onerror/i);
});

test('sanitizeHtml removes unsafe URLs from preserved tags', () => {
  const result = sanitizeHtml('<p><a href="javascript:alert(1)">打开</a></p>');

  assert.equal(result, '<p><a>打开</a></p>');
});

// --- U3 抽查：新块类型（mermaid / math）经 markdown 渲染管线的安全性 ---------------
test('mermaid fence renders as a sanitized code block', () => {
  const result = renderMarkdown('```mermaid\ngraph TD; A-->B;\n```', { codeToolbar: true });
  assert.match(result, /ai-code/);
  assert.doesNotMatch(result, /<script|onerror/i);
  assert.match(result, /graph TD/);
});

test('math block source stays escaped text in the markdown pipeline', () => {
  const result = renderMarkdown('$$\n<b onclick="x()">E=mc^2</b>\n$$', { codeToolbar: false });
  assert.doesNotMatch(result, /onclick/i, '数学块源码不得把事件处理器带进 DOM');
  assert.match(result, /E=mc\^2/);
});
