import assert from 'node:assert/strict';
import test from 'node:test';
import { computeVirtualRange } from '../src/ai/virtual-window.ts';

const ESTIMATED = 160;

test('small lists render the whole window (start 0, no spacers)', () => {
  const range = computeVirtualRange({ itemCount: 8, scrollOffset: 0, viewportHeight: 800, estimatedItemHeight: ESTIMATED });
  assert.deepEqual([range.start, range.end], [0, 8]);
  assert.equal(range.topSpacerHeight, 0);
  assert.equal(range.bottomSpacerHeight, 0);
  assert.equal(range.totalHeight, 8 * ESTIMATED);
});

test('scrolling into a long list windows the visible range with overscan', () => {
  const range = computeVirtualRange({ itemCount: 1000, scrollOffset: 16_000, viewportHeight: 800, estimatedItemHeight: ESTIMATED, overscan: 4 });
  // 16000 / 160 = 第 100 项起可见；缓冲 4
  assert.equal(range.start, 96);
  assert.ok(range.end >= 106, `可见区需覆盖视口 + overscan（实际 end=${range.end}）`);
  assert.ok(range.end <= 1000);
  assert.equal(range.topSpacerHeight, range.start * ESTIMATED);
  assert.equal(range.bottomSpacerHeight, (1000 - range.end) * ESTIMATED);
});

test('measured heights override estimates', () => {
  const measured = new Map([[0, 400]]);
  const range = computeVirtualRange({ itemCount: 10, scrollOffset: 0, viewportHeight: 800, estimatedItemHeight: ESTIMATED, measuredHeights: measured });
  assert.equal(range.start, 0);
  assert.equal(range.totalHeight, 400 + 9 * ESTIMATED);
});

test('range stays within bounds at the bottom of the list', () => {
  const range = computeVirtualRange({ itemCount: 100, scrollOffset: 999_999, viewportHeight: 800, estimatedItemHeight: ESTIMATED });
  assert.equal(range.end, 100);
  assert.equal(range.bottomSpacerHeight, 0);
  assert.ok(range.start < 100);
});

test('empty input is safe', () => {
  const range = computeVirtualRange({ itemCount: 0, scrollOffset: 0, viewportHeight: 800, estimatedItemHeight: ESTIMATED });
  assert.deepEqual([range.start, range.end, range.totalHeight], [0, 0, 0]);
});

// --- 规模断言（60fps 手测的程序化等效）：1000 条会话只挂载可见区 ---------------------
test('1000-item session mounts only the visible window (programmatic 60fps proxy)', () => {
  const range = computeVirtualRange({ itemCount: 1000, scrollOffset: 0, viewportHeight: 800, estimatedItemHeight: ESTIMATED, overscan: 4 });
  const mounted = range.end - range.start;
  assert.ok(mounted <= 16, `挂载数 ${mounted} 必须远小于总数 1000`);
  assert.ok(mounted >= 5, '可见区至少覆盖一屏内容');
});
