import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { isComposingEvent } from '../lib/events.ts';

/** Modal 弹窗属性。 */
export interface ModalProps {
  open: boolean;
  title?: string;
  ariaLabel?: string;
  onClose?: () => void;
  children?: ReactNode;
  className?: string;
  /** 打开时聚焦的目标元素（缺省聚焦第一个可聚焦子元素） */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/** Shared modal shell with Escape, backdrop close, and a small focus trap. */
export default function Modal({ open, title, ariaLabel, onClose, children, className = '', initialFocusRef }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // 调用方传的内联 onClose 每次渲染都是新引用：直接进依赖数组会让打开中的弹窗
  // 随父组件重渲染反复重跑 effect（重抢焦点、反复置 overflow），这里经 ref 取最新值
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    const focusable = getFocusable(dialog);
    (initialFocusRef?.current ?? focusable[0])?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      // 输入法组词期间的 Esc 是取消候选词，不能顺带把弹窗关掉
      if (event.key === 'Escape' && !isComposingEvent(event)) {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const current = getFocusable(dialog);
      if (current.length === 0) return;
      const first = current[0];
      const last = current[current.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, [initialFocusRef, open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className={`modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {title ? <h2 className="sr-only">{title}</h2> : null}
        {children}
      </div>
    </div>
  );
}

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  return root
    ? [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
    : [];
}
