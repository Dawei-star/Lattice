import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notesApi } from './api/resources.js';
import EditorPane from './components/EditorPane.jsx';
import GraphView from './components/GraphView.jsx';
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
import { loadImportedTheme } from './lib/theme.js';

const THEME_STORAGE_KEY = 'lattice-theme';

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
    noteIndex,
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
    togglePin,
    resolveTitle,
    refreshNotes,
    refreshSidebar,
    refreshGraph,
    registerNavigationGuard,
    confirmNavigation,
  } = vault;

  const [view, setView] = useState('notes');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  const [shellMode] = useState(() => new URLSearchParams(window.location.search).get('shell') === 'topbar' ? 'topbar' : 'obsidian');

  // ── 多标签页：tabs 记录打开了哪些笔记，vault.activeNote 即当前标签的内容 ──
  const [tabs, setTabs] = useState(() => [{ id: 1, noteId: null }]);
  const [activeTabId, setActiveTabId] = useState(1);
  const tabSeq = useRef(2);

  const noteTitles = useMemo(() => new Map((noteIndex ?? []).map((n) => [n.id, n.title])), [noteIndex]);

  useEffect(() => {
    loadImportedTheme();
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

  const handleOpenNote = openInTab;

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

  const handleTabClose = useCallback(
    (tabId) => {
      const index = tabs.findIndex((t) => t.id === tabId);
      if (index === -1) return;
      const closingActive = tabId === activeTabId;
      if (closingActive && !confirmNavigation()) return;
      const remaining = tabs.filter((t) => t.id !== tabId);
      if (!remaining.length) {
        const fresh = { id: tabSeq.current++, noteId: null };
        setTabs([fresh]);
        setActiveTabId(fresh.id);
        vault.setActiveNote(null);
        return;
      }
      setTabs(remaining);
      if (closingActive) activateTab(remaining[Math.max(0, index - 1)]);
    },
    [tabs, activeTabId, confirmNavigation, activateTab, vault],
  );

  /** 删除笔记后：移除其标签，并把激活位挪到相邻标签 */
  const handleDeleteNote = useCallback(
    async (id) => {
      const ok = await deleteNote(id);
      if (!ok) return false;
      const closedIndex = tabs.findIndex((t) => t.noteId === id);
      if (closedIndex === -1) return true;
      const remaining = tabs.filter((t) => t.noteId !== id);
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
      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (meta && key === 'k') {
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
  }, [handleCreateNote, handleTabNew]);

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
  const handleTogglePanel = useCallback(() => setPanelOpen((value) => !value), []);

  return (
    <div className={`app app--${shellMode}`}>
      {shellMode === 'obsidian' ? (
        <Ribbon
          view={view}
          onViewChange={setView}
          onOpenSwitcher={handleOpenSwitcher}
          onCreateNote={handleCreateNote}
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
        onViewChange={setView}
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
        onSelect={handleTabSelect}
        onClose={handleTabClose}
        onNew={handleTabNew}
      />

      {connectionDown ? (
        <div className="banner banner--error banner--global">
          <span>与后端服务的连接中断了。请确认服务已启动（默认 http://localhost:5177），然后重新加载。</span>
          <button type="button" className="btn btn--sm" onClick={handleRefreshAll} disabled={refreshing}>
            重新连接
          </button>
        </div>
      ) : null}

      <div className={`app__body ${panelOpen && view === 'notes' ? '' : 'app__body--no-panel'} ${sidebarOpen ? '' : 'app__body--no-sidebar'}`}>
        {sidebarOpen ? (
          <Sidebar
            folders={folders}
            tags={tags}
            overview={overview}
            filter={filter}
            sort={sort}
            loading={loading.sidebar}
            onSelectFolder={selectFolder}
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

        <NoteListPane
          notes={notes}
          notesTotal={notesTotal}
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
          onOpenNote={handleOpenNote}
          onTogglePin={togglePin}
          onDeleteNote={handleDeleteNote}
          onCreateNote={handleCreateNote}
        />

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
    </div>
  );
}
