import { useMemo } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import { formatNumber, formatRelativeTime } from '../lib/format.js';
import { highlightText } from '../lib/markdown.js';
import ContextMenu from '../ui/ContextMenu.jsx';

export const SORT_LABELS = {
  updated: '最近更新',
  created: '创建时间',
  title: '标题',
};

const INBOX_STATUS_LABELS = {
  all: '全部 Inbox',
  captured: '待整理',
  processing: '整理中',
  processed: '已处理',
};

/**
 * 中栏：笔记列表。
 * 检索词非空时切换为「检索结果」模式，命中片段里的关键词高亮显示。
 */
export default function NoteListPane({
  notes,
  notesTotal,
  page,
  pageCount,
  search,
  filter,
  sort,
  query,
  onQueryChange,
  showSearch,
  folderLookup,
  tagLookup,
  folders,
  activeNoteId,
  loading,
  onSortChange,
  onPageChange,
  onOpenNote,
  onTogglePin,
  onInboxStatusChange,
  onOpenInboxAi,
  onUpdateInboxStatus,
  onArchiveInbox,
  onDeleteNote,
  onCreateNote,
  onDuplicateNote,
  onCopyPath,
  onCopyWikiLink,
}) {
  const isSearching = search.query.length > 0;

  const filterLabel = useMemo(() => {
    if (filter.kind === 'folder') return filter.folderId ? folderLookup.get(filter.folderId) ?? '目录' : '未分类';
    if (filter.kind === 'tag') return `#${tagLookup.get(filter.tagId) ?? ''}`;
    if (filter.kind === 'inbox') return 'Inbox';
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

        <div className="listpane__controls">
          {filter.kind === 'inbox' ? (
            <>
            <button
              type="button"
              className="btn btn--sm listpane__ai-action"
              onClick={() => onOpenInboxAi?.()}
              title="让 AI 读取待整理 Inbox 内容并生成可确认的归档方案"
              disabled={loading || notesTotal === 0}
            >
              <Sparkles size={13} strokeWidth={1.9} aria-hidden="true" />
              <span>AI 整理</span>
            </button>
            <select
              className="select"
              value={filter.inboxStatus ?? 'all'}
              aria-label="Inbox 状态"
              onChange={(event) => onInboxStatusChange?.(event.target.value)}
            >
              {Object.entries(INBOX_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            </>
          ) : null}
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
      </div>

      <div className="listpane__body">
        {loading && items.length === 0 ? (
          <SkeletonList />
        ) : items.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state__title">{isSearching ? '没有匹配的笔记' : filter.kind === 'inbox' ? `${INBOX_STATUS_LABELS[filter.inboxStatus ?? 'all']}暂无内容` : '这里还没有笔记'}</p>
            <p className="empty-state__hint">
              {isSearching ? '换个关键词试试，或清空检索框浏览全部笔记。' : filter.kind === 'inbox' ? '新的收集会显示在这里。' : '新建一篇，开始记录你的想法。'}
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
                folders={folders}
                onUpdateInboxStatus={onUpdateInboxStatus}
                onArchiveInbox={onArchiveInbox}
                onDelete={() => onDeleteNote(note.id)}
                onDuplicate={() => onDuplicateNote?.(note)}
                onCopyPath={() => onCopyPath?.(note)}
                onCopyWikiLink={() => onCopyWikiLink?.(note)}
              />
            ))}
          </ul>
        )}
      </div>
      {!isSearching && pageCount > 1 ? (
        <nav className="listpane__pagination" aria-label="Note pagination">
          <button type="button" className="btn btn--icon" onClick={() => onPageChange?.(page - 1)} disabled={page <= 0} aria-label="Previous page" title="Previous page">{'<'}</button>
          <span>{page + 1} / {pageCount}</span>
          <button type="button" className="btn btn--icon" onClick={() => onPageChange?.(page + 1)} disabled={page >= pageCount - 1} aria-label="Next page" title="Next page">{'>'}</button>
        </nav>
      ) : null}
    </section>
  );
}

function NoteCard({ note, query, active, onOpen, onTogglePin, onDelete, onDuplicate, onCopyPath, onCopyWikiLink, folders, onUpdateInboxStatus, onArchiveInbox }) {
  const excerpt = note.excerpt ?? '';
  const isInboxNote = note.properties?.type === 'inbox';
  const inboxStatus = isInboxNote ? note.properties?.status ?? 'captured' : null;
  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);
  const archiveTargets = folderOptions.filter((folder) => folder.id !== note.folderId && folder.name !== 'Inbox');

  return (
    <li>
      <ContextMenu
        label={`笔记「${note.title}」操作`}
        getItems={() => [
          { id: 'open', label: '打开笔记', onSelect: onOpen },
          ...(isInboxNote ? [
            { id: 'status-processing', label: '标记为整理中', disabled: inboxStatus === 'processing', onSelect: () => onUpdateInboxStatus?.(note, 'processing') },
            { id: 'status-processed', label: '标记为已处理', disabled: inboxStatus === 'processed', onSelect: () => onUpdateInboxStatus?.(note, 'processed') },
            {
              id: 'archive',
              label: '归档到项目',
              submenuItems: [
                { id: 'archive-unfiled', label: '未分类', onSelect: () => onArchiveInbox?.(note, null) },
                ...archiveTargets.map((folder) => ({
                  id: `archive-${folder.id}`,
                  label: folder.path,
                  onSelect: () => onArchiveInbox?.(note, folder.id),
                })),
              ],
            },
            { separator: true },
          ] : []),
          { id: 'pin', label: note.isPinned ? '取消置顶' : '置顶', onSelect: onTogglePin },
          { id: 'duplicate', label: '创建副本', onSelect: onDuplicate },
          { id: 'copy-path', label: '复制路径', onSelect: onCopyPath },
          { id: 'copy-link', label: '复制双链', onSelect: onCopyWikiLink },
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
            {isInboxNote ? <span className={`inbox-status inbox-status--${inboxStatus}`}>{INBOX_STATUS_LABELS[inboxStatus] ?? '待整理'}</span> : null}
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

        {isInboxNote && inboxStatus !== 'processed' ? (
          <button
            type="button"
            className="icon-btn notecard__inbox-action"
            title="标记为已处理"
            aria-label="标记为已处理"
            onClick={(event) => {
              event.stopPropagation();
              onUpdateInboxStatus?.(note, 'processed');
            }}
          >
            <CheckCircle2 size={15} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}

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

function flattenFolders(nodes, parentPath = '', result = []) {
  for (const folder of nodes ?? []) {
    const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
    result.push({ id: folder.id, name: folder.name, path });
    flattenFolders(folder.children, path, result);
  }
  return result;
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
