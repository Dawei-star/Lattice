import { useRef } from 'react';

/**
 * 面板分隔条：按住左右拖动触发 onDrag(dx)，双击触发 onReset，聚焦后可用方向键微调。
 * dx 是本次 pointermove 的水平位移，正负与增减语义由使用方决定。
 */
export default function Resizer({ label, onDrag, onReset, className = '', style }) {
  const drag = useRef({ active: false, lastX: 0 });

  const handlePointerDown = (event) => {
    drag.current = { active: true, lastX: event.clientX };
    // 合成事件（自动化测试）没有活动指针，捕获会抛错，忽略即可
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.add('is-column-resizing');
  };

  const handlePointerMove = (event) => {
    if (!drag.current.active) return;
    const dx = event.clientX - drag.current.lastX;
    drag.current.lastX = event.clientX;
    if (dx !== 0) onDrag?.(dx);
  };

  const endDrag = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    document.body.classList.remove('is-column-resizing');
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onDrag?.(-16);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onDrag?.(16);
    }
  };

  return (
    <div
      className={`pane-resizer ${className}`.trim()}
      style={style}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title={`${label}（左右拖动调整宽度，双击复位）`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
