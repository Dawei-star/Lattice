import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notesApi } from './api/resources.js';
import EditorPane from './components/EditorPane.jsx';
import GraphView from './components/GraphView.jsx';
import CanvasView from './components/CanvasView.jsx';
import AIAssistantPanel from './components/AIAssistantPanel.jsx';
import LinkPanel from './components/LinkPanel.jsx';
import NoteListPane from './components/NoteListPane.jsx';
import QuickSwitcher from './components/QuickSwitcher.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import { useToast } from './hooks/useToast.jsx';
import { useVault } from './hooks/useVault.js';
import Ribbon from './shell/Ribbon.jsx';
import TabBar from './shell/TabBar.jsx';
import StatusBar from './shell/StatusBar.jsx';
import SettingsModal from './settings/SettingsModal.jsx';
import Modal from './ui/Modal.jsx';
import { loadImportedTheme } from './lib/theme.js';
import { noteFilePath } from './api/vault-files.js';
import { applySettings, loadSettings, subscribeSettings } from './settings/settings.js';

const THEME_STORAGE_KEY = 'lattice-theme';
const FAVORITE_FOLDERS_STORAGE_KEY = 'lattice-favorite-folders';

const revealFolder = (relativePath) => window.latticeDesktop?.revealVaultPath?.(relativePath);

