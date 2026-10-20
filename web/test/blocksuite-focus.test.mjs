import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const source = await fs.readFile(new URL('../src/editor/BlockSuiteEditor.tsx', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

assert.match(source, /element\.autofocus\s*=\s*false\s*;/, 'BlockSuite 不应自动把焦点放到内置 Title');
assert.match(
  source,
  /\}, \[documentKey, projectionRevision, readOnly\]\);/,
  '仅回调引用变化不应重建 BlockSuite 页面',
);
assert.match(source, /blockUpdatedSubscription\?\.dispose\(\);/, 'BlockSuite Page 卸载时必须释放 blockUpdated 订阅');
assert.match(styles, /\.blocksuite-editor\s+doc-title\s*\{[\s\S]*?display:\s*none\s*;/, '外层标题为真源时应隐藏 BlockSuite 内置 Title');
console.log('BlockSuite focus regression tests passed');
