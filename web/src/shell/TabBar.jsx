import ContextMenu from '../ui/ContextMenu.jsx';

export default function TabBar({
  tabs,
  activeTabId,
  noteTitles,
  externalNotes = new Map(),
  noteIndex = [],
  folders = [],
  activeNote,
  lockedTabIds = [],
  onSelect,
  onClose,
  onCloseToLeft,
  onCloseToRight,
  onCloseOthers,
  onNew,
  onToggleLock,
  onTogglePin,
  onRename,
  onMoveNote,
  onCopyPath,
  onCopyWikiLink,
  onOpenDefault,
  onRevealFile,
  onShowInFileList,
  onDeleteNote,
  onOpenLinkedNote,
}) {
  const folderItems = flattenFolders(folders);

  return (
    <div className="tabbar" role="tablist" aria-label="已打开笔记">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const tabIndex = tabs.findIndex((item) => item.id === tab.id);
        const externalNote = tab.externalToken ? externalNotes.get(tab.externalToken) : null;
        const title = tab.externalToken
          ? (externalNote?.title ?? '加载中…')
          : tab.noteId ? (noteTitles.get(tab.noteId) ?? '加载中…') : '新标签页';
        const locked = lockedTabIds.includes(tab.id);
        const hasClosableLeft = tabs
          .slice(0, tabIndex)
          .some((item) => !lockedTabIds.includes(item.id));
        const hasClosableRight = tabs
          .slice(tabIndex + 1)
          .some((item) => !lockedTabIds.includes(item.id));
        const hasClosableOthers = tabs
          .some((item) => item.id !== tab.id && !lockedTabIds.includes(item.id));
        const note = tab.externalToken
          ? externalNote
          : tab.noteId
          ? (activeNote?.id === tab.noteId ? activeNote : noteIndex.find((item) => item.id === tab.noteId))
          : null;
        return (
          <ContextMenu
            key={tab.id}
            className="tabbar__context-target"
            label={`标签页「${title}」操作`}
            getItems={() => buildTabMenu({
              tab,
              title,
              note,
              isExternal: Boolean(tab.externalToken),
              active,
              locked,
              hasClosableLeft,
              hasClosableRight,
              hasClosableOthers,
              folderItems,
              activeNote,
              onCloseTab: onClose,
              onCloseToLeft,
              onCloseToRight,
              onCloseOthers,
              onToggleLock,
              onTogglePin,
              onRename,
              onMoveNote,
              onCopyPath,
              onCopyWikiLink,
              onOpenDefault,
              onRevealFile,
              onShowInFileList,
              onDeleteNote,
              onOpenLinkedNote,
            })}
          >
            <div
              className={`tabbar__tab ${active ? 'is-active' : ''} ${locked ? 'is-locked' : ''}`.trim()}
              role="tab"
              aria-selected={active}
              aria-label={locked ? `${title}（已锁定）` : title}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab.id);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(tab.id);
                }
              }}
            >
              {locked ? <span className="tabbar__lock" aria-label="已锁定">⌑</span> : null}
              <span className="tabbar__title">{title}</span>
              <button
                type="button"
                className="tabbar__close"
                aria-label={`关闭「${title}」`}
                title={locked ? '标签页已锁定' : `关闭「${title}」`}
                disabled={locked}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          </ContextMenu>
        );
      })}
      <button type="button" className="tabbar__new" onClick={onNew} aria-label="新标签页（Ctrl / Cmd + T）" title="新标签页（Ctrl / Cmd + T）">
        ＋
      </button>
    </div>
  );
}

