import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownUp, FilePlus2, FolderPlus, PanelLeftClose, RefreshCw } from 'lucide-react';
import FolderTree from './FolderTree.tsx';
import TagCloud from './TagCloud.tsx';
import RepositorySwitcher from './RepositorySwitcher.tsx';
import { formatNumber } from '../lib/format.ts';
import { nextFolderName } from '../lib/folder-naming.ts';
import { SORT_LABELS } from './NoteListPane.tsx';
import type { Tag, FolderNode, MetaOverview } from '../api/resources.ts';
import type { CanvasFileSummary } from '../api/canvas.ts';
import type { AttachmentRow, InboxStatus, NoteIndexRow, NoteSortOrder, VaultFilter } from '../hooks/useVault.ts';
import type { NoteCardNote } from './NoteListPane.tsx';
import type { RepositorySwitcherProps } from './RepositorySwitcher.tsx';

const SORT_ORDER = Object.keys(SORT_LABELS) as NoteSortOrder[];

export interface SidebarProps {
  folders: FolderNode[];
  noteIndex: NoteIndexRow[];
  canvasFiles?: CanvasFileSummary[];
  attachmentFiles?: AttachmentRow[];
  tags: Tag[];
  overview?: MetaOverview | null;
  filter: VaultFilter;
  inboxCount?: number;
  activeNoteId?: string | null;
  sort: NoteSortOrder;
  loading?: boolean;
  onSelectFolder: (folderId: string | null) => void;
  onOpenNote: (noteId: string) => void;
  onSelectTag: (tagId: string) => void;
  onClearFilter: () => void;
  onSelectInbox?: (status: InboxStatus) => void;
  onSortChange: (sort: NoteSortOrder) => void;
  onCreateFolder: (name: string, parentId?: string | null) => Promise<FolderNode | null> | FolderNode | null;
  onDeleteFolder: (folderId: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onCreateNote?: (folderId?: string | null) => void;
  onRevealFolder: (folderPath: string) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  onCollapseSidebar: () => void;
  onOpenCanvas?: (canvasPath?: string) => void;
  onCreateCanvas?: (folderPath?: string) => void;
  canvasPath?: string | null;
  favoriteFolderIds?: string[];
  onDuplicateFolder: (folder: FolderNode) => void;
  onMoveFolder: (folderId: string, parentId: string | null) => void;
  onFindInFolder: (folderId: string) => void;
  onToggleFavorite: (folderId: string) => void;
  onCopyFolderPath: (folderPath: string, mode?: 'relative' | 'absolute') => void;
  onToggleNotePin: (note: { id: string; isPinned: boolean }) => void;
  onDuplicateNote: (note: { id: string }) => void;
  onMoveNote: (noteId: string, folderId: string | null) => void;
  onMoveCanvas: (fromPath: string, targetFolderPath?: string) => void;
  onRenameCanvas: (fromPath: string, nextName: string) => void;
  onDeleteCanvas: (filePath: string) => void;
  onOpenAttachment: (relativePath: string) => void;
  onDownloadAttachment: (relativePath: string) => void;
  onRevealAttachment: (relativePath: string) => void;
  onCopyAttachmentPath: (relativePath: string, mode?: 'relative' | 'absolute') => void;
  onOpenCanvasDefault: (relativePath: string) => void;
  onRevealCanvas: (relativePath: string) => void;
  onCopyCanvasPath: (relativePath: string, mode?: 'relative' | 'absolute') => void;
  onCopyNotePath: (note: NoteCardNote, mode?: 'relative' | 'absolute') => void;
  onOpenDefault: (note: NoteCardNote | null) => void;
  onRevealNote: (note: NoteCardNote | null) => void;
  onRenameNote: (note: { id: string; title: string; external?: boolean }) => void;
  onDeleteNote: (noteId: string) => void;
  onConfirmFileOperation?: RepositorySwitcherProps['onConfirmFileOperation'];
}

/**
 * 左侧栏：Obsidian 式文件列表。
 * 顶部纯图标工具栏，下面依次是目录树 / 标签 / 统计（后两块可折叠）。
 */
export default function Sidebar({
  folders,
  noteIndex,
  canvasFiles = [],
  attachmentFiles = [],
  tags,
  overview,
  filter,
  inboxCount = 0,
  activeNoteId,
  sort,
  onSelectFolder,
  onOpenNote,
  onSelectTag,
  onClearFilter,
  onSelectInbox,
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
  onRenameCanvas,
  onDeleteCanvas,
  onOpenAttachment,
  onDownloadAttachment,
  onRevealAttachment,
  onCopyAttachmentPath,
  onOpenCanvasDefault,
  onRevealCanvas,
  onCopyCanvasPath,
  onCopyNotePath,
  onOpenDefault,
  onRevealNote,
  onRenameNote,
  onDeleteNote,
  onConfirmFileOperation,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState({ tags: false, stats: false });
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const creatingFolderRef = useRef(false);

  const toggle = (key: 'tags' | 'stats') => setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  const cycleSort = () => {
    const index = SORT_ORDER.indexOf(sort);
    onSortChange(SORT_ORDER[(index + 1) % SORT_ORDER.length]);
  };

  const handleCreateFolder = useCallback(async (name: string, parentId: string | null = null): Promise<FolderNode | null> => {
    const created = await onCreateFolder(name, parentId);
    if (created?.id) setRenameFolderId(created.id);
    return created;
  }, [onCreateFolder]);

  const handleCreateRootFolder = async () => {
    if (creatingFolderRef.current) return;
    creatingFolderRef.current = true;
    setCreatingFolder(true);
    try {
      await handleCreateFolder(nextFolderName(folders), null);
    } finally {
      creatingFolderRef.current = false;
      setCreatingFolder(false);
    }
  };

  const handleRenameFolderReady = useCallback((id: string) => {
    setRenameFolderId((current) => (current === id ? null : current));
  }, []);

  return (
    <aside className="sidebar" aria-label="知识库导航">
      <div className="sidebar__toolbar" role="toolbar" aria-label="文件列表操作">
        <button type="button" className="sidebar__toolbtn" onClick={() => onCreateNote?.()} aria-label="新建笔记" title="新建笔记">
          <FilePlus2 size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sidebar__toolbtn"
          onClick={handleCreateRootFolder}
          disabled={creatingFolder}
          aria-label="新建目录"
          title="新建文件夹"
        >
          <FolderPlus size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="sidebar__toolbtn" onClick={cycleSort} aria-label="切换排序" title="切换排序">
          <ArrowDownUp size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="sidebar__toolbtn" onClick={onRefresh} disabled={refreshing} aria-label="刷新" title="刷新">
          <RefreshCw size={18} strokeWidth={1.75} className={refreshing ? 'is-spinning' : undefined} aria-hidden="true" />
        </button>
        <span className="sidebar__toolbar-space" aria-hidden="true" />
        <button type="button" className="sidebar__toolbtn" onClick={onCollapseSidebar} aria-label="收起侧边栏" title="收起侧边栏">
          <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar__explorer">
        <button
          type="button"
          className={`nav-item ${filter.kind === 'all' ? 'is-active' : ''}`}
          onClick={onClearFilter}
        >
          <span className="nav-item__label">全部笔记</span>
          <span className="nav-item__badge">{formatNumber(overview?.noteCount ?? 0)}</span>
        </button>

        <button
          type="button"
          className={`nav-item nav-item--inbox ${filter.kind === 'inbox' ? 'is-active' : ''}`}
          onClick={() => onSelectInbox?.('all')}
        >
          <span className="nav-item__label">Inbox</span>
          <span className="nav-item__badge">{formatNumber(inboxCount)}</span>
        </button>

        <FolderTree
          nodes={folders}
          notes={noteIndex}
          canvasFiles={canvasFiles}
          attachmentFiles={attachmentFiles}
          filter={filter}
          activeNoteId={activeNoteId}
          loading={loading}
          onSelectFolder={onSelectFolder}
          onOpenNote={onOpenNote}
          onCreateFolder={handleCreateFolder}
          renameFolderId={renameFolderId}
          onRenameFolderReady={handleRenameFolderReady}
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
          onRenameCanvas={onRenameCanvas}
          onDeleteCanvas={onDeleteCanvas}
          onOpenAttachment={onOpenAttachment}
          onDownloadAttachment={onDownloadAttachment}
          onRevealAttachment={onRevealAttachment}
          onCopyAttachmentPath={onCopyAttachmentPath}
          onOpenCanvasDefault={onOpenCanvasDefault}
          onRevealCanvas={onRevealCanvas}
          onCopyCanvasPath={onCopyCanvasPath}
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
        <RepositorySwitcher onConfirmFileOperation={onConfirmFileOperation} />
      </div>
    </aside>
  );
}

interface SectionProps {
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

function Section({ title, count, collapsed, onToggle, children }: SectionProps) {
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

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="stats__item">
      <dt>{label}</dt>
      <dd>{formatNumber(value ?? 0)}</dd>
    </div>
  );
}
