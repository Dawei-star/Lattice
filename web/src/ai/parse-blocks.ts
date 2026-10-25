/**
 * MessageBlock 块解析（U2，输出管线）。
 *
 * 一次解析把回答切成稳定块序列（markdown / code / table / mermaid / math），
 * 流式期间只重解析**最后一个块**（parseBlocksIncremental 复用已稳定块的引用），
 * 长回复不再整段重注入。纯函数、无 DOM 依赖。
 *
 * 块边界规则（按行扫描）：
 * - ``` / ~~~ 围栏 → code（language=mermaid 归为 mermaid）；流式尾部未闭合 → closed=false；
 * - $$ … $$ 数学块 → math（未闭合同理；行内 $…$ 不切块，属 U3 渲染层关注点）；
 * - 表格行（`|…|` 且第二行是 `---` 分隔）→ table；
 * - 其余行归并 markdown 文本块。
 */

export type AiBlockKind = 'markdown' | 'code' | 'table' | 'mermaid' | 'math';

export interface AiBlock {
  kind: AiBlockKind;
  /** 块的原始文本（code/mermaid 含围栏、math 含 $$ 定界），渲染层直接消费 */
  source: string;
  /** 在全文中的起始偏移（增量解析的复用锚点） */
  start: number;
  /** code/mermaid 的围栏语言；其余缺省 */
  language?: string;
  /** 围栏/数学定界是否闭合（流式尾部可能开放） */
  closed: boolean;
}

interface FenceMatch {
  marker: string;
  language: string;
}

function fenceInfo(line: string): FenceMatch | null {
  const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return { marker: match[2], language: match[3].trim().split(/\s+/)[0]?.toLowerCase() ?? '' };
}

function closesFence(opening: FenceMatch, line: string | undefined): boolean {
  if (!line) return false;
  const closing = fenceInfo(line);
  return Boolean(closing
    && closing.marker[0] === opening.marker[0]
    && closing.marker.length >= opening.marker.length
    && !closing.language);
}

function isMathDelimiter(line: string): boolean {
  return line.trim() === '$$';
}

function isTableDivider(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-') || (!trimmed.includes('|') && !trimmed.startsWith(':'))) return false;
  return /^\|?\s*:?-{3,}[-:\s|]*\|?\s*$/.test(trimmed) || /^\|(\s*:?-+:?\s*\|)+\s*$/.test(trimmed);
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1;
}

/** 解析完整文本为块序列。文本为空返回空数组。 */
export function parseBlocks(content: string): AiBlock[] {
  const text = String(content ?? '');
  if (!text) return [];
  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let running = 0;
  for (const line of lines) {
    lineStarts.push(running);
    running += line.length + 1;
  }

  const blocks: AiBlock[] = [];
  let textStart = 0; // 当前 markdown 缓冲的起始行
  let i = 0;
  const flushText = (endLineExclusive: number) => {
    if (endLineExclusive <= textStart) return;
    const source = lines.slice(textStart, endLineExclusive).join('\n');
    if (source.trim()) {
      blocks.push({ kind: 'markdown', source, start: lineStarts[textStart], closed: true });
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = fenceInfo(line);
    if (fence) {
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (closesFence(fence, lines[j])) {
          closed = true;
          break;
        }
        j += 1;
      }
      flushText(i);
      const endLineExclusive = closed ? j + 1 : lines.length;
      blocks.push({
        kind: fence.language === 'mermaid' ? 'mermaid' : 'code',
        source: lines.slice(i, endLineExclusive).join('\n'),
        start: lineStarts[i],
        language: fence.language || undefined,
        closed,
      });
      i = endLineExclusive;
      textStart = i;
      continue;
    }
    if (isMathDelimiter(line)) {
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (isMathDelimiter(lines[j])) {
          closed = true;
          break;
        }
        j += 1;
      }
      flushText(i);
      const endLineExclusive = closed ? j + 1 : lines.length;
      blocks.push({
        kind: 'math',
        source: lines.slice(i, endLineExclusive).join('\n'),
        start: lineStarts[i],
        closed,
      });
      i = endLineExclusive;
      textStart = i;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      let j = i;
      while (j < lines.length && isTableRow(lines[j])) j += 1;
      flushText(i);
      blocks.push({
        kind: 'table',
        source: lines.slice(i, j).join('\n'),
        start: lineStarts[i],
        closed: true,
      });
      i = j;
      textStart = i;
      continue;
    }
    i += 1;
  }
  flushText(lines.length);
  return blocks;
}

/**
 * 增量解析：复用上一轮结果里已经稳定的块（引用同一对象，渲染层 memo 跳过），
 * 只重新解析「重解析区」= 结尾 markdown 连续段 + 可能的开放特殊块。
 * 内容与稳定区前缀不一致（编辑/回退/收缩）→ 退回全量解析。
 */
export function parseBlocksIncremental(content: string, previous: AiBlock[]): AiBlock[] {
  const text = String(content ?? '');
  if (!previous.length) return parseBlocks(text);
  // 重解析区 = 结尾的 markdown 连续段（新文本会并入这段，必须合并重解析，
  // 否则同一段文字会被拆成多个渲染容器）+ 可能的开放特殊块（流式围栏/数学）。
  // 区之前的块已稳定：引用原对象复用，渲染层 memo 直接跳过。
  let scan = previous.length - 1;
  while (scan >= 0 && previous[scan].kind === 'markdown') scan -= 1;
  const regionStart = scan >= 0 && !previous[scan].closed ? scan : scan + 1;
  const stable = previous.slice(0, regionStart);
  const stableEnd = regionStart < previous.length
    ? previous[regionStart].start
    : previous.length
      ? previous[previous.length - 1].start + previous[previous.length - 1].source.length
      : 0;
  // 按块偏移精确重建前缀：块间分隔由偏移差决定（增量拼出的块之间可能没有换行）。
  let expected = '';
  let cursor = 0;
  for (const block of stable) {
    expected += '\n'.repeat(Math.max(0, block.start - cursor)) + block.source;
    cursor = block.start + block.source.length;
  }
  expected += '\n'.repeat(Math.max(0, stableEnd - cursor));
  if (stableEnd > text.length || text.slice(0, stableEnd) !== expected) {
    return parseBlocks(text);
  }
  const tail = parseBlocks(text.slice(stableEnd));
  return [...stable, ...tail.map((block) => ({ ...block, start: block.start + stableEnd }))];
}
