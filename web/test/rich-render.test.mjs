import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractFenceBody,
  renderMathBlock,
  renderMermaidDiagram,
  setKatexLoaderForTests,
  setMermaidLoaderForTests,
  stripMathDelimiters,
} from '../src/ai/rich-render.ts';

// --- 源码剥离 -------------------------------------------------------------------
assert.equal(extractFenceBody('```mermaid\ngraph TD; A-->B;\n```'), 'graph TD; A-->B;');
assert.equal(extractFenceBody('```mermaid\ngraph TD; A-->B;'), 'graph TD; A-->B;');
assert.equal(stripMathDelimiters('$$\nE = mc^2\n$$'), 'E = mc^2');
assert.equal(stripMathDelimiters('E = mc^2'), 'E = mc^2');

test('mermaid failure falls back to the raw source (回退代码块用例)', async () => {
  setMermaidLoaderForTests(() => Promise.reject(new Error('offline')));
  const result = await renderMermaidDiagram('graph TD; A-->B;', '1');
  assert.deepEqual(result, { kind: 'fallback', output: 'graph TD; A-->B;' });

  // 图源语法错误（mermaid 抛错）同样回退
  setMermaidLoaderForTests(async () => ({
    initialize: () => {},
    render: async () => { throw new Error('Parse error'); },
  }));
  const parseFail = await renderMermaidDiagram('graph TD; ???', '2');
  assert.equal(parseFail.kind, 'fallback');
});

test('mermaid success returns sanitized svg', async () => {
  setMermaidLoaderForTests(async () => ({
    initialize: (config) => {
      assert.equal(config.securityLevel, 'strict');
      assert.equal(config.startOnLoad, false);
    },
    render: async (id, source) => ({
      svg: `<svg id="${id}"><text>${source}</text><script>alert(1)</script></svg>`,
    }),
  }));
  const result = await renderMermaidDiagram('graph TD; A-->B;', '3');
  assert.equal(result.kind, 'svg');
  assert.match(result.output, /<svg/);
  assert.doesNotMatch(result.output, /<script/i, '渲染产物剥除 script 标签');
});

test('katex failure falls back to the raw source', async () => {
  setKatexLoaderForTests(() => Promise.reject(new Error('offline')));
  const result = await renderMathBlock('$$\nE = mc^2\n$$');
  assert.deepEqual(result, { kind: 'fallback', output: '$$\nE = mc^2\n$$' });
});

test('katex renders with trust disabled', async () => {
  let seenOptions = null;
  setKatexLoaderForTests(async () => ({
    renderToString: (source, options) => {
      seenOptions = options;
      return `<span class="katex">${source}</span>`;
    },
  }));
  const result = await renderMathBlock('$$\nE = mc^2\n$$');
  assert.equal(result.kind, 'html');
  assert.match(result.output, /katex/);
  assert.equal(seenOptions.trust, false, 'KaTeX 必须以 trust:false 运行');
  assert.equal(seenOptions.throwOnError, false);
});
