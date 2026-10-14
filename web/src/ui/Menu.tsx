import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

/** 菜单项定义（分隔线只占用 separator 字段）。 */
export interface MenuItemDef {
  id?: string;
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  title?: string;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  separator?: boolean;
  /** 有子菜单但由父级受控展开时置 true（仅用于显示展开箭头） */
  submenu?: boolean;
  submenuItems?: MenuItemDef[];
  onSelect?: () => void;
}

export interface MenuProps {
  items: MenuItemDef[];
  label?: string;
  className?: string;
}

export function Menu({ items, label = '菜单', className = '' }: MenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openSubmenu, setOpenSubmenu] = useState<string | number | null>(null);
  const visibleItems = items.filter((item) => !item.separator && !item.hidden && !item.disabled);

  useEffect(() => setActiveIndex(0), [items]);

  const focusItem = (index: number) => {
    const buttons = menuRef.current?.querySelectorAll<HTMLElement>(':scope > .menu__item-wrap > [role="menuitem"]');
    const next = Math.max(0, Math.min(index, (buttons?.length ?? 1) - 1));
    setActiveIndex(next);
    buttons?.[next]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!visibleItems.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem((activeIndex + 1) % visibleItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem((activeIndex - 1 + visibleItems.length) % visibleItems.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(visibleItems.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      menuRef.current?.querySelectorAll<HTMLElement>(':scope > .menu__item-wrap > [role="menuitem"]')[activeIndex]?.click();
    }
  };

  return (
    <div ref={menuRef} className={`menu ${className}`.trim()} role="menu" aria-label={label} onKeyDown={handleKeyDown}>
      {items.map((item, index) => {
        if (item.separator) return <div key={`separator-${index}`} className="menu__separator" role="separator" />;
        const itemId = item.id ?? item.label ?? index;
        const hasSubmenu = Array.isArray(item.submenuItems) && item.submenuItems.length > 0;
        return (
          <div
            // 无 id 的同名菜单项会共用 label 作 key：拼上序号保证唯一
            key={`${itemId}-${index}`}
            className="menu__item-wrap"
            onMouseEnter={() => hasSubmenu && setOpenSubmenu(itemId)}
            onMouseLeave={() => setOpenSubmenu(null)}
          >
            <MenuItem
              item={item}
              autoFocus={activeIndex === visibleItems.indexOf(item)}
              hasSubmenu={hasSubmenu}
              onToggleSubmenu={() => hasSubmenu && setOpenSubmenu(itemId)}
            />
            {hasSubmenu && openSubmenu === itemId ? (
              <div className="menu__submenu">
                <Menu items={item.submenuItems as MenuItemDef[]} label={`${item.label}子菜单`} className="menu--submenu" />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export interface MenuItemProps {
  item: MenuItemDef;
  autoFocus?: boolean;
  hasSubmenu?: boolean;
  onToggleSubmenu?: () => void;
}

export function MenuItem({ item, autoFocus = false, hasSubmenu = false, onToggleSubmenu }: MenuItemProps) {
  if (item.hidden) return null;
  const content = (
    <>
      <span className="menu__icon" aria-hidden="true">{item.icon ?? ''}</span>
      <span className="menu__label">{item.label}</span>
      {item.shortcut ? <kbd className="menu__shortcut">{item.shortcut}</kbd> : null}
      {hasSubmenu || item.submenu ? <span className="menu__chevron" aria-hidden="true">›</span> : null}
    </>
  );

  return (
    <button
      type="button"
      role="menuitem"
      className={`menu__item ${item.danger ? 'menu__item--danger' : ''}`.trim()}
      disabled={item.disabled}
      autoFocus={autoFocus}
      title={item.title}
      onClick={() => {
        onToggleSubmenu?.();
        item.onSelect?.();
      }}
      aria-haspopup={hasSubmenu || item.submenu ? 'menu' : undefined}
    >
      {content}
    </button>
  );
}
