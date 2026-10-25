import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent } from 'react';
import ContextMenu from '../ui/ContextMenu.tsx';
import { nextFolderName } from '../lib/folder-naming.ts';
import { canvasDisplayName, toCanvasFileName } from '../lib/canvas-naming.ts';
import type { MenuItemDef } from '../ui/Menu.tsx';
import type { FolderNode } from '../api/resources.ts';
import type { CanvasFileSummary } from '../api/canvas.ts';
import type { AttachmentRow, NoteIndexRow, VaultFilter } from '../hooks/useVault.ts';

/** 树节点拖拽载荷（按类型携带不同字段）。 */
type TreeDragItem =
  | { type: 'folder'; id: string; parentId: string | null; path?: string }
  | { type: 'note'; id: string; folderId: string | null; path?: string }
  | { type: 'canvas'; path: string; folderPath: string; id?: string };

/** 拖拽上下文状态。 */
interface TreeDragState {
  draggingItem: TreeDragItem | null;
  dropTargetId: string | null | undefined;
  handleDragStart: (event: ReactDragEvent, item: TreeDragItem) => void;
  handleDragEnd: () => void;
  handleDragOver: (event: ReactDragEvent, targetFolderId: string | null) => void;
  handleDrop: (event: ReactDragEvent, targetFolderId: string | null) => Promise<void>;
}

/** 扁平化后的目录项（用于路径查找与移动目标列表）。 */
interface FolderOption {
  id: string;
  path: string;
  parentId?: string | null;
}

