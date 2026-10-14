import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/** 灯箱缩放/平移状态。 */
interface LightboxTransform {
  scale: number;
  x: number;
  y: number;
}

/** 一次拖动的起点状态。 */
interface LightboxDragState {
  pointerId: number;
  x: number;
  y: number;
  origin: LightboxTransform;
}

export interface LightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const WHEEL_STEP = 0.0016;

/**
 * 图片灯箱：预览里点开的图片在这里全屏查看。
 * 滚轮以光标为锚缩放，拖动平移，双击在「适合窗口 / 原大 2.5×」间切换，Esc / 点背景关闭。
 */
export default function Lightbox({ src, alt = '', onClose }: LightboxProps) {
  const [transform, setTransform] = useState<LightboxTransform>({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<LightboxDragState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    // React 的 onWheel 是 passive 的，放大后要阻止页面滚动必须用原生监听
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
      setTransform((current) => zoomTransform(current, Math.exp(-event.deltaY * WHEEL_STEP), anchor));
    };
    root.addEventListener('wheel', handleWheel, { passive: false });
    return () => root.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === '0') setTransform({ scale: 1, x: 0, y: 0 });
      else if (event.key === '+' || event.key === '=') setTransform((current) => zoomTransform(current, 1.25));
      else if (event.key === '-') setTransform((current) => zoomTransform(current, 0.8));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const startDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: transform,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      if (dragRef.current !== start) return;
      setTransform({
        scale: start.origin.scale,
        x: start.origin.x + (next.clientX - start.x),
        y: start.origin.y + (next.clientY - start.y),
      });
    };
    const finish = () => {
      if (dragRef.current === start) dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    const rect = rootRef.current?.getBoundingClientRect();
    const anchor = rect ? { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 } : null;
    setTransform((current) => (current.scale > 1.05
      ? { scale: 1, x: 0, y: 0 }
      : zoomTransform(current, 2.5, anchor as { x: number; y: number })));
  };

  const zoomBy = (factor: number) => setTransform((current) => zoomTransform(current, factor));
  const percent = Math.round(transform.scale * 100);

  return (
    <div
      ref={rootRef}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `查看图片：${alt}` : '查看图片'}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <img
        src={src}
        alt={alt}
        draggable="false"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
        onPointerDown={startDrag}
        onDoubleClick={handleDoubleClick}
      />
      <div className="lightbox__bar">
        <button type="button" className="lightbox__button" onClick={() => zoomBy(0.8)} aria-label="缩小" title="缩小（-）">−</button>
        <button type="button" className="lightbox__button lightbox__zoom" onClick={() => setTransform({ scale: 1, x: 0, y: 0 })} aria-label="重置缩放" title="重置（0）">{percent}%</button>
        <button type="button" className="lightbox__button" onClick={() => zoomBy(1.25)} aria-label="放大" title="放大（+）">＋</button>
        <span className="lightbox__hint">滚轮缩放 · 拖动平移 · 双击放大 · Esc 关闭</span>
        <button type="button" className="lightbox__button lightbox__close" onClick={onClose} aria-label="关闭" title="关闭（Esc）">×</button>
      </div>
    </div>
  );
}

/** 以 anchor（相对屏幕中心的偏移）为锚缩放；不传锚点时围绕屏幕中心缩放。 */
function zoomTransform(current: LightboxTransform, factor: number, anchor: { x: number; y: number } = { x: 0, y: 0 }): LightboxTransform {
  const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
  const applied = scale / current.scale;
  return {
    scale,
    x: anchor.x + (current.x - anchor.x) * applied,
    y: anchor.y + (current.y - anchor.y) * applied,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
