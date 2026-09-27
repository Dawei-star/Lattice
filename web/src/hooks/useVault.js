/**
 * 知识库中心状态。
 *
 * 职责：把后端的资源接口收敛成一个可用的数据模型，并统一处理
 * 加载态、错误提示、连接状态与缓存失效。组件只消费这里暴露的状态与动作，
 * 不直接调用 API 层，也不自己拼查询参数。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';
import { foldersApi, graphApi, metaApi, notesApi, searchApi, tagsApi } from '../api/resources.js';
import { noteFilePath, vaultFiles } from '../api/vault-files.js';
import { useDebouncedValue } from './useDebouncedValue.js';
import { useToast } from './useToast.jsx';

const DEFAULT_FILTER = { kind: 'all', folderId: null, tagId: null };
const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 280;

/** 未分类笔记在查询里的特殊标记，与后端约定一致 */
const UNFILED = '__none__';

function flattenFolderTree(nodes, result = []) {
  for (const node of nodes ?? []) {
    result.push(node);
    flattenFolderTree(node.children, result);
  }
  return result;
}

export function useVault() {
  const toast = useToast();

  const [folders, setFolders] = useState([]);
  const [tags, setTags] = useState([]);
  const [overview, setOverview] = useState(null);
  const [noteIndex, setNoteIndex] = useState([]);

  const [filter, setFilter] = useState(DEFAULT_FILTER);
  const [sort, setSort] = useState('updated');
  const [notes, setNotes] = useState([]);
  const [notesTotal, setNotesTotal] = useState(0);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [search, setSearch] = useState({ loading: false, items: [], strategy: '', query: '' });

  const [activeNote, setActiveNote] = useState(null);
  const [graph, setGraph] = useState(null);
  const [graphStale, setGraphStale] = useState(true);
  const [loading, setLoading] = useState({ sidebar: true, notes: true, note: false, graph: false });
  const [connectionDown, setConnectionDown] = useState(false);

  /** 编辑器未保存内容的重载保护：切换笔记前由编辑区注册拦截器 */
  const navigationGuard = useRef(null);

  const handleError = useCallback(
    (error, fallbackMessage) => {
      if (error?.name === 'AbortError') return;

      if (error instanceof ApiError) {
        if (error.isOffline || error.isTimeout) {
          setConnectionDown(true);
          toast.error(error.message);
          return;
        }
        toast.error(error.message, {
          detail: error.requestId ? `请求编号 ${error.requestId}` : undefined,
        });
        return;
      }

      toast.error(fallbackMessage ?? '操作失败，请重试');
      // 非预期异常保留在控制台，便于排查
      console.error('[lattice] 未预期的错误', error);
    },
    [toast],
  );

  // ── 数据加载 ────────────────────────────────────────────────────
  const refreshSidebar = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) setLoading((current) => ({ ...current, sidebar: true }));
      try {
        const [folderTree, tagList, stats, index] = await Promise.all([
          foldersApi.list(),
          tagsApi.list(),
          metaApi.overview(),
          notesApi.index(),
        ]);
        setFolders(folderTree ?? []);
        setTags(tagList ?? []);
        setOverview(stats ?? null);
        setNoteIndex(index ?? []);
        setConnectionDown(false);
      } catch (error) {
        handleError(error, '加载侧边栏数据失败');
      } finally {
        if (!silent) setLoading((current) => ({ ...current, sidebar: false }));
      }
    },
    [handleError],
  );

  const refreshNotes = useCallback(async () => {
    setLoading((current) => ({ ...current, notes: true }));
    try {
      const params = { sort, limit: PAGE_SIZE, offset: 0 };
      if (filter.kind === 'folder') params.folderId = filter.folderId ?? UNFILED;
      if (filter.kind === 'tag') params.tagId = filter.tagId;

      const result = await notesApi.list(params);
      setNotes(result.items);
      setNotesTotal(result.total);
      setConnectionDown(false);
    } catch (error) {
      handleError(error, '加载笔记列表失败');
    } finally {
      setLoading((current) => ({ ...current, notes: false }));
    }
  }, [filter, sort, handleError]);

  const refreshGraph = useCallback(async () => {
    setLoading((current) => ({ ...current, graph: true }));
    try {
      const data = await graphApi.get();
      setGraph(data);
      setGraphStale(false);
    } catch (error) {
      handleError(error, '加载关系图谱失败');
    } finally {
      setLoading((current) => ({ ...current, graph: false }));
    }
  }, [handleError]);

  useEffect(() => {
    refreshSidebar();
  }, [refreshSidebar]);

  useEffect(() => {
    refreshNotes();
  }, [refreshNotes]);

  // ── 全文检索（防抖 + 竞态保护） ─────────────────────────────────
  useEffect(() => {
    const keyword = debouncedQuery.trim();
    if (!keyword) {
      setSearch({ loading: false, items: [], strategy: '', query: '' });
      return undefined;
    }

    let cancelled = false;
    setSearch((current) => ({ ...current, loading: true, query: keyword }));

    const searchFolderId = filter.kind === 'folder' ? (filter.folderId ?? UNFILED) : undefined;

    searchApi
      .query(keyword, { limit: 40, folderId: searchFolderId })
      .then((result) => {
        if (cancelled) return;
        setSearch({ loading: false, items: result.items, strategy: result.strategy, query: keyword });
        setConnectionDown(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setSearch({ loading: false, items: [], strategy: '', query: keyword });
        handleError(error, '检索失败');
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, filter.folderId, filter.kind, handleError]);

  // ── 标题索引：双链解析、快速切换、嵌入目标定位都依赖它 ─────────
  const titleIndex = useMemo(() => {
    const map = new Map();
    // noteIndex 已按更新时间倒序，同名笔记因此自然保留最近更新的那篇
    for (const entry of noteIndex) {
      const key = entry.title.trim().toLowerCase();
      if (!map.has(key)) map.set(key, entry);
    }
    return map;
  }, [noteIndex]);

  const resolveTitle = useCallback(
    (title) => titleIndex.get(String(title ?? '').trim().toLowerCase()) ?? null,
    [titleIndex],
  );

  // ── 动作 ────────────────────────────────────────────────────────
  const registerNavigationGuard = useCallback((guard) => {
    navigationGuard.current = guard;
  }, []);

  /** 返回 true 表示切换被拦下（有未保存内容且用户选择留下） */
  const confirmNavigation = useCallback(() => {
    const guard = navigationGuard.current;
    if (typeof guard !== 'function') return true;
    return guard() !== false;
  }, []);

  const openNote = useCallback(
    async (id) => {
      if (!id) {
        setActiveNote(null);
        return null;
      }
      setLoading((current) => ({ ...current, note: true }));
      try {
        const note = await notesApi.get(id);
        if (vaultFiles.isAvailable() && note.filePath) {
          const content = await vaultFiles.readMarkdown(note.filePath);
          if (content !== null) note.content = content;
        }
        setActiveNote(note);
        setConnectionDown(false);
        return note;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          setActiveNote(null);
          toast.info('这篇笔记已经不存在了，列表已刷新');
          refreshNotes();
          refreshSidebar({ silent: true });
        } else {
          handleError(error, '打开笔记失败');
        }
        return null;
      } finally {
        setLoading((current) => ({ ...current, note: false }));
      }
    },
    [handleError, refreshNotes, refreshSidebar, toast],
  );

  /** 按标题打开；标题不存在时返回 null，由调用方决定是否创建 */
  const openByTitle = useCallback(
    async (title) => {
      const hit = resolveTitle(title);
      if (!hit) return null;
      return openNote(hit.id);
    },
    [openNote, resolveTitle],
  );

  const createNote = useCallback(
    async (input = {}) => {
      try {
        if (vaultFiles.isAvailable()) {
          const timestamp = new Date().toISOString();
          const note = {
            id: input.id ?? crypto.randomUUID(),
            title: input.title?.trim() || '未命名笔记',
            content: input.content ?? '',
            folderId: input.folderId ?? null,
            isPinned: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const filePath = noteFilePath(note, folders);
          const written = await vaultFiles.writeMarkdown(filePath, { ...note, filePath });
          if (!written) throw new Error('无法创建 Markdown 文件');
          for (let attempt = 0; attempt < 4; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 220));
            try {
              const indexed = await notesApi.get(note.id);
              if (vaultFiles.isAvailable() && indexed.filePath) {
                indexed.content = await vaultFiles.readMarkdown(indexed.filePath) ?? indexed.content;
              }
              setActiveNote(indexed);
              await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
              setGraphStale(true);
              return indexed;
            } catch (error) {
              if (attempt === 3) throw error;
            }
          }
        }
        const note = await notesApi.create(input);
        setActiveNote(note);
        await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
        setGraphStale(true);
        return note;
      } catch (error) {
        handleError(error, '新建笔记失败');
        return null;
      }
    },
    [folders, handleError, refreshNotes, refreshSidebar],
  );

  /**
   * 保存笔记。成功后直接用返回体更新编辑区，省掉一次回读请求。
   * 错误会继续向上抛，让编辑区保留未保存状态并给出内联提示。
   */
  const saveNote = useCallback(
    async (id, patch) => {
      const current = activeNote?.id === id ? activeNote : null;
      if (current && vaultFiles.isAvailable() && current.filePath) {
        const saved = {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        const nextPath = noteFilePath(saved, folders);
        const written = nextPath === current.filePath
          ? await vaultFiles.writeMarkdown(current.filePath, saved)
          : await vaultFiles.moveMarkdown(current.filePath, nextPath, saved);
        if (!written) throw new Error('无法写入 Markdown 文件');
        saved.filePath = nextPath;
        setActiveNote(saved);
        setGraphStale(true);
        await new Promise((resolve) => setTimeout(resolve, 260));
        await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
        return saved;
      }
      try {
        const saved = await notesApi.update(id, patch);
        setActiveNote((current) => (current && current.id === saved.id ? saved : current));
        setGraphStale(true);
        refreshNotes();
        refreshSidebar({ silent: true });
        return saved;
      } catch (error) {
        handleError(error, '保存失败');
        throw error;
      }
    },
    [activeNote, folders, handleError, refreshNotes, refreshSidebar],
  );

  const deleteNote = useCallback(
    async (id) => {
      try {
        const current = activeNote?.id === id ? activeNote : null;
        if (vaultFiles.isAvailable() && current?.filePath) {
          const removed = await vaultFiles.removeMarkdown(current.filePath);
          if (!removed) throw new Error('无法删除 Markdown 文件');
          await new Promise((resolve) => setTimeout(resolve, 260));
        } else {
          await notesApi.remove(id);
        }
        setActiveNote((current) => (current && current.id === id ? null : current));
        setGraphStale(true);
        await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
        toast.success('笔记已删除');
        return true;
      } catch (error) {
        handleError(error, '删除笔记失败');
        return false;
      }
    },
    [activeNote, handleError, refreshNotes, refreshSidebar, toast],
  );

  const duplicateNote = useCallback(
    async (source) => {
      if (!source?.id) return null;
      try {
        // Desktop mode reads the authoritative Markdown before creating the copy.
        // This keeps the duplicate path identical to a normal note creation.
        const detail = await notesApi.get(source.id);
        if (vaultFiles.isAvailable() && detail.filePath) {
          const content = await vaultFiles.readMarkdown(detail.filePath);
          if (content !== null) detail.content = content;
        }
        const base = `${detail.title}（副本）`;
        const existingTitles = new Set(noteIndex.map((note) => note.title));
        let title = base;
        let suffix = 2;
        while (existingTitles.has(title)) {
          title = `${base} ${suffix}`;
          suffix += 1;
        }
        const created = await createNote({
          title,
          content: detail.content ?? '',
          folderId: detail.folderId ?? null,
        });
        if (created) toast.success(`已创建副本「${created.title}」`);
        return created;
      } catch (error) {
        handleError(error, '创建副本失败');
        return null;
      }
    },
    [createNote, handleError, noteIndex, toast],
  );

  const renameNote = useCallback(
    async (id, title) => {
      try {
        const saved = await notesApi.update(id, { title });
        setActiveNote((current) => (current && current.id === id ? { ...current, ...saved } : current));
        await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
        setGraphStale(true);
        return saved;
      } catch (error) {
        handleError(error, '重命名笔记失败');
        return null;
      }
    },
    [handleError, refreshNotes, refreshSidebar],
  );

  const createFolder = useCallback(
    async (name, parentId = null) => {
      try {
        const folder = await foldersApi.create({ name, parentId });
        await refreshSidebar({ silent: true });
        toast.success(`已创建目录「${folder.name}」`);
        return folder;
      } catch (error) {
        handleError(error, '创建目录失败');
        return null;
      }
    },
    [handleError, refreshSidebar, toast],
  );

  const moveFolder = useCallback(
    async (id, parentId) => {
      try {
        await foldersApi.update(id, { parentId });
        await refreshSidebar({ silent: true });
        toast.success(parentId ? '文件夹已移动' : '文件夹已移至根目录');
        return true;
      } catch (error) {
        handleError(error, '移动文件夹失败');
        return false;
      }
    },
    [handleError, refreshSidebar, toast],
  );

  const duplicateFolder = useCallback(
    async (source) => {
      if (!source?.id) return false;
      try {
        const siblingNames = new Set(
          flattenFolderTree(folders)
            .filter((folder) => folder.parentId === source.parentId)
            .map((folder) => folder.name),
        );
        const baseName = `${source.name}（副本）`;
        let name = baseName;
        let suffix = 2;
        while (siblingNames.has(name)) {
          name = `${baseName} ${suffix}`;
          suffix += 1;
        }

        const folderIds = new Map();
        const rootCopy = await foldersApi.create({ name, parentId: source.parentId ?? null });
        folderIds.set(source.id, rootCopy.id);

        const copyChildren = async (original, parentId) => {
          for (const child of original.children ?? []) {
            const copy = await foldersApi.create({ name: child.name, parentId });
            folderIds.set(child.id, copy.id);
            await copyChildren(child, copy.id);
          }
        };
        await copyChildren(source, rootCopy.id);

        for (const note of noteIndex) {
          const targetFolderId = folderIds.get(note.folderId);
          if (!targetFolderId) continue;
          await notesApi.duplicate(note.id, { folderId: targetFolderId });
        }

        setGraphStale(true);
        await Promise.all([refreshSidebar({ silent: true }), refreshNotes()]);
        toast.success(`已创建文件夹副本「${name}」`);
        return true;
      } catch (error) {
        handleError(error, '创建文件夹副本失败');
        return false;
      }
    },
    [folders, handleError, noteIndex, refreshNotes, refreshSidebar, toast],
  );

  const deleteFolder = useCallback(
    async (id) => {
      try {
        const result = await foldersApi.remove(id);
        setFilter((current) => (current.kind === 'folder' && current.folderId === id ? DEFAULT_FILTER : current));
        await Promise.all([refreshSidebar({ silent: true }), refreshNotes()]);
        toast.success(
          result?.affectedNoteCount > 0
            ? `目录已删除，其中 ${result.affectedNoteCount} 篇笔记已移至未分类`
            : '目录已删除',
        );
        return true;
      } catch (error) {
        handleError(error, '删除目录失败');
        return false;
      }
    },
    [handleError, refreshNotes, refreshSidebar, toast],
  );

  const renameFolder = useCallback(
    async (id, name) => {
      try {
        await foldersApi.update(id, { name });
        await refreshSidebar({ silent: true });
        return true;
      } catch (error) {
        handleError(error, '重命名目录失败');
        return false;
      }
    },
    [handleError, refreshSidebar],
  );

  const moveNote = useCallback(
    async (id, folderId) => {
      try {
        const saved = await saveNote(id, { folderId });
        setActiveNote((current) => (current && current.id === id ? saved : current));
        setGraphStale(true);
        return true;
      } catch (error) {
        handleError(error, '移动笔记失败');
        return false;
      }
    },
    [handleError, saveNote],
  );

  const togglePin = useCallback(
    async (note) => {
      try {
        const saved = await saveNote(note.id, { isPinned: !note.isPinned });
        setActiveNote((current) => (current && current.id === saved.id ? saved : current));
        return true;
      } catch (error) {
        handleError(error, '更新置顶状态失败');
        return false;
      }
    },
    [handleError, saveNote],
  );

  const selectFolder = useCallback((folderId) => {
    setFilter({ kind: 'folder', folderId });
    setQuery('');
  }, []);

  const selectTag = useCallback((tagId) => {
    setFilter({ kind: 'tag', tagId });
    setQuery('');
  }, []);

  const clearFilter = useCallback(() => {
    setFilter(DEFAULT_FILTER);
  }, []);

  return {
    // 数据
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

    // 状态设置
    setQuery,
    setSort,
    selectFolder,
    selectTag,
    clearFilter,
    setActiveNote,

    // 动作
    openNote,
    openByTitle,
    createNote,
    saveNote,
    deleteNote,
    duplicateNote,
    renameNote,
    createFolder,
    moveFolder,
    duplicateFolder,
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
  };
}