/** 目录树回调集合（FolderTree 与 FolderNode 共享）。 */
interface TreeCallbacks {
  onSelectFolder: (folderId: string | null) => void;
  onOpenNote: (noteId: string) => void;
  onCreateFolder: (name: string, parentId?: string | null) => Promise<FolderNode | null> | FolderNode | null;
  onRevealFolder: (folderPath: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onRenameFolder: (folderId: string, name: string) => unknown;
  onRenameFolderReady?: (id: string) => void;
  onCreateNote?: (folderId?: string | null) => void;
  onOpenCanvas?: (canvasPath?: string) => void;
  onCreateCanvas?: (folderPath?: string) => void;
  canvasPath?: string | null;
  onOpenAttachment?: (relativePath: string) => void;
  onDownloadAttachment?: (relativePath: string) => void;
  onRevealAttachment?: (relativePath: string) => void;
  onCopyAttachmentPath?: (relativePath: string, mode?: 'relative' | 'absolute') => void;
  onDuplicateFolder?: (folder: FolderNode) => unknown;
  onMoveFolder?: (folderId: string, parentId: string | null) => unknown;
  onFindInFolder?: (folderId: string) => void;
  onToggleFavorite?: (folderId: string) => void;
  onCopyFolderPath?: (folderPath: string, mode?: 'relative' | 'absolute') => void;
  onToggleNotePin?: (note: { id: string; isPinned: boolean }) => void;
  onDuplicateNote?: (note: { id: string }) => void;
  onMoveNote?: (noteId: string, folderId: string | null) => unknown;
  onMoveCanvas?: (fromPath: string, targetFolderPath?: string) => unknown;
  onRenameCanvas?: (fromPath: string, nextName: string) => unknown;
  onDeleteCanvas?: (filePath: string) => void;
  onCopyCanvasPath?: (relativePath: string, mode?: 'relative' | 'absolute') => void;
  onOpenCanvasDefault?: (relativePath: string) => void;
  onRevealCanvas?: (relativePath: string) => void;
  onCopyNotePath?: (note: NoteIndexRow, mode?: 'relative' | 'absolute') => void;
  onOpenDefault?: (note: NoteIndexRow | null) => void;
  onRevealNote?: (note: NoteIndexRow | null) => void;
  onRenameNote?: (note: NoteIndexRow) => void;
  onDeleteNote?: (noteId: string) => void;
}

interface FolderTreeProps extends TreeCallbacks {
  nodes: FolderNode[];
  notes?: NoteIndexRow[];
  filter: VaultFilter;
  activeNoteId?: string | null;
  favoriteFolderIds?: string[];
  renameFolderId?: string | null;
  canvasFiles?: CanvasFileSummary[];
  attachmentFiles?: AttachmentRow[];
  loading?: boolean;
}

interface FolderNodeProps extends TreeCallbacks {
  node: FolderNode;
  notes: NoteIndexRow[];
  depth: number;
  path: string;
  filter: VaultFilter;
  activeNoteId?: string | null;
  favoriteFolderIds: string[];
  canvasPath: string | null;
  canvasFiles: CanvasFileSummary[];
  attachmentFiles: AttachmentRow[];
  folderOptions: FolderOption[];
  renameFolderId?: string | null;
}

interface NoteFileProps {
  note: NoteIndexRow;
  depth: number;
  activeNoteId?: string | null;
  folderOptions: FolderOption[];
  onOpenNote?: (noteId: string) => void;
  onToggleNotePin?: (note: { id: string; isPinned: boolean }) => void;
  onDuplicateNote?: (note: { id: string }) => void;
  onMoveNote?: (noteId: string, folderId: string | null) => unknown;
  onCopyNotePath?: (note: NoteIndexRow, mode?: 'relative' | 'absolute') => void;
  onOpenDefault?: (note: NoteIndexRow | null) => void;
  onRevealNote?: (note: NoteIndexRow | null) => void;
  onRenameNote?: (note: NoteIndexRow) => void;
  onDeleteNote?: (noteId: string) => void;
}

interface CanvasFileProps {
  file: CanvasFileSummary;
  depth: number;
  active?: boolean;
  folderOptions: FolderOption[];
  onOpenCanvas?: (canvasPath?: string) => void;
  onCreateNote?: (folderId?: string | null) => void;
  onMoveCanvas?: (fromPath: string, targetFolderPath?: string) => unknown;
  onRenameCanvas?: (fromPath: string, nextName: string) => unknown;
  onDeleteCanvas?: (filePath: string) => void;
  onCopyCanvasPath?: (relativePath: string, mode?: 'relative' | 'absolute') => void;
  onOpenCanvasDefault?: (relativePath: string) => void;
  onRevealCanvas?: (relativePath: string) => void;
}

interface AttachmentFileProps {
  file: AttachmentRow;
  depth: number;
  folderOptions: FolderOption[];
  onOpenAttachment?: (relativePath: string) => void;
  onDownloadAttachment?: (relativePath: string) => void;
  onRevealAttachment?: (relativePath: string) => void;
  onCopyAttachmentPath?: (relativePath: string, mode?: 'relative' | 'absolute') => void;
}

interface NoteMenuHandlers {
  folderOptions: FolderOption[];
  onOpenNote?: (noteId: string) => void;
  onToggleNotePin?: (note: { id: string; isPinned: boolean }) => void;
  onDuplicateNote?: (note: { id: string }) => void;
  onMoveNote?: (noteId: string, folderId: string | null) => unknown;
  onCopyNotePath?: (note: NoteIndexRow, mode?: 'relative' | 'absolute') => void;
  onOpenDefault?: (note: NoteIndexRow | null) => void;
  onRevealNote?: (note: NoteIndexRow | null) => void;
  onRenameNote?: (note: NoteIndexRow) => void;
  onDeleteNote?: (noteId: string) => void;
}

const TreeDragContext = createContext<TreeDragState | null>(null);

/**
 * 目录树。递归渲染任意层级，支持就地重命名与删除。
 * 点「未分类」可筛选出没有归属目录的笔记。
 */
export default function FolderTree({
  nodes,
  notes = [],
  filter,
  activeNoteId,
  favoriteFolderIds = [],
  onSelectFolder,
  onOpenNote,
  onCreateFolder,
  renameFolderId,
  onRenameFolderReady,
  onCreateNote,
  onRevealFolder,
  onDeleteFolder,
  onRenameFolder,
  onOpenCanvas,
  onCreateCanvas,
  canvasPath = '画板.canvas',
  canvasFiles = [],
  attachmentFiles = [],
  onOpenAttachment,
  onDownloadAttachment,
  onRevealAttachment,
  onCopyAttachmentPath,
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
  onCopyCanvasPath,
  onOpenCanvasDefault,
  onRevealCanvas,
  onCopyNotePath,
  onOpenDefault,
  onRevealNote,
  onRenameNote,
  onDeleteNote,
}: FolderTreeProps) {
  const folderOptions = flattenFolderNodes(nodes);
  const rootNotes = notes.filter((note) => note.folderId == null);
  // 附件子目录若没有对应的文件夹节点（如未建笔记的纯附件目录），回落到根级展示，避免文件凭空消失
  const folderPaths = new Set(folderOptions.map((folder) => folder.path));
  const rootAttachments = attachmentFiles.filter((file) => !file.folderPath || !folderPaths.has(file.folderPath));

  const folderById = new Map<string | null, FolderOption>(folderOptions.map((folder): [string, FolderOption] => [folder.id, folder]));
  const [draggingItem, setDraggingItem] = useState<TreeDragItem | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null | undefined>(undefined);
  const draggingItemRef = useRef<TreeDragItem | null>(null);

  const canDropOn = useCallback((item: TreeDragItem | null, targetFolderId: string | null): boolean => {
    if (!item) return false;
    if (item.type === 'note') return item.folderId !== targetFolderId;
    if (item.type === 'canvas') {
      const targetPath = folderOptions.find((folder) => folder.id === targetFolderId)?.path ?? '';
      return item.folderPath !== targetPath;
    }
    if (item.type !== 'folder') return false;
    if (item.id === targetFolderId || item.parentId === targetFolderId) return false;

    let current: FolderOption | null | undefined = folderById.get(targetFolderId);
    while (current) {
      if (current.id === item.id) return false;
      current = current.parentId ? folderById.get(current.parentId) : null;
    }
    return true;
  }, [folderById, folderOptions]);

  const clearDragState = useCallback(() => {
    draggingItemRef.current = null;
    setDraggingItem(null);
    setDropTargetId(undefined);
  }, []);

  const handleDragStart = useCallback((event: ReactDragEvent, item: TreeDragItem): void => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-lattice-tree-item', JSON.stringify(item));
    event.dataTransfer.setData('text/plain', (item.type === 'folder' ? item.id : item.path ?? item.id) as string);
    draggingItemRef.current = item;
    setDraggingItem(item);
  }, []);