function buildTabMenu({
  tab,
  title,
  note,
  isExternal,
  active,
  locked,
  hasClosableLeft,
  hasClosableRight,
  hasClosableOthers,
  folderItems,
  activeNote,
  onCloseTab,
  onCloseToLeft,
  onCloseToRight,
  onCloseOthers,
  onToggleLock,
  onTogglePin,
  onRename,
  onMoveNote,
  onCopyPath,
  onCopyWikiLink,
  onOpenDefault,
  onRevealFile,
  onShowInFileList,
  onDeleteNote,
  onOpenLinkedNote,
}) {
  const hasNote = Boolean(note?.id);
  const hasVaultNote = hasNote && !isExternal;
  const outgoing = active && note?.id && activeNote?.id === note.id ? (activeNote.outgoing ?? []) : [];
  const moveItems = [
    {
      id: 'move-root',
      label: '根目录（未分类）',
      disabled: !hasVaultNote || note.folderId == null,
      onSelect: () => onMoveNote?.(tab.id, null),
    },
    ...folderItems.map((folder) => ({
      id: `move-${folder.id}`,
      label: `${'　'.repeat(folder.depth)}${folder.name}`,
      disabled: !hasVaultNote || note.folderId === folder.id,
      onSelect: () => onMoveNote?.(tab.id, folder.id),
    })),
  ];
  const linkItems = outgoing.length
    ? outgoing.map((link, index) => ({
        id: `link-${link.targetNoteId ?? index}`,
        label: link.resolved ? link.resolvedTitle ?? link.targetTitle : `${link.targetTitle}（未找到）`,
        disabled: !link.targetNoteId,
        onSelect: () => onOpenLinkedNote?.(link.targetNoteId),
      }))
    : [{ id: 'no-links', label: '没有出链', disabled: true }];

  return [
    { id: 'close', label: '关闭', icon: '×', disabled: locked, onSelect: () => onCloseTab?.(tab.id) },
    { id: 'close-left', label: '关闭左侧', icon: '←', disabled: !hasClosableLeft, onSelect: () => onCloseToLeft?.(tab.id) },
    { id: 'close-right', label: '关闭右侧', icon: '→', disabled: !hasClosableRight, onSelect: () => onCloseToRight?.(tab.id) },
    { id: 'close-others', label: '关闭其他', icon: '×', disabled: !hasClosableOthers, onSelect: () => onCloseOthers?.(tab.id) },
    { id: 'lock', label: locked ? '解锁' : '锁定', icon: locked ? '⌑' : '▣', onSelect: () => onToggleLock?.(tab.id) },
    { id: 'linked-tabs', label: '关联标签页…', icon: '⌘', disabled: true, title: '关联标签页暂未支持' },
    { separator: true },
    { id: 'new-window', label: '移动至新窗口', icon: '↗', disabled: true, title: '多窗口工作区暂未支持' },
    { id: 'split-horizontal', label: '左右分屏', icon: '◫', disabled: true, title: '分屏工作区暂未支持' },
    { id: 'split-vertical', label: '上下分屏', icon: '⬍', disabled: true, title: '分屏工作区暂未支持' },
    { id: 'open-window', label: '在新窗口中打开', icon: '□', disabled: true, title: '多窗口工作区暂未支持' },
    { separator: true },
    { id: 'rename', label: '重命名', icon: '✎', disabled: !hasVaultNote, onSelect: () => onRename?.(tab.id) },
    { id: 'move', label: '将文件移动到…', icon: '↳', submenuItems: moveItems },
    { id: 'pin', label: note?.isPinned ? '取消收藏' : '收藏', icon: '★', disabled: !hasVaultNote, onSelect: () => onTogglePin?.(note) },
    { id: 'export-image', label: '导出图片', icon: '▧', disabled: true, title: '图片导出暂未支持' },
    { separator: true },
    {
      id: 'copy-path',
      label: '复制路径',
      icon: '⌁',
      submenuItems: [
        { id: 'copy-relative', label: '相对路径', disabled: !hasVaultNote, onSelect: () => onCopyPath?.(note, 'relative') },
        { id: 'copy-absolute', label: '完整路径', disabled: !hasVaultNote, onSelect: () => onCopyPath?.(note, 'absolute') },
        { id: 'copy-link', label: '复制双链', disabled: !hasVaultNote, onSelect: () => onCopyWikiLink?.(note) },
      ],
    },
    { id: 'history', label: '打开版本历史', icon: '◷', disabled: true, title: '版本历史暂未支持' },
    { id: 'open-links', label: '打开当前笔记的…', icon: '↗', submenuItems: linkItems },
    { separator: true },
    { id: 'default-app', label: '使用默认应用打开', icon: '↗', disabled: !hasVaultNote, onSelect: () => onOpenDefault?.(note) },
    { id: 'reveal', label: '在系统资源管理器中显示', icon: '⌂', disabled: !hasVaultNote, onSelect: () => onRevealFile?.(note) },
    { id: 'show-in-list', label: '在文件列表中显示当前文件', icon: '☷', disabled: !hasVaultNote, onSelect: () => onShowInFileList?.(note) },
    { separator: true },
    {
      id: 'delete',
      label: '删除文件',
      icon: '⌫',
      danger: true,
      disabled: !hasVaultNote,
      onSelect: () => {
        if (window.confirm(`确定删除文件「${title}」吗？`)) onDeleteNote?.(note.id);
      },
    },
  ];
}

function flattenFolders(nodes, depth = 0, result = []) {
  for (const folder of nodes ?? []) {
    result.push({ id: folder.id, name: folder.name, depth });
    flattenFolders(folder.children, depth + 1, result);
  }
  return result;
}
