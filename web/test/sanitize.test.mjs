import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-setup.mjs';

installDom();
const { sanitizeHtml } = await import('../src/lib/sanitize.js');

test('sanitizeHtml recursively cleans children of unknown tags', () => {
  const result = sanitizeHtml('<font><img src="x" onerror="alert(1)"></font>');

  assert.equal(result, '<img src="x">');
  assert.doesNotMatch(result, /onerror/i);
});

test('sanitizeHtml removes unsafe URLs from preserved tags', () => {
  const result = sanitizeHtml('<p><a href="javascript:alert(1)">打开</a></p>');

  assert.equal(result, '<p><a>打开</a></p>');
});
