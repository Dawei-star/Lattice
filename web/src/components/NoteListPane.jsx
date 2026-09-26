import { useMemo } from 'react';
import { formatNumber, formatRelativeTime } from '../lib/format.js';
import { highlightText } from '../lib/markdown.js';
import ContextMenu from '../ui/ContextMenu.jsx';

export const SORT_LABELS = {
  updated: '最近更新',
  created: '创建时间',
  title: '标题',
};

/**
 * 中栏：笔记列表。
 * 检索词非空时切换为「检索结果」模式，命中片段里的关键词高亮显示。
 */
export default function NoteListPane({
  notes,
  notesTotal,
  search,
  filter,
  sort,
  query,
  onQueryChange,
  showSearch,
  folderLookup,
  tagLookup,
  activeNoteId,
  loading,
  onSortChange,
  onOpenNote,
  onTogglePin,
  onDeleteNote,
  onCreateNote,
}) {
  const isSearching = search.query.length > 0;

  const filterLabel = useMemo(() => {
    if (filter.kind === 'folder') return filter.folderId ? folderLookup.get(filter.folderId) ?? '目录' : '未分类';
    if (filter.kind === 'tag') return `#${tagLookup.get(filter.tagId) ?? ''}`;
    return '全部笔记';
  }, [filter, folderLookup, tagLookup]);

  const items = isSearching ? search.items : notes;

  return (
    <section className="listpane" aria-label="笔记列表">
      {showSearch ? (
        <div className="listpane__search">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
            <path
              d="M7 1a6 6 0 1 0 3.7 10.7l3.3 3.3 1.4-1.4-3.3-3.3A6 6 0 0 0 7 1Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
              fill="currentColor"
            />
          </svg>
          <input
            type="search"
            value={query}
            placeholder="全文检索笔记内容与标题…"
            aria-label="全文检索"
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query ? (
            <button type="button" className="listpane__search-clear" onClick={() => onQueryChange('')} aria-label="清空检索">
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="listpane__head">
        <div className="listpane__title">
          <span>{isSearching ? '检索结果' : filterLabel}</span>
          <span className="listpane__count">
            {isSearching ? formatNumber(search.items.length) : formatNumber(notesTotal)}
          </span>
        </div>

        {isSearching ? (
          <span className="listpane__strategy" title="服务端采用的检索策略">
            {search.loading ? '检索中…' : search.strategy === 'fts' ? 'FTS5 全文索引' : 'LIKE 匹配'}
          </span>
        ) : (
          <select
            className="select"
            value={sort}
            aria-label="排序方式"
            onChange={(event) => onSortChange(event.target.value)}
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="listpane__body">
        {loading && items.length === 0 ? (
          <SkeletonList />
        ) : items.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state__title">{isSearching ? '没有匹配的笔记' : '这里还没有笔记'}</p>
            <p className="empty-state__hint">
              {isSearching ? '换个关键词试试，或清空检索框浏览全部笔记。' : '新建一篇，开始记录你的想法。'}
            </p>
            {isSearching ? null : (
              <button type="button" className="btn btn--primary" onClick={onCreateNote}>
                新建笔记
              </button>
            )}
          </div>
        ) : (
          <ul className="notelist">
            {items.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                query={isSearching ? search.query : ''}
                active={note.id === activeNoteId}
                onOpen={() => onOpenNote(note.id)}
                onTogglePin={() => onTogglePin(note)}
                onDelete={() => onDeleteNote(note.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function NoteCard({ note, query, active, onOpen, onTogglePin, onDelete }) {
  const excerpt = note.excerpt ?? '';

  return (
    <li>
      <ContextMenu
        label={`笔记「${note.title}」操作`}
        getItems={() => [
          { id: 'open', label: '打开笔记', onSelect: onOpen },
          { id: 'pin', label: note.isPinned ? '取消置顶' : '置顶', onSelect: onTogglePin },
          { separator: true },
          { id: 'delete', label: '删除笔记', danger: true, onSelect: () => {
            if (window.confirm(`确定删除笔记「${note.title}」吗？`)) onDelete();
          } },
        ]}
      >
      <article className={`notecard ${active ? 'is-active' : ''}`}>
        <button type="button" className="notecard__main" onClick={onOpen}>
          <div className="notecard__row">
            {note.isPinned ? <span className="notecard__pin" title="已置顶">★</span> : null}
            <h3 className="notecard__title">{note.title}</h3>
          </div>

          {excerpt ? (
            <p
              className="notecard__excerpt"
              // 片段经由 escapeHtml 处理，仅在命中位置插入 <mark>
              dangerouslySetInnerHTML={{ __html: highlightText(excerpt, query) }}
            />
          ) : (
            <p className="notecard__excerpt notecard__excerpt--empty">（空白笔记）</p>
          )}

          <div className="notecard__meta">
            <span>{formatRelativeTime(note.updatedAt)}</span>
            {note.wordCount > 0 ? <span>{formatNumber(note.wordCount)} 字</span> : null}
            {note.backlinkCount > 0 ? <span title="被引用次数">↙ {note.backlinkCount}</span> : null}
            {note.outgoingCount > 0 ? <span title="引用他人次数">↗ {note.outgoingCount}</span> : null}
          </div>

          {note.tags?.length ? (
            <div className="notecard__tags">
              {note.tags.slice(0, 4).map((tag) => (
                <span key={tag.id} className="tag tag--mini">#{tag.name}</span>
              ))}
              {note.tags.length > 4 ? <span className="tag tag--mini">+{note.tags.length - 4}</span> : null}
            </div>
          ) : null}
        </button>

        <button
          type="button"
          className={`icon-btn notecard__pinbtn ${note.isPinned ? 'is-on' : ''}`}
          title={note.isPinned ? '取消置顶' : '置顶'}
          aria-label={note.isPinned ? '取消置顶' : '置顶'}
          onClick={onTogglePin}
        >
          ★
        </button>
      </article>
      </ContextMenu>
    </li>
  );
}

function SkeletonList() {
  return (
    <ul className="notelist" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <li key={index}>
          <div className="notecard skeleton">
            <div className="skeleton__line skeleton__line--title" />
            <div className="skeleton__line" />
            <div className="skeleton__line skeleton__line--short" />
          </div>
        </li>
      ))}
    </ul>
  );
}
