import { useEffect, useRef } from 'react';
import { isComposingEvent } from '../lib/events.js';

/** Shared modal shell with Escape, backdrop close, and a small focus trap. */
export default function Modal({ open, title, ariaLabel, onClose, children, className = '', initialFocusRef }) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    const focusable = getFocusable(dialog);
    (initialFocusRef?.current ?? focusable[0])?.focus();

    const handleKeyDown = (event) => {
      // 输入法组词期间的 Esc 是取消候选词，不能顺带把弹窗关掉
      if (event.key === 'Escape' && !isComposingEvent(event)) {
        event.preventDefault();
        onClose?.();
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
  }, [initialFocusRef, onClose, open]);

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

function getFocusable(root) {
  return root
    ? [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
    : [];
}
