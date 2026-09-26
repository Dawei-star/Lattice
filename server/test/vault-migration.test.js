import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFileName } from '../src/vault/migrate-sqlite.js';

test('safeFileName produces valid portable filenames', () => {
  assert.equal(safeFileName('a:b?.md'), 'a_b_.md');
  assert.equal(safeFileName('  标题  '), '标题');
  assert.equal(safeFileName(''), '未命名笔记');
});
