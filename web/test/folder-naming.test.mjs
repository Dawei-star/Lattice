import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFolderName } from '../src/lib/folder-naming.js';

test('default folder names are unique within one sibling list', () => {
  assert.equal(nextFolderName([]), '未命名');
  assert.equal(nextFolderName([{ name: '未命名' }]), '未命名 2');
  assert.equal(nextFolderName([{ name: '未命名' }, { name: '未命名 2' }]), '未命名 3');
});

test('default folder name matching ignores case and blank entries', () => {
  assert.equal(nextFolderName([{ name: '未命名 2' }, { name: '  ' }, { name: '未命名' }]), '未命名 3');
  assert.equal(nextFolderName([{ name: 'UNNAMED' }]), '未命名');
});
