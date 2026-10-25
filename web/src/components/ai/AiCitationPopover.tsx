import type { CSSProperties } from 'react';

export interface AiCitationPopoverTarget {
  number: number;
  title?: string;
  path?: string | null;
  anchor?: string;
  excerpt?: string;
}

export interface AiCitationPopoverProps {
  target: AiCitationPopoverTarget;
  /** 触发元素的视口坐标（锚定卡片位置） */
  x: number;
  y: number;
  onOpen: (target: AiCitationPopoverTarget) => void;
  onClose: () => void;
}

/**
 * 引用悬停预览卡（U2 信任件）：300ms 防抖后展示「标题 › 锚点 / 路径 / 摘录」，
 * 点击卡片才真正跳转笔记（hover 只预览，不产生导航副作用）。
 * 位置由父级按触发元素视口坐标计算；卡片为 fixed 悬浮层，不参与文档流。
 */
export default function AiCitationPopover({ target, x, y, onOpen, onClose }: AiCitationPopoverProps) {
  const style: CSSProperties = {
    position: 'fixed',
    left: Math.max(12, Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 0) - 340)),
    top: y + 8,
  };
  return (
    <div className="ai-citation-popover" role="tooltip" style={style} onMouseLeave={onClose}>
      <button type="button" className="ai-citation-popover__open" onClick={() => onOpen(target)}>
        <strong className="ai-citation-popover__title">{target.title ?? `来源 [${target.number}]`}</strong>
        {target.anchor ? <span className="ai-citation-popover__anchor">{`› ${target.anchor}`}</span> : null}
        <span className="ai-citation-popover__path">{target.path ?? '来源笔记'}</span>
        {target.excerpt ? <span className="ai-citation-popover__excerpt">{target.excerpt.slice(0, 160)}</span> : null}
        <span className="ai-citation-popover__hint">点击跳转原文</span>
      </button>
    </div>
  );
}