export default function App() {
  const toast = useToast();
  const vault = useVault();

  // 从 vault 里解构出动作：它们都是稳定的 useCallback，
  // 直接依赖 vault 对象本身会导致下方所有依赖它的 hook 每次渲染都失效
  const {
    folders,
    tags,
    overview,
    notes,
    notesTotal,
    page,
    pageCount,
    noteIndex,
    canvasFiles,
    activeNote,
    graph,
    graphStale,
    search,
    filter,
    sort,
    query,
    loading,
    connectionDown,
    setQuery,
    setSort,
    setPage,
    selectFolder,
    selectTag,
    clearFilter,
    openNote,
    createNote,
    saveNote,
    deleteNote,
    createFolder,
    renameFolder,
    deleteFolder,
    moveNote,
    moveCanvas,
    createCanvas,
    togglePin,
    duplicateNote,
    renameNote,
    duplicateFolder,
    moveFolder,
    resolveTitle,
    refreshNotes,
    refreshSidebar,
    refreshGraph,
    registerNavigationGuard,
    confirmNavigation,
  } = vault;

  const [view, setView] = useState('notes');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  const [settings, setSettings] = useState(() => loadSettings());
  const [favoriteFolderIds, setFavoriteFolderIds] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FAVORITE_FOLDERS_STORAGE_KEY) ?? '[]');
      return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  });
  const [shellMode] = useState(() => new URLSearchParams(window.location.search).get('shell') === 'topbar' ? 'topbar' : 'obsidian');
  const [canvasPath, setCanvasPath] = useState('画板.canvas');

  const handleViewChange = useCallback((nextView) => {
    setView(nextView);
    setSidebarOpen(true);
  }, []);

  const handleOpenCanvas = useCallback((nextPath = '画板.canvas') => {
    setCanvasPath(nextPath);
    handleViewChange('canvas');
  }, [handleViewChange]);

  const handleCreateCanvas = useCallback(async (folderPath = '') => {
    const createdPath = await createCanvas(folderPath);
    if (!createdPath) return null;
    setCanvasPath(createdPath);
    handleViewChange('canvas');
    const name = createdPath.split('/').pop()?.replace(/\.canvas$/i, '') ?? createdPath;
    toast.success(`已创建白板「${name}」`);
    return createdPath;
  }, [createCanvas, handleViewChange, toast]);

  // ── 多标签页：tabs 记录打开了哪些笔记，vault.activeNote 即当前标签的内容 ──
  const [tabs, setTabs] = useState(() => [{ id: 1, noteId: null }]);
  const [activeTabId, setActiveTabId] = useState(1);
  const [lockedTabIds, setLockedTabIds] = useState([]);
  const [renameDialog, setRenameDialog] = useState(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const tabSeq = useRef(2);

  const noteTitles = useMemo(() => new Map((noteIndex ?? []).map((n) => [n.id, n.title])), [noteIndex]);

  useEffect(() => {
    loadImportedTheme();
    applySettings(loadSettings());
    return subscribeSettings(setSettings);
  }, []);

  // ── 主题 ────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // 隐私模式下 localStorage 可能不可写，静默忽略
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITE_FOLDERS_STORAGE_KEY, JSON.stringify(favoriteFolderIds));
    } catch {
      // 隐私模式下 localStorage 可能不可写，收藏仍在当前会话有效
    }
  }, [favoriteFolderIds]);

  // ── 派生数据 ────────────────────────────────────────────────
  const folderLookup = useMemo(() => {
    const map = new Map();
    const walk = (nodes) => {
      for (const node of nodes ?? []) {
        map.set(node.id, node.name);
        walk(node.children);
      }
    };
    walk(folders);
    return map;
  }, [folders]);

  const tagLookup = useMemo(() => new Map((tags ?? []).map((tag) => [tag.id, tag.name])), [tags]);

  /** 新建笔记时默认落进当前正在浏览的目录 */
  const targetFolderId = filter.kind === 'folder' ? filter.folderId : null;

  const handleMoveCanvas = useCallback(async (fromPath, targetFolderPath = '') => {
    const fileName = fromPath.split('/').pop();
    const toPath = targetFolderPath ? `${targetFolderPath}/${fileName}` : fileName;
    if (!fileName || toPath === fromPath) return false;
    const moved = await moveCanvas(fromPath, toPath);
    if (!moved) return false;
    if (canvasPath === fromPath) setCanvasPath(toPath);
    toast.success('画布文件已移动');
    return true;
  }, [canvasPath, moveCanvas, toast]);

  // ── 嵌入内容缓存 ────────────────────────────────────────────
  // 键为「笔记 id + updatedAt」：笔记改动后索引里的 updatedAt 会变，
  // 旧缓存自然失效，不需要手工清理。
  const embedCache = useRef(new Map());

  const resolveEmbed = useCallback(
    async (title) => {
      const hit = resolveTitle(title);
      if (!hit) return null;

      const cacheKey = `${hit.id}@${hit.updatedAt}`;
      if (embedCache.current.has(cacheKey)) return embedCache.current.get(cacheKey);

      const note = await notesApi.get(hit.id);
      const content = note?.content ?? '';
      embedCache.current.set(cacheKey, content);
      return content;
    },
    [resolveTitle],
  );

  // ── 导航（切换前先过一遍未保存内容的守卫） ─────────────────
  const activateTab = useCallback(
    (tab) => {
      setActiveTabId(tab.id);
      if (!tab.noteId) vault.setActiveNote(null);
      else if (tab.noteId !== activeNote?.id) openNote(tab.noteId);
    },
    [activeNote?.id, openNote, vault],
  );

  /** 打开笔记：已有标签直接激活，否则新开一个标签 */
  const openInTab = useCallback(
    async (id) => {
      if (!id || !confirmNavigation()) return null;
      const existing = tabs.find((t) => t.noteId === id);
      if (existing) {
        if (existing.id !== activeTabId) activateTab(existing);
        return existing;
      }
      const tab = { id: tabSeq.current++, noteId: id };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
      if (activeNote?.id !== id) return openNote(id);
      return tab;
    },
    [tabs, activeTabId, activeNote?.id, confirmNavigation, openNote, activateTab],
  );

  const handleOpenNote = useCallback(
    async (id) => {
      const opened = await openInTab(id);
      if (opened) setView('notes');
      return opened;
    },
    [openInTab],
  );

  const handleTabSelect = useCallback(
    (tabId) => {
      if (tabId === activeTabId || !confirmNavigation()) return;
      const tab = tabs.find((t) => t.id === tabId);
      if (tab) activateTab(tab);
    },
    [tabs, activeTabId, confirmNavigation, activateTab],
  );

  const handleTabNew = useCallback(() => {
    const active = tabs.find((t) => t.id === activeTabId);
    if (active && !active.noteId) return;
    if (!confirmNavigation()) return;
    const tab = { id: tabSeq.current++, noteId: null };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    vault.setActiveNote(null);
  }, [tabs, activeTabId, confirmNavigation, vault]);

  const handleToggleTabLock = useCallback((tabId) => {
    setLockedTabIds((current) => {
      const locked = current.includes(tabId);
      toast.info(locked ? '标签页已解锁' : '标签页已锁定');
      return locked ? current.filter((id) => id !== tabId) : [...current, tabId];
    });
  }, [toast]);

  const handleTabClose = useCallback(
    (tabId) => {
      if (lockedTabIds.includes(tabId)) {
        toast.info('标签页已锁定，请先解锁后关闭');
        return;
      }
      const index = tabs.findIndex((t) => t.id === tabId);
      if (index === -1) return;
      const closingActive = tabId === activeTabId;
      if (closingActive && !confirmNavigation()) return;
      const remaining = tabs.filter((t) => t.id !== tabId);
      if (!remaining.length) {
        const fresh = { id: tabSeq.current++, noteId: null };
        setTabs([fresh]);
        setActiveTabId(fresh.id);
        setLockedTabIds([]);
        vault.setActiveNote(null);
        return;
      }
      setTabs(remaining);
      setLockedTabIds((current) => current.filter((id) => id !== tabId));
      if (closingActive) activateTab(remaining[Math.max(0, index - 1)]);
    },
    [tabs, activeTabId, confirmNavigation, activateTab, lockedTabIds, toast, vault],
  );

  const handleCloseTabs = useCallback(
    (tabId, mode) => {
      const targetIndex = tabs.findIndex((tab) => tab.id === tabId);
      if (targetIndex === -1) return;

      const shouldClose = (tab, index) => {
        if (lockedTabIds.includes(tab.id)) return false;
        if (mode === 'left') return index < targetIndex;
        if (mode === 'right') return index > targetIndex;
        if (mode === 'others') return tab.id !== tabId;
        return false;
      };

      const remaining = tabs.filter((tab, index) => !shouldClose(tab, index));
      if (remaining.length === tabs.length) return;

      const closingActive = !remaining.some((tab) => tab.id === activeTabId);
      if (closingActive && !confirmNavigation()) return;

      setTabs(remaining);
      setLockedTabIds((current) => current.filter((id) => remaining.some((tab) => tab.id === id)));

      if (closingActive) {
        const next = remaining.find((tab) => tab.id === tabId) ?? remaining[0];
        activateTab(next);
      }
    },
    [tabs, activeTabId, confirmNavigation, activateTab, lockedTabIds],
  );

  const handleRenameTab = useCallback((tabId) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab?.noteId) return;
    const note = activeNote?.id === tab.noteId
      ? activeNote
      : noteIndex.find((item) => item.id === tab.noteId);
    if (!note) return;
    setRenameDialog({ tabId, noteId: note.id, title: note.title });
  }, [activeNote, noteIndex, tabs]);

  const handleRenameNote = useCallback((note) => {
    if (!note?.id) return;
    const tab = tabs.find((item) => item.noteId === note.id);
    setRenameDialog({ tabId: tab?.id ?? null, noteId: note.id, title: note.title });
  }, [tabs]);

  const handleRenameDialogSubmit = useCallback(async (event) => {
    event.preventDefault();
    if (!renameDialog || renameSaving) return;
    const title = renameDialog.title.trim();
    if (!title) {
      toast.error('文件名不能为空');
      return;
    }
    if (title === noteTitles.get(renameDialog.noteId)) {
      setRenameDialog(null);
      return;
    }

    setRenameSaving(true);
    const saved = await renameNote(renameDialog.noteId, title);
    setRenameSaving(false);
    if (saved) setRenameDialog(null);
  }, [noteTitles, renameDialog, renameSaving, renameNote, toast]);

  const handleMoveTabNote = useCallback(async (tabId, folderId) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab?.noteId) return;
    const moved = await moveNote(tab.noteId, folderId);
    if (moved) toast.success(folderId ? '笔记已移动' : '笔记已移至未分类');
  }, [moveNote, tabs, toast]);

  /** 删除笔记后：移除其标签，并把激活位挪到相邻标签 */
  const handleToggleNotePin = useCallback(async (note) => {
    const saved = await togglePin(note);
    if (saved) toast.success(saved.isPinned ? '笔记已收藏' : '已取消笔记收藏');
    return saved;
  }, [toast, togglePin]);

  const handleMoveNote = useCallback(async (id, folderId) => {
    const moved = await moveNote(id, folderId);
    if (moved) toast.success(folderId ? '笔记已移动' : '笔记已移至未分类');
    return moved;
  }, [moveNote, toast]);

  const handleDeleteNote = useCallback(
    async (id) => {
      const ok = await deleteNote(id);
      if (!ok) return false;
      const closedIndex = tabs.findIndex((t) => t.noteId === id);
      if (closedIndex === -1) return true;
      const remaining = tabs.filter((t) => t.noteId !== id);
      setLockedTabIds((current) => current.filter((tabId) => remaining.some((tab) => tab.id === tabId)));
      if (!remaining.length) {
        const fresh = { id: tabSeq.current++, noteId: null };
        setTabs([fresh]);
        setActiveTabId(fresh.id);
        return true;
      }
      setTabs(remaining);
      if (tabs.find((t) => t.id === activeTabId)?.noteId === id) {
        const next = remaining[Math.max(0, closedIndex - 1)];
        setActiveTabId(next.id);
        if (next.noteId) openNote(next.noteId);
      }
      return true;
    },
    [deleteNote, tabs, activeTabId, openNote],
  );

  const handleOpenFromGraph = useCallback(
    async (id) => {
      setView('notes');
      await handleOpenNote(id);
    },
    [handleOpenNote],
  );

  const handleOpenWikiLink = useCallback(
    async (title) => {
      const hit = resolveTitle(title);
      if (hit) {
        const opened = await openInTab(hit.id);
        if (opened) setView('notes');
        return;
      }
      toast.info(`「${title}」还不存在，可在右侧出链或图谱里一键创建`);
    },
    [resolveTitle, openInTab, toast],
  );

  /** 由悬空链接 / 图谱触发：按标题创建缺失的笔记并打开 */
  const handleCreateByTitle = useCallback(
    async (title) => {
      const created = await createNote({ title, folderId: targetFolderId });
      if (created) {
        setSwitcherOpen(false);
        openInTab(created.id);
        setView('notes');
        toast.success(`已创建「${created.title}」`);
      }
    },
    [createNote, openInTab, targetFolderId, toast],
  );

  const handleCreateNote = useCallback(async (folderId = targetFolderId) => {
    const created = await createNote({ folderId });
    if (created) {
      openInTab(created.id);
      setView('notes');
      toast.success('已新建笔记');
    }
  }, [createNote, openInTab, targetFolderId, toast]);

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshSidebar(), refreshNotes(), refreshGraph()]);
    setRefreshing(false);
    toast.success('数据已重新加载');
  }, [refreshGraph, refreshNotes, refreshSidebar, toast]);

  // ── 快捷键 ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (event) => {
      if (settingsOpen) return;
      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (settings.quickSwitcher && meta && key === 'k') {
        event.preventDefault();
        setSwitcherOpen(true);
        return;
      }

      if (meta && key === 'j') {
        event.preventDefault();
        setAiOpen((value) => !value);
        return;
      }

      if (meta && key === 'o') {
        event.preventDefault();
        setSwitcherOpen(true);
        return;
      }

      if (meta && key === 'n') {
        event.preventDefault();
        handleCreateNote();
        return;
      }

      if (meta && key === 't') {
        event.preventDefault();
        handleTabNew();
        return;
      }

      if (meta && key === 'w') {
        event.preventDefault();
        handleTabClose(activeTabId);
        return;
      }

      if (meta && key === 'b') {
        event.preventDefault();
        setSidebarOpen((value) => !value);
        return;
      }

      if (meta && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId, handleCreateNote, handleTabClose, handleTabNew, settings.quickSwitcher, settingsOpen]);

  // ── 切到图谱视图时按需加载（数据被改动过才重新拉取） ───────
  useEffect(() => {
    if (view !== 'graph') return;
    if (graph && !graphStale) return;
    refreshGraph();
  }, [view, graph, graphStale, refreshGraph]);

  const handleToggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const handleOpenSwitcher = useCallback(() => setSwitcherOpen(true), []);
  const handleCloseSwitcher = useCallback(() => setSwitcherOpen(false), []);
  const handleToggleAi = useCallback(() => setAiOpen((value) => !value), []);
  const handleTogglePanel = useCallback(() => setPanelOpen((value) => !value), []);

  const copyText = useCallback(async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label}已复制`);
    } catch {
      toast.error(`无法复制${label}`);
    }
  }, [toast]);

  const handleCopyPath = useCallback((note) => {
    if (!note) return;
    copyText(noteFilePath(note, folders), '路径');
  }, [copyText, folders]);

  const handleCopyNotePath = useCallback(async (note, mode = 'relative') => {
    if (!note) return;
    const relativePath = note.filePath ?? noteFilePath(note, folders);
    if (mode === 'relative') {
      await copyText(relativePath, '路径');
      return;
    }

    const info = await window.latticeDesktop?.getVaultInfo?.();
    if (!info?.path) {
      toast.error('浏览器开发模式无法获取完整路径');
      return;
    }
    const separator = info.path.includes('\\') ? '\\' : '/';
    const absolutePath = `${info.path.replace(/[\\/]+$/, '')}${separator}${relativePath.split('/').join(separator)}`;
    await copyText(absolutePath, '完整路径');
  }, [copyText, folders, toast]);

  const handleCopyFolderPath = useCallback(async (relativePath, mode = 'relative') => {
    if (mode === 'relative') {
      copyText(relativePath, '路径');
      return;
    }

    const info = await window.latticeDesktop?.getVaultInfo?.();
    if (!info?.path) {
      toast.error('浏览器开发模式无法获取完整路径');
      return;
    }
    const separator = info.path.includes('\\') ? '\\' : '/';
    const absolutePath = `${info.path.replace(/[\\/]+$/, '')}${separator}${relativePath.split('/').join(separator)}`;
    copyText(absolutePath, '完整路径');
  }, [copyText, toast]);

  const handleToggleFavorite = useCallback((folderId) => {
    setFavoriteFolderIds((current) => {
      const isFavorite = current.includes(folderId);
      toast.success(isFavorite ? '已取消收藏文件夹' : '已收藏文件夹');
      return isFavorite ? current.filter((id) => id !== folderId) : [...current, folderId];
    });
  }, [toast]);

  const handleFindInFolder = useCallback((folderId) => {
    selectFolder(folderId);
    requestAnimationFrame(() => {
      document.querySelector('input[aria-label="全文检索"], .topbar input[type="search"]')?.focus();
    });
  }, [selectFolder]);

  const handleCopyWikiLink = useCallback((note) => {
    if (!note) return;
    copyText(`[[${note.title}]]`, '双链');
  }, [copyText]);

  const handleOpenDefault = useCallback(async (note) => {
    if (!note) return;
    const relativePath = note.filePath ?? noteFilePath(note, folders);
    if (!window.latticeDesktop?.openVaultFile) {
      toast.info('浏览器开发模式不支持使用系统默认应用打开');
      return;
    }
    const opened = await window.latticeDesktop.openVaultFile(relativePath);
    if (!opened) toast.error('无法使用默认应用打开文件');
  }, [folders, toast]);

  const handleRevealFile = useCallback(async (note) => {
    if (!note) return;
    const relativePath = note.filePath ?? noteFilePath(note, folders);
    if (!window.latticeDesktop?.revealVaultPath) {
      toast.info('浏览器开发模式不支持在资源管理器中显示文件');
      return;
    }
    const revealed = await window.latticeDesktop.revealVaultPath(relativePath);
    if (!revealed) toast.error('无法在资源管理器中定位文件');
  }, [folders, toast]);

  const handleShowInFileList = useCallback((note) => {
    if (!note) return;
    setView('notes');
    setSidebarOpen(true);
    selectFolder(note.folderId ?? null);
  }, [selectFolder]);

  const handleOpenLinkedNote = useCallback(async (id) => {
    if (!id) return;
    setView('notes');
    await openInTab(id);
  }, [openInTab]);

  const handleDuplicateNote = useCallback(async (note) => {
    const created = await duplicateNote(note);
    if (created) {
      await openInTab(created.id);
      setView('notes');
    }
  }, [duplicateNote, openInTab]);

  return (
    <div className={`app app--${shellMode}`}>
      {shellMode === 'obsidian' ? (
        <Ribbon
          view={view}
          onViewChange={handleViewChange}
          onOpenSwitcher={handleOpenSwitcher}
          onToggleAi={handleToggleAi}
          onCreateNote={handleCreateNote}
          onCreateCanvas={handleCreateCanvas}
          onRefresh={handleRefreshAll}
          refreshing={refreshing}
          onTogglePanel={handleTogglePanel}
          onToggleTheme={handleToggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
          theme={theme}
        />
      ) : null}
      {shellMode === 'topbar' ? <TopBar
        query={query}
        onQueryChange={setQuery}
        view={view}
        onViewChange={handleViewChange}
        onCreateNote={handleCreateNote}
        onOpenSwitcher={handleOpenSwitcher}
        onRefresh={handleRefreshAll}
        refreshing={refreshing}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        panelOpen={panelOpen}
        onTogglePanel={handleTogglePanel}
        onOpenSettings={() => setSettingsOpen(true)}
      /> : null}

      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        noteTitles={noteTitles}
        noteIndex={noteIndex}
        folders={folders}
        activeNote={activeNote}
        lockedTabIds={lockedTabIds}
        onSelect={handleTabSelect}
        onClose={handleTabClose}
        onCloseToLeft={(tabId) => handleCloseTabs(tabId, 'left')}
        onCloseToRight={(tabId) => handleCloseTabs(tabId, 'right')}
        onCloseOthers={(tabId) => handleCloseTabs(tabId, 'others')}
        onNew={handleTabNew}
        onToggleLock={handleToggleTabLock}
        onTogglePin={togglePin}
        onRename={handleRenameTab}
        onMoveNote={handleMoveTabNote}
        onCopyPath={handleCopyNotePath}
        onCopyWikiLink={handleCopyWikiLink}
        onOpenDefault={handleOpenDefault}
        onRevealFile={handleRevealFile}
        onShowInFileList={handleShowInFileList}
        onDeleteNote={handleDeleteNote}
        onOpenLinkedNote={handleOpenLinkedNote}
      />

      {connectionDown ? (
        <div className="banner banner--error banner--global">
          <span>与后端服务的连接中断了。请确认服务已启动（默认 http://localhost:5177），然后重新加载。</span>
          <button type="button" className="btn btn--sm" onClick={handleRefreshAll} disabled={refreshing}>
            重新连接
          </button>
        </div>
      ) : null}

      <div className={`app__body app__body--${view} ${activeNote ? 'app__body--has-active-note' : ''} ${panelOpen && view === 'notes' ? '' : 'app__body--no-panel'} ${sidebarOpen ? '' : 'app__body--no-sidebar'} ${view === 'canvas' ? 'app__body--canvas' : ''} ${view === 'graph' ? 'app__body--graph' : ''}`}>
        {sidebarOpen ? (
          <Sidebar
            folders={folders}
            noteIndex={noteIndex}
            canvasFiles={canvasFiles}
            tags={tags}
            overview={overview}
            filter={filter}
            activeNoteId={activeNote?.id ?? null}
            sort={sort}
            loading={loading.sidebar}
            onSelectFolder={selectFolder}
            onOpenNote={handleOpenNote}
            onSelectTag={selectTag}
            onClearFilter={clearFilter}
            onSortChange={setSort}
            onCreateFolder={createFolder}
            onDeleteFolder={deleteFolder}
            onRenameFolder={renameFolder}
            onCreateNote={handleCreateNote}
            onRevealFolder={revealFolder}
            onRefresh={handleRefreshAll}
            refreshing={refreshing}
            onOpenSettings={() => setSettingsOpen(true)}
            onCollapseSidebar={() => setSidebarOpen(false)}
            onOpenCanvas={handleOpenCanvas}
            onCreateCanvas={handleCreateCanvas}
            canvasPath={canvasPath}
            favoriteFolderIds={favoriteFolderIds}
            onDuplicateFolder={duplicateFolder}
            onMoveFolder={moveFolder}
            onFindInFolder={handleFindInFolder}
            onToggleFavorite={handleToggleFavorite}
            onCopyFolderPath={handleCopyFolderPath}
            onToggleNotePin={handleToggleNotePin}
            onDuplicateNote={handleDuplicateNote}
            onMoveNote={handleMoveNote}
            onMoveCanvas={handleMoveCanvas}
            onCopyNotePath={handleCopyNotePath}
            onOpenDefault={handleOpenDefault}
            onRevealNote={handleRevealFile}
            onRenameNote={handleRenameNote}
            onDeleteNote={handleDeleteNote}
          />
        ) : (
          <button
            type="button"
            className="sidebar-rail"
            onClick={() => setSidebarOpen(true)}
            aria-label="展开侧边栏"
            title="展开侧边栏（Ctrl / Cmd + B）"
          >
            ⟩
          </button>
        )}

        {view === 'notes' ? <NoteListPane
          notes={notes}
          notesTotal={notesTotal}
          page={page}
          pageCount={pageCount}
          search={search}
          filter={filter}
          sort={sort}
          query={query}
          onQueryChange={setQuery}
          showSearch={shellMode === 'obsidian'}
          folderLookup={folderLookup}
          tagLookup={tagLookup}
          activeNoteId={activeNote?.id ?? null}
          loading={loading.notes}
          onSortChange={setSort}
          onPageChange={setPage}
          onOpenNote={handleOpenNote}
          onTogglePin={togglePin}
          onDeleteNote={handleDeleteNote}
           onCreateNote={handleCreateNote}
           onDuplicateNote={handleDuplicateNote}
           onCopyPath={handleCopyPath}
           onCopyWikiLink={handleCopyWikiLink}
         /> : null}

        <main className="workspace">
          {view === 'graph' ? (
            <GraphView
              graph={graph}
              loading={loading.graph}
              activeNoteId={activeNote?.id ?? null}
              onOpenNote={handleOpenFromGraph}
              onCreateNoteByTitle={handleCreateByTitle}
              onRefresh={refreshGraph}
            />
          ) : view === 'canvas' ? (
            <CanvasView canvasPath={canvasPath} noteIndex={noteIndex} activeNoteId={activeNote?.id ?? null} onOpenNote={handleOpenNote} onCreateNote={handleCreateNote} />
          ) : (
            <div className={`workspace__editor ${panelOpen ? '' : 'workspace__editor--wide'}`}>
              <EditorPane
                note={activeNote}
                folders={folders}
                resolveTitle={resolveTitle}
                resolveEmbed={resolveEmbed}
                onSave={saveNote}
                onDelete={handleDeleteNote}
                onTogglePin={togglePin}
                onMove={moveNote}
                onOpenWikiLink={handleOpenWikiLink}
                onCreateWikiLink={handleCreateByTitle}
                registerNavigationGuard={registerNavigationGuard}
                onCreateNote={handleCreateNote}
                onOpenSwitcher={handleOpenSwitcher}
                onCloseTab={() => handleTabClose(activeTabId)}
                onDuplicate={handleDuplicateNote}
                onCopyPath={handleCopyPath}
                onCopyWikiLink={handleCopyWikiLink}
              />

              {panelOpen ? (
                <LinkPanel
                  note={activeNote}
                  folderLookup={folderLookup}
                  onOpenNote={handleOpenNote}
                  onCreateWikiLink={handleCreateByTitle}
                />
              ) : null}
            </div>
          )}
        </main>
      </div>

      {shellMode === 'obsidian' ? (
        <StatusBar overview={overview} connectionDown={connectionDown} note={activeNote} />
      ) : null}

      <QuickSwitcher
        open={switcherOpen}
        noteIndex={noteIndex}
        onClose={handleCloseSwitcher}
        onSelect={(note) => {
          setSwitcherOpen(false);
          handleOpenNote(note.id);
        }}
        onCreate={handleCreateByTitle}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onThemeChange={setTheme}
      />
      <AIAssistantPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onOpenSettings={() => { setAiOpen(false); setSettingsOpen(true); }}
        noteIndex={noteIndex}
        folders={folders}
        activeNote={activeNote}
        onOpenNote={handleOpenNote}
        onOperationComplete={handleRefreshAll}
      />
      <RenameDialog
        open={Boolean(renameDialog)}
        title={renameDialog?.title ?? ''}
        saving={renameSaving}
        onChange={(title) => setRenameDialog((current) => current ? { ...current, title } : current)}
        onClose={() => {
          if (!renameSaving) setRenameDialog(null);
        }}
        onSubmit={handleRenameDialogSubmit}
      />
    </div>
  );
}

function RenameDialog({ open, title, saving, onChange, onClose, onSubmit }) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="文件名" ariaLabel="重命名笔记" className="rename-modal" initialFocusRef={inputRef}>
      <form className="rename-dialog" onSubmit={onSubmit}>
        <header className="rename-dialog__header">
          <div>
            <span className="rename-dialog__eyebrow">NOTE / FILE</span>
            <h2>文件名</h2>
          </div>
          <button type="button" className="icon-btn rename-dialog__close" onClick={onClose} aria-label="关闭重命名">
            ×
          </button>
        </header>
        <div className="rename-dialog__body">
          <label htmlFor="rename-file-name">文件名</label>
          <input
            ref={inputRef}
            id="rename-file-name"
            value={title}
            maxLength={160}
            autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
            disabled={saving}
          />
        </div>
        <footer className="rename-dialog__actions">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </footer>
      </form>
    </Modal>
  );
}