  const handleDragEnd = useCallback(() => {
    clearDragState();
  }, [clearDragState]);

  const handleDragOver = useCallback((event: ReactDragEvent, targetFolderId: string | null): void => {
    const item = draggingItemRef.current;
    if (!canDropOn(item, targetFolderId)) {
      event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetId(targetFolderId);
  }, [canDropOn]);

  const handleDrop = useCallback(async (event: ReactDragEvent, targetFolderId: string | null): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    const item = draggingItemRef.current;
    if (!canDropOn(item, targetFolderId)) {
      clearDragState();
      return;
    }
    clearDragState();

    const dragItem = item as TreeDragItem;
    if (dragItem.type === 'folder') await onMoveFolder?.(dragItem.id, targetFolderId);
    if (dragItem.type === 'note') await onMoveNote?.(dragItem.id, targetFolderId);
    if (dragItem.type === 'canvas') {
      const targetPath = folderOptions.find((folder) => folder.id === targetFolderId)?.path ?? '';
      await onMoveCanvas?.(dragItem.path, targetPath);
    }
  }, [canDropOn, clearDragState, folderOptions, onMoveCanvas, onMoveFolder, onMoveNote]);

  const treeDrag = {
    draggingItem,
    dropTargetId,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDrop,
  };

  return (
    <TreeDragContext.Provider value={treeDrag}>
      <ul className="tree" role="tree">
      {(nodes ?? []).map((node) => (
        <FolderNode
          key={node.id}
          node={node}
          notes={notes}
          depth={0}
          path={node.name}
          filter={filter}
          activeNoteId={activeNoteId}
          onOpenNote={onOpenNote}
          onSelectFolder={onSelectFolder}
          onCreateFolder={onCreateFolder}
          renameFolderId={renameFolderId}
          onRenameFolderReady={onRenameFolderReady}
          onCreateNote={onCreateNote}
          onRevealFolder={onRevealFolder}
          onDeleteFolder={onDeleteFolder}
          onRenameFolder={onRenameFolder}
          onOpenCanvas={onOpenCanvas}
          onCreateCanvas={onCreateCanvas}
          canvasPath={canvasPath}
          canvasFiles={canvasFiles}
          attachmentFiles={attachmentFiles}
          onOpenAttachment={onOpenAttachment}
          onDownloadAttachment={onDownloadAttachment}
          onRevealAttachment={onRevealAttachment}
          onCopyAttachmentPath={onCopyAttachmentPath}
          folderOptions={folderOptions}
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
          onOpenCanvasDefault={onOpenCanvasDefault}
          onRevealCanvas={onRevealCanvas}
          onCopyCanvasPath={onCopyCanvasPath}
          onCopyNotePath={onCopyNotePath}
          onOpenDefault={onOpenDefault}
          onRevealNote={onRevealNote}
          onRenameNote={onRenameNote}
          onDeleteNote={onDeleteNote}
        />
      ))}
      {canvasFiles.filter((file) => !file.folderPath).map((file) => (
        <CanvasFile
          key={file.path}
          file={file}
          depth={0}
          active={file.path === canvasPath}
          folderOptions={folderOptions}
          onOpenCanvas={onOpenCanvas}
          onCreateNote={onCreateNote}
          onMoveCanvas={onMoveCanvas}
          onRenameCanvas={onRenameCanvas}
          onDeleteCanvas={onDeleteCanvas}
          onCopyCanvasPath={onCopyCanvasPath}
          onOpenCanvasDefault={onOpenCanvasDefault}
          onRevealCanvas={onRevealCanvas}
        />
      ))}
      {rootAttachments.map((file) => (
        <AttachmentFile
          key={file.path}
          file={file}
          depth={0}
          folderOptions={folderOptions}
          onOpenAttachment={onOpenAttachment}
          onDownloadAttachment={onDownloadAttachment}
          onRevealAttachment={onRevealAttachment}
          onCopyAttachmentPath={onCopyAttachmentPath}
        />
      ))}
      {rootNotes.map((note) => (
        <NoteFile
          key={note.id}
          note={note}
          depth={0}
          activeNoteId={activeNoteId}
          folderOptions={folderOptions}
          onOpenNote={onOpenNote}
          onToggleNotePin={onToggleNotePin}
          onDuplicateNote={onDuplicateNote}
          onMoveNote={onMoveNote}
          onCopyNotePath={onCopyNotePath}
          onOpenDefault={onOpenDefault}
          onRevealNote={onRevealNote}
          onRenameNote={onRenameNote}
          onDeleteNote={onDeleteNote}
        />
      ))}
      <li>
        <button
          type="button"
          className={`nav-item nav-item--muted ${filter.kind === 'folder' && filter.folderId === null ? 'is-active' : ''}`}
          onClick={() => onSelectFolder(null)}
        >
          <span className="nav-item__label">未分类</span>
        </button>
      </li>
      {!nodes?.length ? <li className="empty-hint">还没有文件夹，点击上方 + 新建一个。</li> : null}
      {draggingItem ? (
        <li
          className={`tree__root-drop ${dropTargetId === null ? 'is-drop-target' : ''}`}
          onDragOver={(event) => handleDragOver(event, null)}
          onDrop={(event) => handleDrop(event, null)}
        >
          <span>移到根目录</span>
        </li>
      ) : null}
    </ul>
    </TreeDragContext.Provider>
  );
}

