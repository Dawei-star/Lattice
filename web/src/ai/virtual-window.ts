/**
 * 消息列表虚拟窗口（U3「虚拟列表，react-window 或等价」的自研等价实现）。
 *
 * 纯函数：按滚动偏移与视口高度计算可见区间（含 overscan 缓冲）与上下占位高度。
 * 高度模型：已测量项用实测值，未测量项用估计值——流式面板的场景里
 * 足够稳定（占位只影响滚动条长度，不影响可见内容正确性）。
 * 面板仅在消息数超过阈值时启用，常规会话行为零变化。
 */

export interface VirtualWindowInput {
  itemCount: number;
  /** 滚动容器顶部已滚过的像素 */
  scrollOffset: number;
  /** 视口高度（像素） */
  viewportHeight: number;
  /** 单项估计高度（像素；未测量项的兜底） */
  estimatedItemHeight: number;
  /** 上下各多渲染的缓冲条数（缺省 4） */
  overscan?: number;
  /** 实测高度表（index → px），来自渲染后的测量回填 */
  measuredHeights?: Map<number, number>;
}

export interface VirtualWindowRange {
  start: number;
  /** 不含（slice 语义） */
  end: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
}

export function computeVirtualRange(input: VirtualWindowInput): VirtualWindowRange {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const estimated = Math.max(1, Number(input.estimatedItemHeight) || 1);
  const overscan = Math.max(0, Math.floor(input.overscan ?? 4));
  const viewport = Math.max(0, Number(input.viewportHeight) || 0);
  const measured = input.measuredHeights;
  const heightAt = (index: number): number => {
    const value = measured?.get(index);
    return Number.isFinite(value) && (value as number) > 0 ? (value as number) : estimated;
  };

  // 累计高度，找到 scrollOffset 所在项（offset 落在项的高度区间内）
  let start = 0;
  let offset = Math.max(0, Number(input.scrollOffset) || 0);
  let consumed = 0;
  while (start < itemCount && consumed + heightAt(start) <= offset) {
    consumed += heightAt(start);
    start += 1;
  }
  const visibleEnd = (() => {
    let cursor = start;
    let covered = consumed;
    while (cursor < itemCount && covered < offset + viewport) {
      covered += heightAt(cursor);
      cursor += 1;
    }
    return cursor;
  })();
  const startWithBuffer = Math.max(0, start - overscan);
  const end = Math.min(itemCount, visibleEnd + overscan);

  let totalHeight = 0;
  for (let index = 0; index < itemCount; index += 1) totalHeight += heightAt(index);
  let topSpacerHeight = 0;
  for (let index = 0; index < startWithBuffer; index += 1) topSpacerHeight += heightAt(index);
  let bottomSpacerHeight = 0;
  for (let index = end; index < itemCount; index += 1) bottomSpacerHeight += heightAt(index);

  return { start: startWithBuffer, end, topSpacerHeight, bottomSpacerHeight, totalHeight };
}
