import { useState } from 'react';
import { ArrowDownUp, FilePlus2, FolderPlus, PanelLeftClose, RefreshCw } from 'lucide-react';
import FolderTree from './FolderTree.jsx';
import TagCloud from './TagCloud.jsx';
import RepositorySwitcher from './RepositorySwitcher.jsx';
import { formatNumber } from '../lib/format.js';
import { SORT_LABELS } from './NoteListPane.jsx';

const SORT_ORDER = Object.keys(SORT_LABELS);

/**
 * 左侧栏：Obsidian 式文件列表。
 * 顶部纯图标工具栏，下面依次是目录树 / 标签 / 统计（后两块可折叠）。
 */
export default function Sidebar({
  folders,
  noteIndex,
  canvasFiles = [],
  tags,
  overview,
  filter,
  activeNoteId,
  sort,
  onSelectFolder,
  onOpenNote,
  onSelectTag,
  onClearFilter,
  onSortChange,
  onCreateFolder,
  onDeleteFolder,
  onRenameFolder,
  loading,
  onCreateNote,
  onRevealFolder,
  onRefresh,
  refreshing,
  onCollapseSidebar,
  onOpenCanvas,
  onCreateCanvas,
  canvasPath,
  favoriteFolderIds,
  onDuplicateFolder,
  onMoveFolder,
  onFindInFolder,
  onToggleFavorite,
  onCopyFolderPath,
  onToggleNotePin,
  onDuplicateNote,
  onMoveNote,
  onMoveCanvas,
  onCopyNotePath,
  onOpenDefault,
  onRevealNote,
  onRenameNote,
  onDeleteNote,
}) {
  const [collapsed, setCollapsed] = useState({ tags: false, stats: false });
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  const toggle = (key) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  const cycleSort = () => {
    const index = SORT_ORDER.indexOf(sort);
    onSortChange(SORT_ORDER[(index + 1) % SORT_ORDER.length]);
  };

  const submitNewFolder = async (event) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    const created = await onCreateFolder(name, null);
    if (created) {
      setNewFolderName('');
      setCreating(false);
    }
  };

  return (
    <aside className="sidebar" aria-label="知识库导航">
      <div className="sidebar__toolbar" role="toolbar" aria-label="文件列表操作">
        <button type="button" className="sidebar__toolbtn" onClick={onCreateNote} aria-label="新建笔记">
          <FilePlus2 size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`sidebar__toolbtn ${creating ? 'is-active' : ''}`}
          onClick={() => setCreating((value) => !value)}
          aria-label="新建目录"
        >
          <FolderPlus size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="sidebar__toolbtn" onClick={cycleSort} aria-label="切换排序">
          <ArrowDownUp size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="sidebar__toolbtn" onClick={onRefresh} disabled={refreshing} aria-label="刷新">
          <RefreshCw size={18} strokeWidth={1.75} className={refreshing ? 'is-spinning' : undefined} aria-hidden="true" />
        </button>
        <span className="sidebar__toolbar-space" aria-hidden="true" />
        <button type="button" className="sidebar__toolbtn" onClick={onCollapseSidebar} aria-label="收起侧边栏">
          <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar__explorer">
        {creating ? (
          <form className="inline-form" onSubmit={submitNewFolder}>
            <input
              autoFocus
              value={newFolderName}
              maxLength={120}
              placeholder="目录名称，回车确认"
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setCreating(false);
                  setNewFolderName('');
                }
              }}
            />
          </form>
        ) : null}

        <button
          type="button"
          className={`nav-item ${filter.kind === 'all' ? 'is-active' : ''}`}
          onClick={onClearFilter}
        >
          <span className="nav-item__label">全部笔记</span>
          <span className="nav-item__badge">{formatNumber(overview?.noteCount ?? 0)}</span>
        </button>

        <FolderTree
          nodes={folders}
          notes={noteIndex}
          canvasFiles={canvasFiles}
          filter={filter}
          activeNoteId={activeNoteId}
          loading={loading}
          onSelectFolder={onSelectFolder}
          onOpenNote={onOpenNote}
          onCreateFolder={onCreateFolder}
          onCreateNote={onCreateNote}
          onRevealFolder={onRevealFolder}
          onDeleteFolder={onDeleteFolder}
          onRenameFolder={onRenameFolder}
          onOpenCanvas={onOpenCanvas}
          onCreateCanvas={onCreateCanvas}
          canvasPath={canvasPath}
          favoriteFolderIds={favoriteFolderIds}
          onDuplicateFolder={onDuplicateFolder}
          onMoveFolder={onMoveFolder}
          onFindInFolder={onFindInFolder}
          onToggleFavorite={onToggleFavorite}
          onCopyFolderPath={onCopyFolderPath}
          onToggleNotePin={onToggleNotePin}
          onDuplicateNote={onDuplicateNote}
          onMoveNote={onMoveNote}
          onMoveCanvas={onMoveCanvas}
          onCopyNotePath={onCopyNotePath}
          onOpenDefault={onOpenDefault}
          onRevealNote={onRevealNote}
          onRenameNote={onRenameNote}
          onDeleteNote={onDeleteNote}
        />
      </div>

      <Section title="标签" count={tags.length} collapsed={collapsed.tags} onToggle={() => toggle('tags')}>
        <TagCloud tags={tags} filter={filter} onSelectTag={onSelectTag} />
      </Section>

      <Section title="统计" collapsed={collapsed.stats} onToggle={() => toggle('stats')}>
        <dl className="stats">
          <Stat label="笔记" value={overview?.noteCount} />
          <Stat label="目录" value={overview?.folderCount} />
          <Stat label="标签" value={overview?.tagCount} />
          <Stat label="链接" value={overview?.linkCount} />
          <Stat label="总字数" value={overview?.totalWords} />
        </dl>

        {overview?.danglingLinks?.length ? (
          <div className="dangling">
            <div className="dangling__title">待补全的引用（{overview.danglingLinks.length}）</div>
            <ul className="dangling__list">
              {overview.danglingLinks.slice(0, 6).map((item) => (
                <li key={item.targetTitle}>
                  <span className="dangling__name">{item.targetTitle}</span>
                  <span className="dangling__count">×{item.referenceCount}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <div className="sidebar__footer">
        <RepositorySwitcher />
      </div>
    </aside>
  );
}

function Section({ title, count, collapsed, onToggle, children }) {
  return (
    <section className="panel">
      <div className="panel__head">
        <button type="button" className="panel__toggle" onClick={onToggle} aria-expanded={!collapsed}>
          <span className={`caret ${collapsed ? 'is-collapsed' : ''}`} aria-hidden="true">▾</span>
          <span className="panel__title">{title}</span>
          {count === undefined ? null : <span className="panel__count">{count}</span>}
        </button>
      </div>
      {collapsed ? null : <div className="panel__body">{children}</div>}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stats__item">
      <dt>{label}</dt>
      <dd>{formatNumber(value ?? 0)}</dd>
    </div>
  );
}
