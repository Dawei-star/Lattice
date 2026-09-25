import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRelativeTime } from '../lib/format.js';

/**
 * 快速切换器（Ctrl / Cmd + K）。
 * 在标题索引里做加权模糊匹配：前缀命中 > 包含命中 > 子序列命中。
 * 没有任何命中时提供「以此标题新建」的入口，这条路径同时也用于补全悬空链接。
 */
export default function QuickSwitcher({ open, noteIndex, onClose, onSelect, onCreate }) {
  const [keyword, setKeyword] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setKeyword('');
      setCursor(0);
      // 等弹层挂载完成再聚焦，否则 focus 会丢失
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const matches = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase();
    if (!trimmed) {
      return noteIndex.slice(0, 40).map((note) => ({ note, score: 0 }));
    }

    return noteIndex
      .map((note) => ({ note, score: scoreTitle(note.title.toLowerCase(), trimmed) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }, [keyword, noteIndex]);

  const exactMatch = matches.some((item) => item.note.title.toLowerCase() === keyword.trim().toLowerCase());
  const showCreate = keyword.trim().length > 0 && !exactMatch;
  const optionCount = matches.length + (showCreate ? 1 : 0);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, optionCount - 1)));
  }, [optionCount]);

  useEffect(() => {
    const node = listRef.current?.querySelector('.switcher__item.is-cursor');
    node?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  // 在 window 上监听 Esc：焦点若因任何原因不在对话框内（例如用户点了遮罩边缘），
  // 仅靠对话框自身的 onKeyDown 会漏掉关闭操作
  useEffect(() => {
    if (!open) return undefined;

    const handler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const commit = (index) => {
    if (index < matches.length) {
      onSelect(matches[index].note);
      return;
    }
    if (showCreate) onCreate(keyword.trim());
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((current) => (current + 1) % Math.max(1, optionCount));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((current) => (current - 1 + optionCount) % Math.max(1, optionCount));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit(cursor);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="switcher"
        role="dialog"
        aria-modal="true"
        aria-label="快速切换笔记"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="switcher__search">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
            <path d="M7 1a6 6 0 1 0 3.7 10.7l3.3 3.3 1.4-1.4-3.3-3.3A6 6 0 0 0 7 1Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" fill="currentColor" />
          </svg>
          <input
            ref={inputRef}
            value={keyword}
            placeholder="输入标题跳转，或输入新标题直接创建…"
            aria-label="检索笔记标题"
            onChange={(event) => {
              setKeyword(event.target.value);
              setCursor(0);
            }}
          />
          <span className="kbd">Esc</span>
        </div>

        <ul className="switcher__list" ref={listRef} role="listbox">
          {matches.map((item, index) => (
            <li key={item.note.id}>
              <button
                type="button"
                role="option"
                aria-selected={cursor === index}
                className={`switcher__item ${cursor === index ? 'is-cursor' : ''}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => onSelect(item.note)}
              >
                <span className="switcher__title">{item.note.title}</span>
                <span className="switcher__meta">{formatRelativeTime(item.note.updatedAt)}</span>
              </button>
            </li>
          ))}

          {showCreate ? (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={cursor === matches.length}
                className={`switcher__item switcher__item--create ${cursor === matches.length ? 'is-cursor' : ''}`}
                onMouseEnter={() => setCursor(matches.length)}
                onClick={() => onCreate(keyword.trim())}
              >
                <span className="switcher__title">新建「{keyword.trim()}」</span>
                <span className="switcher__meta">创建并打开</span>
              </button>
            </li>
          ) : null}

          {optionCount === 0 ? (
            <li className="switcher__empty">没有匹配的笔记，输入新标题即可创建。</li>
          ) : null}
        </ul>

        <div className="switcher__footer">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> 选择</span>
          <span><span className="kbd">Enter</span> 打开</span>
          <span><span className="kbd">Esc</span> 关闭</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 标题打分：前缀命中给最高分，其次按位置加权的包含命中，最后是子序列命中。
 * @returns {number} 0 表示不匹配
 */
function scoreTitle(title, keyword) {
  if (title === keyword) return 1000;
  if (title.startsWith(keyword)) return 800 - title.length;
  if (title.includes(keyword)) return 500 - title.indexOf(keyword);

  // 子序列匹配：允许「架分」命中「架构分层」，但不强求连续
  let cursor = 0;
  let gapPenalty = 0;
  for (const char of keyword) {
    const found = title.indexOf(char, cursor);
    if (found === -1) return 0;
    gapPenalty += found - cursor;
    cursor = found + 1;
  }
  return Math.max(1, 300 - gapPenalty);
}
