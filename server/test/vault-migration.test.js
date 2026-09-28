import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilePart } from '../src/vault/path.js';

test('sanitizeFilePart produces valid portable path segments', () => {
  const cases = [
    ['a:b?.md', 'a_b_.md'],
    ['  标题  ', '标题'],
    ['', '未命名笔记'],
    ['a/b\\c', 'a_b_c'],
    ['制表\t换行\n', '制表_换行_'],
    ['DEL字符\u007f', 'DEL字符_'],
    ['结尾三个点...', '结尾三个点'],
    ['...', '未命名笔记'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeFilePart(input), expected);
  }
  assert.equal(sanitizeFilePart('...', '未命名目录'), '未命名目录');
});
