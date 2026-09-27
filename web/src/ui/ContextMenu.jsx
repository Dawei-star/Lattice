import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu } from './Menu.jsx';

/** Position-aware context menu. The caller supplies menu items for the target. */
export default function ContextMenu({ children, getItems, label = '上下文菜单', className = '' }) {
  const [state, setState] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const close = useCallback(() => {
    setState(null);
    requestAnimationFrame(() => triggerRef.current?.focus?.());
  }, []);

  useEffect(() => {
    if (!state) return undefined;
    const handlePointerDown = (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.context-menu')) close();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [close, state]);

  useLayoutEffect(() => {
    if (!state || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const padding = 8;
    const x = Math.max(padding, Math.min(state.x, window.innerWidth - rect.width - padding));
    const y = Math.max(padding, Math.min(state.y, window.innerHeight - rect.height - padding));
    if (x !== state.x || y !== state.y) setState((current) => current ? { ...current, x, y } : current);
  }, [state]);

  const handleContextMenu = (event) => {
    event.preventDefault();
    const target = event.target instanceof Element
      ? event.target.closest('button, input, textarea, select, [tabindex]')
      : null;
    triggerRef.current = target ?? event.currentTarget;
    const wrapItems = (source) => source.map((item) => {
      if (item.separator) return item;
      const wrapped = {
        ...item,
        submenuItems: item.submenuItems ? wrapItems(item.submenuItems) : undefined,
      };
      if (typeof item.onSelect === 'function') {
        wrapped.onSelect = () => {
          close();
          item.onSelect();
        };
      }
      return wrapped;
    });
    const items = wrapItems(getItems?.(event) ?? []);
    setState({
      items,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <>
      <div className={className} onContextMenu={handleContextMenu}>{children}</div>
      {state && typeof document !== 'undefined'
        ? createPortal(
            <div ref={menuRef} className="context-menu" role="presentation" style={{ left: state.x, top: state.y }}>
              <Menu items={state.items} label={label} className="menu--context" />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
