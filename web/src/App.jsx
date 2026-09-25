import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notesApi, exportsApi } from './api/resources.js';
import AppRail from './components/AppRail.jsx';
import EditorPane from './components/EditorPane.jsx';
import AttachmentsView from './components/AttachmentsView.jsx';
import GraphView from './components/GraphView.jsx';
import LinkPanel from './components/LinkPanel.jsx';
import NoteListPane from './components/NoteListPane.jsx';
import QuickSwitcher from './components/QuickSwitcher.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import { useToast } from './hooks/useToast.jsx';
import { useVault } from './hooks/useVault.js';

const THEME_STORAGE_KEY = 'lattice-theme';

const VIEW_LABELS = {
  notes: '笔记',
  graph: '关系图谱',
  attachments: '附件管理',
};

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
    openByTitle,
    createNote,
    saveNote,
    deleteNote,
    createFolder,
    renameFolder,
    deleteFolder,
    moveNote,
    togglePin,
    restoreVersion,
    resolveTitle,
    refreshNotes,
    refreshSidebar,
    refreshGraph,
    registerNavigationGuard,
    confirmNavigation,
  } = vault;

  const [view, setView] = useState('notes');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  // 窄屏下的两件事：导航抽屉是否展开、当前停在「列表」还是「正文」
  const [navOpen, setNavOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState('list');

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
  const handleOpenNote = useCallback(
    async (id) => {
      if (!confirmNavigation()) return null;
      setMobilePane('focus');
      setNavOpen(false);
      return openNote(id);
    },
    [confirmNavigation, openNote],
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
      if (!confirmNavigation()) return;
      const opened = await openByTitle(title);
      if (opened) {
        setView('notes');
        setMobilePane('focus');
        return;
      }
      toast.info(`「${title}」还不存在，可在右侧出链或图谱里一键创建`);
    },
    [confirmNavigation, openByTitle, toast],
  );

  /** 由悬空链接 / 图谱触发：按标题创建缺失的笔记并打开 */
  const handleCreateByTitle = useCallback(
    async (title) => {
      const created = await createNote({ title, folderId: targetFolderId });
      if (created) {
        setSwitcherOpen(false);
        setView('notes');
        setMobilePane('focus');
        toast.success(`已创建「${created.title}」`);
      }
    },
    [createNote, targetFolderId, toast],
  );

  const handleCreateNote = useCallback(async () => {
    const created = await createNote({ folderId: targetFolderId });
    if (created) {
      setView('notes');
      setMobilePane('focus');
      toast.success('已新建笔记');
    }
  }, [createNote, targetFolderId, toast]);

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshSidebar(), refreshNotes(), refreshGraph()]);
    setRefreshing(false);
    toast.success('数据已重新加载');
  }, [refreshGraph, refreshNotes, refreshSidebar, toast]);

  const handleExportSite = useCallback(async () => {
    setExporting(true);
    try {
      const result = await exportsApi.staticSite();
      setExportResult(result);
      toast.success(`已导出 ${result.noteCount} 篇笔记（含 ${result.attachmentCount} 个附件）`);
    } catch (error) {
      toast.error(error?.message ?? '导出失败');
    } finally {
      setExporting(false);
    }
  }, [toast]);

  // ── 侧栏动作统一收口：窄屏选中后自动收起抽屉 ───────────────
  const handleSelectFolder = useCallback(
    (id) => {
      selectFolder(id);
      setNavOpen(false);
      setMobilePane('list');
    },
    [selectFolder],
  );

  const handleSelectTag = useCallback(
    (id) => {
      selectTag(id);
      setNavOpen(false);
      setMobilePane('list');
    },
    [selectTag],
  );

  const handleClearFilter = useCallback(() => {
    clearFilter();
    setNavOpen(false);
    setMobilePane('list');
  }, [clearFilter]);

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

      if (event.key === 'Escape') setNavOpen(false);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleCreateNote]);

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
  const handleOpenNav = useCallback(() => setNavOpen(true), []);
  const handleCloseNav = useCallback(() => setNavOpen(false), []);
  const handleBackToList = useCallback(() => setMobilePane('list'), []);

  // 窄屏只显示一屏内容：非笔记视图时直接让出整个宽度给工作区
  const mobilePaneState = view === 'notes' && mobilePane === 'list' ? 'list' : 'focus';

  return (
    <div className="app">
      <AppRail view={view} onViewChange={setView} theme={theme} onToggleTheme={handleToggleTheme} />

      <div className="app__main">
        <TopBar
          query={query}
          onQueryChange={setQuery}
          view={view}
          viewLabel={VIEW_LABELS[view] ?? '笔记'}
          onCreateNote={handleCreateNote}
          onOpenSwitcher={handleOpenSwitcher}
          onRefresh={handleRefreshAll}
          refreshing={refreshing}
          panelOpen={panelOpen}
          onTogglePanel={handleTogglePanel}
          onToggleNav={handleOpenNav}
          onBack={handleBackToList}
          backVisible={mobilePaneState === 'focus'}
        />

        {connectionDown ? (
          <div className="banner banner--error banner--global">
            <span>与后端服务的连接中断了。请确认服务已启动（默认 http://localhost:5177），然后重新加载。</span>
            <button type="button" className="btn btn--sm" onClick={handleRefreshAll} disabled={refreshing}>
              重新连接
            </button>
          </div>
        ) : null}

        <div className="app__body" data-pane={mobilePaneState}>
          <Sidebar
            folders={folders}
            tags={tags}
            overview={overview}
            filter={filter}
            loading={loading.sidebar}
            onSelectFolder={handleSelectFolder}
            onSelectTag={handleSelectTag}
            onClearFilter={handleClearFilter}
            onCreateFolder={createFolder}
            onDeleteFolder={deleteFolder}
            onRenameFolder={renameFolder}
            onExportSite={handleExportSite}
            exporting={exporting}
            exportResult={exportResult}
            open={navOpen}
            onClose={handleCloseNav}
          />

          <NoteListPane
            notes={notes}
            notesTotal={notesTotal}
            search={search}
            filter={filter}
            sort={sort}
            folderLookup={folderLookup}
            tagLookup={tagLookup}
            activeNoteId={activeNote?.id ?? null}
            loading={loading.notes}
            onSortChange={setSort}
            onOpenNote={handleOpenNote}
            onTogglePin={togglePin}
            onCreateNote={handleCreateNote}
          />

          <main className="workspace">
            {view === 'attachments' ? (
              <AttachmentsView
                onOpenNote={(id) => {
                  setView('notes');
                  handleOpenNote(id);
                }}
              />
            ) : view === 'graph' ? (
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
                  onDelete={deleteNote}
                  onTogglePin={togglePin}
                  onMove={moveNote}
                  onOpenWikiLink={handleOpenWikiLink}
                  onCreateWikiLink={handleCreateByTitle}
                  onRestoreVersion={restoreVersion}
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
      </div>

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
    </div>
  );
}