function FolderNode({
  node,
  notes,
  depth,
  path,
  filter,
  activeNoteId,
  onOpenNote,
  onSelectFolder,
  onCreateFolder,
  renameFolderId,
  onRenameFolderReady,
  onCreateNote,
  onRevealFolder,
  onDeleteFolder,
  onRenameFolder,
  onOpenCanvas,
  onCreateCanvas,
  canvasPath,
  canvasFiles,
  attachmentFiles,
  onOpenAttachment,
  onDownloadAttachment,
  onRevealAttachment,
  onCopyAttachmentPath,
  folderOptions,
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
  onOpenCanvasDefault,
  onRevealCanvas,
  onCopyCanvasPath,
  onCopyNotePath,
  onOpenDefault,
  onRevealNote,
  onRenameNote,
  onDeleteNote,
}: FolderNodeProps) {
  const treeDrag = useContext(TreeDragContext) ?? ({} as TreeDragState);
  const [expanded, setExpanded] = useState(depth < 2);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const [creatingChild, setCreatingChild] = useState(false);
  const renameCommitRef = useRef(false);
  const skipRenameBlurRef = useRef(false);
  const creatingChildRef = useRef(false);

  useEffect(() => {
    if (renameFolderId !== node.id) return;
    setDraftName(node.name);
    setRenaming(true);
    onRenameFolderReady?.(node.id);
  }, [node.id, node.name, onRenameFolderReady, renameFolderId]);

  useEffect(() => {
    if (!renaming) setDraftName(node.name);
  }, [node.name, renaming]);

  const isActive = filter.kind === 'folder' && filter.folderId === node.id;
  const hasChildren = node.children?.length > 0;
  const folderNotes = notes.filter((note) => note.folderId === node.id);
  const folderCanvasFiles = canvasFiles.filter((file) => file.folderPath === path);
  const folderAttachmentFiles = attachmentFiles.filter((file) => file.folderPath === path);
  const hasItems = hasChildren || folderNotes.length > 0 || folderCanvasFiles.length > 0 || folderAttachmentFiles.length > 0;
  const isFavorite = favoriteFolderIds.includes(node.id);
  const blockedMoveTargets = new Set([node.id, ...collectDescendantIds(node)]);

  const commitRename = async () => {
    if (skipRenameBlurRef.current) {
      skipRenameBlurRef.current = false;
      return;
    }
    if (renameCommitRef.current) return;
    renameCommitRef.current = true;

    try {
      const name = draftName.trim();
      if (name && name !== node.name) {
        const ok = await onRenameFolder(node.id, name);
        if (!ok) {
          setDraftName(node.name);
          return;
        }
      } else {
        setDraftName(node.name);
      }
      setRenaming(false);
    } finally {
      renameCommitRef.current = false;
    }
  };

  const cancelRename = () => {
    skipRenameBlurRef.current = true;
    setDraftName(node.name);
    setRenaming(false);
    window.setTimeout(() => {
      skipRenameBlurRef.current = false;
    }, 0);
  };

  const confirmDelete = () => {
    const extra = node.noteCount > 0 ? `其中的 ${node.noteCount} 篇笔记会回到「未分类」，不会被删除。` : '';
    if (window.confirm(`确定删除目录「${node.name}」及其子目录吗？${extra}`)) {
      onDeleteFolder(node.id);
    }
  };

  const createChild = async (kind: 'note' | 'folder'): Promise<void> => {
    if (creatingChildRef.current) return;
    creatingChildRef.current = true;
    setCreatingChild(true);
    try {
      if (kind === 'note') {
        await onCreateNote?.(node.id);
        return;
      }
      setExpanded(true);
      await onCreateFolder?.(nextFolderName(node.children), node.id);
    } finally {
      creatingChildRef.current = false;
      setCreatingChild(false);
    }
  };

  const moveItems: MenuItemDef[] = [
    {
      id: 'move-root',
      label: '根目录',
      icon: '⌂',
      disabled: node.parentId === null,
      onSelect: () => onMoveFolder?.(node.id, null),
    },
    ...folderOptions
      .filter((target) => !blockedMoveTargets.has(target.id))
      .map((target) => ({
        id: `move-${target.id}`,
        label: target.path,
        icon: '□',
        onSelect: () => onMoveFolder?.(node.id, target.id),
      })),
  ];

  const getMenuItems = (): MenuItemDef[] => [
    { id: 'new-note', label: '新建笔记', icon: '✎', disabled: creatingChild, onSelect: () => createChild('note') },
    { id: 'new-folder', label: '新建文件夹', icon: '▱', disabled: creatingChild, onSelect: () => createChild('folder') },
    { id: 'new-canvas', label: '新建白板', icon: '▦', onSelect: () => onCreateCanvas?.(path) },
    { separator: true },
    { id: 'duplicate', label: '创建副本', icon: '▣', onSelect: () => onDuplicateFolder?.(node) },
    { id: 'move', label: '将文件夹移动到…', icon: '↳', submenuItems: moveItems },
    { id: 'find', label: '在文件夹中查找', icon: '⌕', onSelect: () => onFindInFolder?.(node.id) },
    { id: 'favorite', label: isFavorite ? '取消收藏' : '收藏', icon: isFavorite ? '★' : '☆', onSelect: () => onToggleFavorite?.(node.id) },
    { separator: true },
    {
      id: 'copy-path',
      label: '复制路径',
      icon: '□',
      submenuItems: [
        { id: 'copy-relative', label: '复制相对路径', onSelect: () => onCopyFolderPath?.(path, 'relative') },
        { id: 'copy-absolute', label: '复制完整路径', onSelect: () => onCopyFolderPath?.(path, 'absolute') },
      ],
    },
    {
      id: 'reveal',
      label: '在系统资源管理器中显示',
      icon: '↗',
      onSelect: () => {
        if (window.latticeDesktop?.revealVaultPath) {
          onRevealFolder?.(path);
        } else {
          window.alert('当前是浏览器开发模式，请切换到格物 Lattice 桌面版后使用此功能。');
        }
      },
    },
    { separator: true },
    { id: 'rename', label: '重命名', icon: '✎', onSelect: () => setRenaming(true) },
    { id: 'delete', label: '删除', icon: '♧', danger: true, onSelect: confirmDelete },
  ];

  return (
    <li
      className={`tree__folder-node ${hasItems ? 'tree__folder-node--expandable' : ''}`}
      role="treeitem"
      aria-expanded={hasItems ? expanded : undefined}
      data-folder-depth={depth}
      data-folder-path={path}
    >
      {renaming ? (
        <form
          className="inline-form inline-form--inline"
          onSubmit={(event) => {
            event.preventDefault();
            commitRename();
          }}
        >
          <input
            autoFocus
            value={draftName}
            maxLength={120}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelRename();
              }
            }}
          />
        </form>
      ) : (
        <ContextMenu getItems={getMenuItems} label={`目录「${node.name}」操作`}>
          <div
            className={`nav-item ${hasItems ? 'nav-item--expandable' : ''} ${isActive ? 'is-active' : ''} ${treeDrag.draggingItem?.id === node.id ? 'is-dragging' : ''} ${treeDrag.dropTargetId === node.id ? 'is-drop-target' : ''}`}
            style={{ paddingLeft: 8 + depth * 18, '--tree-depth': depth } as CSSProperties}
            draggable
            aria-grabbed={treeDrag.draggingItem?.id === node.id}
            onDragStart={(event) => treeDrag.handleDragStart?.(event, { type: 'folder', id: node.id, parentId: node.parentId })}
            onDragEnd={treeDrag.handleDragEnd}
            onDragOver={(event) => treeDrag.handleDragOver?.(event, node.id)}
            onDrop={(event) => treeDrag.handleDrop?.(event, node.id)}
          >
          <button
            type="button"
            className={`tree__caret ${hasItems ? '' : 'is-hidden'}`}
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? '折叠' : '展开'}
            tabIndex={hasItems ? 0 : -1}
          >
            <span className={`chevron ${expanded ? 'is-open' : ''}`} aria-hidden="true">›</span>
          </button>

          <button
            type="button"
            className="nav-item__main"
            aria-label={`目录：${path}`}
            data-folder-path={path}
            onClick={() => onSelectFolder(node.id)}
          >
            <span className="tree__folder-icon" aria-hidden="true" />
            <span className="nav-item__label">{node.name}</span>
            {node.noteCount > 0 ? <span className="nav-item__badge">{node.noteCount}</span> : null}
            {isFavorite ? <span className="nav-item__favorite" title="已收藏" aria-label="已收藏">★</span> : null}
          </button>

          <span className="nav-item__tools">
            <button type="button" className="icon-btn" title="重命名" onClick={() => setRenaming(true)}>
              ✎
            </button>
            <button type="button" className="icon-btn icon-btn--danger" title="删除目录" onClick={confirmDelete}>
              ×
            </button>
          </span>
          </div>
        </ContextMenu>
      )}

      {hasItems && expanded ? (
        <ul role="group" style={{ '--tree-depth': depth + 1 } as CSSProperties}>
          {folderNotes.map((note) => (
            <NoteFile
              key={note.id}
              note={note}
              depth={depth + 1}
              activeNoteId={activeNoteId}
              folderOptions={folderOptions}
              onOpenNote={onOpenNote}
              onToggleNotePin={onToggleNotePin}
              onDuplicateNote={onDuplicateNote}
              onMoveNote={onMoveNote}
              onCopyNotePath={onCopyNotePath}
              onOpenDefault={onOpenDefault}
              onRevealNote={onRevealNote}
              onRenameNote={onRenameNote}
              onDeleteNote={onDeleteNote}
            />
          ))}
          {(node.children ?? []).map((child) => (
            <FolderNode
              key={child.id}
              node={child}
              notes={notes}
              depth={depth + 1}
              path={`${path}/${child.name}`}
              filter={filter}
              activeNoteId={activeNoteId}
              onOpenNote={onOpenNote}
              onSelectFolder={onSelectFolder}
              onCreateFolder={onCreateFolder}
              renameFolderId={renameFolderId}
              onRenameFolderReady={onRenameFolderReady}
              onCreateNote={onCreateNote}
              onRevealFolder={onRevealFolder}
              onDeleteFolder={onDeleteFolder}
              onRenameFolder={onRenameFolder}
              onOpenCanvas={onOpenCanvas}
              onCreateCanvas={onCreateCanvas}
              canvasPath={canvasPath}
              canvasFiles={canvasFiles}
              attachmentFiles={attachmentFiles}
              onOpenAttachment={onOpenAttachment}
              onDownloadAttachment={onDownloadAttachment}
              onRevealAttachment={onRevealAttachment}
              onCopyAttachmentPath={onCopyAttachmentPath}
              folderOptions={folderOptions}
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
              onOpenCanvasDefault={onOpenCanvasDefault}
              onRevealCanvas={onRevealCanvas}
              onCopyCanvasPath={onCopyCanvasPath}
              onCopyNotePath={onCopyNotePath}
              onOpenDefault={onOpenDefault}
              onRevealNote={onRevealNote}
              onRenameNote={onRenameNote}
              onDeleteNote={onDeleteNote}
            />
          ))}
          {folderAttachmentFiles.map((file) => (
            <AttachmentFile
              key={file.path}
              file={file}
              depth={depth + 1}
              folderOptions={folderOptions}
              onOpenAttachment={onOpenAttachment}
              onDownloadAttachment={onDownloadAttachment}
              onRevealAttachment={onRevealAttachment}
              onCopyAttachmentPath={onCopyAttachmentPath}
            />
          ))}
          {folderCanvasFiles.map((file) => (
            <CanvasFile
              key={file.path}
              file={file}
              depth={depth + 1}
              active={file.path === canvasPath}
              folderOptions={folderOptions}
              onOpenCanvas={onOpenCanvas}
              onCreateNote={onCreateNote}
              onMoveCanvas={onMoveCanvas}
              onRenameCanvas={onRenameCanvas}
              onDeleteCanvas={onDeleteCanvas}
              onCopyCanvasPath={onCopyCanvasPath}
              onOpenCanvasDefault={onOpenCanvasDefault}
              onRevealCanvas={onRevealCanvas}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function NoteFile({
  note,
  depth,
  activeNoteId,
  folderOptions,
  onOpenNote,
  onToggleNotePin,
  onDuplicateNote,
  onMoveNote,
  onCopyNotePath,
  onOpenDefault,
  onRevealNote,
  onRenameNote,
  onDeleteNote,
}: NoteFileProps) {
  const treeDrag = useContext(TreeDragContext) ?? ({} as TreeDragState);
  return (
    <li role="treeitem">
      <ContextMenu
        className="tree__note-context"
        label={`文件「${note.title}」操作`}
        getItems={() => buildNoteMenu(note, {
          folderOptions,
          onOpenNote,
          onToggleNotePin,
          onDuplicateNote,
          onMoveNote,
          onCopyNotePath,
          onOpenDefault,
          onRevealNote,
          onRenameNote,
          onDeleteNote,
        })}
      >
        <button
          type="button"
          className={`tree__note ${note.id === activeNoteId ? 'is-active' : ''} ${treeDrag.draggingItem?.id === note.id ? 'is-dragging' : ''}`}
          style={{ paddingLeft: 8 + depth * 18, '--tree-depth': depth } as CSSProperties}
          draggable
          aria-grabbed={treeDrag.draggingItem?.id === note.id}
          onDragStart={(event) => treeDrag.handleDragStart?.(event, { type: 'note', id: note.id, folderId: note.folderId ?? null })}
          onDragEnd={treeDrag.handleDragEnd}
          onClick={() => onOpenNote?.(note.id)}
          aria-label={`笔记：${note.title}`}
        >
          <span className="tree__note-icon" aria-hidden="true">·</span>
          <span className="nav-item__label">{note.title}</span>
          <span className={`tree__file-type tree__file-type--${fileTypeClass(note.filePath)}`} title={fileTypeLabel(note.filePath)}>
            {fileTypeLabel(note.filePath)}
          </span>
        </button>
      </ContextMenu>
    </li>
  );
}

function CanvasFile({ file, depth, active, folderOptions, onOpenCanvas, onCreateNote, onMoveCanvas, onRenameCanvas, onDeleteCanvas, onCopyCanvasPath, onOpenCanvasDefault, onRevealCanvas }: CanvasFileProps) {
  const treeDrag = useContext(TreeDragContext) ?? ({} as TreeDragState);
  const name = file.name ?? file.path.split('/').pop() ?? file.path;
  const displayName = canvasDisplayName(name);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(displayName);
  const renameCommitRef = useRef(false);
  const skipRenameBlurRef = useRef(false);

  useEffect(() => {
    if (!renaming) setDraftName(displayName);
  }, [displayName, renaming]);

  const commitRename = async () => {
    if (skipRenameBlurRef.current) {
      skipRenameBlurRef.current = false;
      return;
    }
    if (renameCommitRef.current) return;
    renameCommitRef.current = true;

    try {
      const nextName = toCanvasFileName(draftName);
      if (!nextName) {
        setDraftName(displayName);
        return;
      }
      if (nextName !== file.path.split('/').pop()) {
        const ok = await onRenameCanvas?.(file.path, nextName);
        if (ok === false) return;
      }
      setRenaming(false);
    } finally {
      renameCommitRef.current = false;
    }
  };

  const cancelRename = () => {
    skipRenameBlurRef.current = true;
    setDraftName(displayName);
    setRenaming(false);
    window.setTimeout(() => {
      skipRenameBlurRef.current = false;
    }, 0);
  };

  const startRename = () => {
    if (file.exists === false) return;
    setDraftName(displayName);
    setRenaming(true);
  };

  if (renaming) {
    return (
      <li role="treeitem">
        <form
          className="inline-form inline-form--inline canvas-file-rename"
          style={{ paddingLeft: 8 + depth * 18, '--tree-depth': depth } as CSSProperties}
          onSubmit={(event) => {
            event.preventDefault();
            commitRename();
          }}
        >
          <input
            autoFocus
            value={draftName}
            maxLength={120}
            aria-label={`重命名画布 ${displayName}`}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelRename();
              }
            }}
          />
        </form>
      </li>
    );
  }

  const moveItems = [
    {
      id: 'move-canvas-root',
      label: '根目录',
      icon: '⌂',
      disabled: !file.folderPath,
      onSelect: () => onMoveCanvas?.(file.path, ''),
    },
    ...folderOptions.map((target) => ({
      id: `move-canvas-${target.id}`,
      label: target.path,
      icon: '□',
      disabled: target.path === file.folderPath,
      onSelect: () => onMoveCanvas?.(file.path, target.path),
    })),
  ];
  const folderId = folderOptions.find((folder) => folder.path === file.folderPath)?.id ?? null;

  return (
    <li role="treeitem">
      <ContextMenu
        className="tree__note-context"
        label={`文件「${name}」操作`}
        getItems={() => [
          { id: 'open-canvas', label: '打开画布', icon: '↗', onSelect: () => onOpenCanvas?.(file.path) },
          { id: 'new-note', label: '新建笔记', icon: '✎', onSelect: () => onCreateNote?.(folderId) },
          { id: 'rename-canvas', label: '重命名', icon: '✎', disabled: file.exists === false, onSelect: startRename },
          { id: 'move-canvas', label: '将文件移动到…', icon: '↳', disabled: file.exists === false, submenuItems: moveItems },
          {
            id: 'copy-canvas-path',
            label: '复制路径',
            icon: '□',
            submenuItems: [
              { id: 'copy-canvas-relative', label: '复制相对路径', onSelect: () => onCopyCanvasPath?.(file.path, 'relative') },
              { id: 'copy-canvas-absolute', label: '复制完整路径', onSelect: () => onCopyCanvasPath?.(file.path, 'absolute') },
              ],
            },
          { id: 'open-canvas-default', label: '使用系统默认应用打开', icon: '↗', disabled: file.exists === false, onSelect: () => onOpenCanvasDefault?.(file.path) },
          { id: 'reveal-canvas', label: '在系统资源管理器中显示', icon: '↗', disabled: file.exists === false, onSelect: () => onRevealCanvas?.(file.path) },
          { separator: true },
          {
            id: 'delete-canvas',
            label: '删除画布',
            icon: '×',
            danger: true,
            disabled: file.exists === false,
            onSelect: () => {
              if (window.confirm(`确定删除画布「${displayName}」吗？此操作不可撤销。`)) onDeleteCanvas?.(file.path);
            },
          },
        ]}
      >
        <button
          type="button"
          className={`tree__note tree__canvas-file ${active ? 'is-active' : ''} ${treeDrag.draggingItem?.path === file.path ? 'is-dragging' : ''}`}
          style={{ paddingLeft: 8 + depth * 18, '--tree-depth': depth } as CSSProperties}
          draggable={file.exists !== false}
          aria-grabbed={treeDrag.draggingItem?.path === file.path}
          onDragStart={(event) => treeDrag.handleDragStart?.(event, { type: 'canvas', path: file.path, folderPath: file.folderPath ?? '' })}
          onDragEnd={treeDrag.handleDragEnd}
          onClick={() => onOpenCanvas?.(file.path)}
          aria-label={`画布：${file.path}`}
        >
          <span className="tree__note-icon tree__canvas-file-icon" aria-hidden="true">▦</span>
          <span className="nav-item__label">{displayName}</span>
          <span className="tree__file-type tree__file-type--canvas">CANVAS</span>
        </button>
      </ContextMenu>
    </li>
  );
}

function AttachmentFile({ file, depth, folderOptions, onOpenAttachment, onDownloadAttachment, onRevealAttachment, onCopyAttachmentPath }: AttachmentFileProps) {
  const name = file.name ?? file.path.split('/').pop() ?? file.path;
  return (
    <li role="treeitem">
      <ContextMenu
        className="tree__note-context"
        label={`附件「${name}」操作`}
        getItems={() => [
          { id: 'open-attachment', label: '使用默认应用打开', icon: '↗', onSelect: () => onOpenAttachment?.(file.path) },
          { id: 'download-attachment', label: '下载文件', icon: '↓', onSelect: () => onDownloadAttachment?.(file.path) },
          {
            id: 'copy-attachment-path',
            label: '复制路径',
            icon: '□',
            submenuItems: [
              { id: 'copy-attachment-relative', label: '复制相对路径', onSelect: () => onCopyAttachmentPath?.(file.path, 'relative') },
              { id: 'copy-attachment-absolute', label: '复制完整路径', onSelect: () => onCopyAttachmentPath?.(file.path, 'absolute') },
            ],
          },
          { id: 'reveal-attachment', label: '在系统资源管理器中显示', icon: '↗', onSelect: () => onRevealAttachment?.(file.path) },
        ]}
      >
        <button
          type="button"
          className="tree__note tree__attachment-file"
          style={{ paddingLeft: 8 + depth * 18, '--tree-depth': depth } as CSSProperties}
          onClick={() => onOpenAttachment?.(file.path)}
          aria-label={`附件：${file.path}`}
        >
          <span className="tree__note-icon" aria-hidden="true">▪</span>
          <span className="nav-item__label">{name}</span>
          <span className={`tree__file-type tree__file-type--${fileTypeClass(name)}`} title={fileTypeLabel(name)}>
            {fileTypeLabel(name)}
          </span>
        </button>
      </ContextMenu>
    </li>
  );
}

function fileTypeLabel(filePath: string | null | undefined): string {
  const extension = String(filePath ?? '').split('.').pop()?.trim().toLowerCase();
  if (!extension) return 'MD';
  if (extension === 'canvas') return 'CANVAS';
  if (extension === 'markdown' || extension === 'md') return 'MD';
  return extension.slice(0, 6).toUpperCase();
}

function fileTypeClass(filePath: string | null | undefined): string {
  return fileTypeLabel(filePath).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'file';
}

function buildNoteMenu(note: NoteIndexRow, {
  folderOptions,
  onOpenNote,
  onToggleNotePin,
  onDuplicateNote,
  onMoveNote,
  onCopyNotePath,
  onOpenDefault,
  onRevealNote,
  onRenameNote,
  onDeleteNote,
}: NoteMenuHandlers): MenuItemDef[] {
  const moveItems: MenuItemDef[] = [
    {
      id: 'move-unfiled',
      label: '未分类',
      disabled: note.folderId == null,
      onSelect: () => onMoveNote?.(note.id, null),
    },
    ...folderOptions.map((folder) => ({
      id: `move-${folder.id}`,
      label: folder.path,
      disabled: note.folderId === folder.id,
      onSelect: () => onMoveNote?.(note.id, folder.id),
    })),
  ];

  return [
    { id: 'open-tab', label: '在新标签页中打开', icon: '↗', onSelect: () => onOpenNote?.(note.id) },
    { id: 'open-tab-group', label: '在新标签组中打开', icon: '◫', disabled: true, title: '标签组功能暂未支持' },
    { id: 'open-window', label: '在新窗口中打开', icon: '□', disabled: true, title: '多窗口工作区暂未支持' },
    { separator: true },
    { id: 'duplicate', label: '创建副本', icon: '▣', onSelect: () => onDuplicateNote?.(note) },
    { id: 'move', label: '将文件移动到…', icon: '↳', submenuItems: moveItems },
    { id: 'favorite', label: note.isPinned ? '取消收藏' : '收藏', icon: note.isPinned ? '★' : '☆', onSelect: () => onToggleNotePin?.(note) },
    { separator: true },
    {
      id: 'copy-path',
      label: '复制路径',
      icon: '□',
      submenuItems: [
        { id: 'copy-relative', label: '复制相对路径', onSelect: () => onCopyNotePath?.(note, 'relative') },
        { id: 'copy-absolute', label: '复制完整路径', onSelect: () => onCopyNotePath?.(note, 'absolute') },
      ],
    },
    { id: 'history', label: '打开版本历史', icon: '◷', disabled: true, title: '版本历史暂未支持' },
    { separator: true },
    { id: 'default-app', label: '使用默认应用打开', icon: '↗', onSelect: () => onOpenDefault?.(note) },
    { id: 'reveal', label: '在系统资源管理器中显示', icon: '↗', onSelect: () => onRevealNote?.(note) },
    { separator: true },
    { id: 'rename', label: '重命名', icon: '✎', onSelect: () => onRenameNote?.(note) },
    {
      id: 'delete',
      label: '删除',
      icon: '♧',
      danger: true,
      onSelect: () => {
        if (window.confirm(`确定删除文件「${note.title}」吗？此操作不可撤销。`)) onDeleteNote?.(note.id);
      },
    },
  ];
}

function flattenFolderNodes(nodes: FolderNode[] | null | undefined, parentPath = '', result: FolderOption[] = []): FolderOption[] {
  for (const node of nodes ?? []) {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    result.push({ id: node.id, path });
    flattenFolderNodes(node.children, path, result);
  }
  return result;
}

function collectDescendantIds(node: FolderNode, result: string[] = []): string[] {
  for (const child of node.children ?? []) {
    result.push(child.id);
    collectDescendantIds(child, result);
  }
  return result;
}
