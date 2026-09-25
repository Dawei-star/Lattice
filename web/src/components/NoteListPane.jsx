import { memo, useMemo } from 'react';
import { formatNumber, formatRelativeTime } from '../lib/format.js';
import { highlightText } from '../lib/markdown.js';

const SORT_LABELS = {
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
  folderLookup,
  tagLookup,
  activeNoteId,
  loading,
  onSortChange,
  onOpenNote,
  onTogglePin,
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
                onOpenNote={onOpenNote}
                onTogglePin={onTogglePin}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function PinIcon({ filled }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon icon--sm">
      <path
        d="M4 2.5h8a.5.5 0 0 1 .5.5v10.2a.5.5 0 0 1-.8.4L8 11.5l-3.7 2.1a.5.5 0 0 1-.8-.4V3a.5.5 0 0 1 .5-.5Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 单张笔记卡片。
 *
 * memo 化的前提是 props 全部稳定：父层不再传 `() => onOpenNote(note.id)` 这类
 * 每次渲染都新建的闭包，而是把稳定回调与 note 一起传下来，命中变化时才重渲染。
 */
const NoteCard = memo(function NoteCard({ note, query, active, onOpenNote, onTogglePin }) {
  const excerpt = note.excerpt ?? '';

  return (
    <li>
      <article className={`notecard ${active ? 'is-active' : ''}`}>
        <button type="button" className="notecard__main" onClick={() => onOpenNote(note.id)}>
          <div className="notecard__row">
            {note.isPinned ? (
              <span className="notecard__pin" title="已置顶">
                <PinIcon filled />
              </span>
            ) : null}
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
          className={`icon-btn notecard__pinbtn ${note.isPinned ? 'is-pin-on' : ''}`}
          title={note.isPinned ? '取消置顶' : '置顶'}
          aria-label={note.isPinned ? '取消置顶' : '置顶'}
          onClick={() => onTogglePin(note)}
        >
          <PinIcon filled={note.isPinned} />
        </button>
      </article>
    </li>
  );
});

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
