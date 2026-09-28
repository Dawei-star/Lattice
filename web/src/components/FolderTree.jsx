import { useState } from 'react';
import ContextMenu from '../ui/ContextMenu.jsx';

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
  onCreateNote,
  onRevealFolder,
  onDeleteFolder,
  onRenameFolder,
  onOpenCanvas,
  onCreateCanvas,
  canvasPath = '画板.canvas',
  canvasFiles = [],
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
  const folderOptions = flattenFolderNodes(nodes);

  return (
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
          onCreateNote={onCreateNote}
          onRevealFolder={onRevealFolder}
          onDeleteFolder={onDeleteFolder}
          onRenameFolder={onRenameFolder}
          onOpenCanvas={onOpenCanvas}
          onCreateCanvas={onCreateCanvas}
          canvasPath={canvasPath}
          canvasFiles={canvasFiles}
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
          onMoveCanvas={onMoveCanvas}
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
    </ul>
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
  onCreateNote,
  onRevealFolder,
  onDeleteFolder,
  onRenameFolder,
  onOpenCanvas,
  onCreateCanvas,
  canvasPath,
  canvasFiles,
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
  onCopyNotePath,
  onOpenDefault,
  onRevealNote,
  onRenameNote,
  onDeleteNote,
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);

  const isActive = filter.kind === 'folder' && filter.folderId === node.id;
  const hasChildren = node.children?.length > 0;
  const folderNotes = notes.filter((note) => note.folderId === node.id);
  const folderCanvasFiles = canvasFiles.filter((file) => file.folderPath === path);
  const hasItems = hasChildren || folderNotes.length > 0 || folderCanvasFiles.length > 0;
  const isFavorite = favoriteFolderIds.includes(node.id);
  const blockedMoveTargets = new Set([node.id, ...collectDescendantIds(node)]);

  const commitRename = async () => {
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
  };

  const confirmDelete = () => {
    const extra = node.noteCount > 0 ? `其中的 ${node.noteCount} 篇笔记会回到「未分类」，不会被删除。` : '';
    if (window.confirm(`确定删除目录「${node.name}」及其子目录吗？${extra}`)) {
      onDeleteFolder(node.id);
    }
  };

  const createChild = (kind) => {
    if (kind === 'note') {
      onCreateNote?.(node.id);
      return;
    }
    const name = window.prompt('子文件夹名称');
    if (name?.trim()) {
      setExpanded(true);
      onCreateFolder?.(name.trim(), node.id);
    }
  };

  const moveItems = [
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

  const getMenuItems = () => [
    { id: 'new-note', label: '新建笔记', icon: '✎', onSelect: () => createChild('note') },
    { id: 'new-folder', label: '新建文件夹', icon: '▱', onSelect: () => createChild('folder') },
    { id: 'new-canvas', label: '新建白板', icon: '▦', onSelect: () => onCreateCanvas?.(path) },
    { id: 'new-database', label: '新建数据库', icon: '☷', disabled: true, title: '数据库功能尚未支持' },
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
    <li role="treeitem" aria-expanded={hasItems ? expanded : undefined} data-folder-depth={depth} data-folder-path={path}>
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
                setDraftName(node.name);
                setRenaming(false);
              }
            }}
          />
        </form>
      ) : (
        <ContextMenu getItems={getMenuItems} label={`目录「${node.name}」操作`}>
          <div className={`nav-item ${isActive ? 'is-active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
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
            title={path}
            data-folder-path={path}
            onClick={() => onSelectFolder(node.id)}
          >
            <span className="tree__folder-icon" aria-hidden="true" />
            <span className="nav-item__label" title={path}>{node.name}</span>
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
        <ul role="group">
          {folderNotes.map((note) => (
            <li key={note.id} role="treeitem">
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
                className={`tree__note ${note.id === activeNoteId ? 'is-active' : ''}`}
                style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                onClick={() => onOpenNote?.(note.id)}
                title={note.title}
              >
                <span className="tree__note-icon" aria-hidden="true">·</span>
                <span className="nav-item__label">{note.title}</span>
                <span className={`tree__file-type tree__file-type--${fileTypeClass(note.filePath)}`} title={fileTypeLabel(note.filePath)}>
                  {fileTypeLabel(note.filePath)}
                </span>
              </button>
              </ContextMenu>
            </li>
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
              onCreateNote={onCreateNote}
              onRevealFolder={onRevealFolder}
              onDeleteFolder={onDeleteFolder}
              onRenameFolder={onRenameFolder}
              onOpenCanvas={onOpenCanvas}
              onCreateCanvas={onCreateCanvas}
              canvasPath={canvasPath}
              canvasFiles={canvasFiles}
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
              onCopyNotePath={onCopyNotePath}
              onOpenDefault={onOpenDefault}
              onRevealNote={onRevealNote}
              onRenameNote={onRenameNote}
              onDeleteNote={onDeleteNote}
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
              onMoveCanvas={onMoveCanvas}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CanvasFile({ file, depth, active, folderOptions, onOpenCanvas, onMoveCanvas }) {
  const name = file.name ?? file.path.split('/').pop() ?? file.path;
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

  return (
    <li role="treeitem">
      <ContextMenu
        className="tree__note-context"
        label={`文件「${name}」操作`}
        getItems={() => [
          { id: 'open-canvas', label: '打开画布', icon: '↗', onSelect: () => onOpenCanvas?.(file.path) },
          { id: 'move-canvas', label: '将文件移动到…', icon: '↳', disabled: file.exists === false, submenuItems: moveItems },
          {
            id: 'copy-canvas-path',
            label: '复制路径',
            icon: '□',
            onSelect: () => navigator.clipboard?.writeText(file.path),
          },
        ]}
      >
        <button
          type="button"
          className={`tree__note tree__canvas-file ${active ? 'is-active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onOpenCanvas?.(file.path)}
          title={file.path}
        >
          <span className="tree__note-icon tree__canvas-file-icon" aria-hidden="true">▦</span>
          <span className="nav-item__label" title={file.path}>{name.replace(/\.canvas$/i, '')}</span>
          <span className="tree__file-type tree__file-type--canvas">CANVAS</span>
        </button>
      </ContextMenu>
    </li>
  );
}

function fileTypeLabel(filePath) {
  const extension = String(filePath ?? '').split('.').pop()?.trim().toLowerCase();
  if (!extension) return 'MD';
  if (extension === 'canvas') return 'CANVAS';
  if (extension === 'markdown' || extension === 'md') return 'MD';
  return extension.slice(0, 6).toUpperCase();
}

function fileTypeClass(filePath) {
  return fileTypeLabel(filePath).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'file';
}

function buildNoteMenu(note, {
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
}) {
  const moveItems = [
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

function flattenFolderNodes(nodes, parentPath = '', result = []) {
  for (const node of nodes ?? []) {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    result.push({ id: node.id, path });
    flattenFolderNodes(node.children, path, result);
  }
  return result;
}

function collectDescendantIds(node, result = []) {
  for (const child of node.children ?? []) {
    result.push(child.id);
    collectDescendantIds(child, result);
  }
  return result;
}
