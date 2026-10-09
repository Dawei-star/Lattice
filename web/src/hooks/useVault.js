/**
 * 知识库中心状态。
 *
 * 职责：把后端的资源接口收敛成一个可用的数据模型，并统一处理
 * 加载态、错误提示、连接状态与缓存失效。组件只消费这里暴露的状态与动作，
 * 不直接调用 API 层，也不自己拼查询参数。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, BASE_URL } from '../api/client.js';
import { canvasApi } from '../api/canvas.js';
import { foldersApi, graphApi, metaApi, notesApi, searchApi, tagsApi } from '../api/resources.js';
import { vaultApi } from '../api/vault.js';
import { noteFilePath, uniqueNoteFilePath, vaultAttachmentsApi, vaultFiles } from '../api/vault-files.js';
import { createSseTicket, getWorkspaceAccessToken } from '../api/workspace-auth.js';
import { useDebouncedValue } from './useDebouncedValue.js';
import { useToast } from './useToast.jsx';

const DEFAULT_FILTER = { kind: 'all', folderId: null, tagId: null, inboxStatus: null };
const DEFAULT_VAULT_PROFILE = Object.freeze({
  version: 1,
  paths: Object.freeze({ inbox: 'Inbox', daily: 'Daily', journal: 'Journal' }),
});
const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 280;

/** 未分类笔记在查询里的特殊标记，与后端约定一致 */
const UNFILED = '__none__';
const DEFAULT_CANVAS_PATH = '画板.canvas';

function flattenFolderTree(nodes, result = []) {
  for (const node of nodes ?? []) {
    result.push(node);
    flattenFolderTree(node.children, result);
  }
  return result;
}

function ensureDefaultCanvas(files) {
  const normalized = Array.isArray(files) ? files : [];
  if (normalized.length > 0) return normalized;
  return [
    ...normalized,
    { path: DEFAULT_CANVAS_PATH, name: DEFAULT_CANVAS_PATH, folderPath: '', exists: false },
  ];
}

function nextCanvasPath(files, folderPath = '') {
  const normalizedFolder = String(folderPath ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const existing = new Set((files ?? []).map((file) => String(file?.path ?? '')));
  let suffix = 0;
  let candidate;
  do {
    const name = suffix === 0 ? '未命名.canvas' : `未命名 ${suffix + 1}.canvas`;
    candidate = normalizedFolder ? `${normalizedFolder}/${name}` : name;
    suffix += 1;
  } while (existing.has(candidate));
  return candidate;
}

function normalizeNoteFilePath(value) {
  return String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function normalizeVaultProfile(value) {
  const paths = value?.paths ?? {};
  const normalizePath = (candidate, fallback) => {
    if (typeof candidate !== 'string') return fallback;
    const normalized = candidate.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    return normalized && !normalized.split('/').some((part) => !part || part === '.' || part === '..')
      ? normalized
      : fallback;
  };
  return {
    version: 1,
    paths: {
      inbox: normalizePath(paths.inbox, DEFAULT_VAULT_PROFILE.paths.inbox),
      daily: normalizePath(paths.daily, DEFAULT_VAULT_PROFILE.paths.daily),
      journal: normalizePath(paths.journal, DEFAULT_VAULT_PROFILE.paths.journal),
    },
  };
}

/** 附件按其真实所在目录归位（attachments/、attachments/笔记标题/ 或笔记旁的任意目录），与目录树路径对齐。 */
function normalizeAttachmentFiles(files) {
  return (Array.isArray(files) ? files : []).map((file) => {
    const path = String(file?.path ?? '').replaceAll('\\', '/');
    const separator = path.lastIndexOf('/');
    const folderPath = separator === -1 ? '' : path.slice(0, separator);
    return { ...file, folderPath };
  });
}

export function useVault({ requestFileConfirmation } = {}) {
  const toast = useToast();

  const [folders, setFolders] = useState([]);
  const [profile, setProfile] = useState(DEFAULT_VAULT_PROFILE);
  const [vaultDir, setVaultDir] = useState('');
  const [tags, setTags] = useState([]);
  const [overview, setOverview] = useState(null);
  const [noteIndex, setNoteIndex] = useState([]);
  const [canvasFiles, setCanvasFiles] = useState([]);
  const [attachmentFiles, setAttachmentFiles] = useState([]);

  const [filter, setFilter] = useState(DEFAULT_FILTER);
  const [sort, setSort] = useState('updated');
  const [notes, setNotes] = useState([]);
  const [notesTotal, setNotesTotal] = useState(0);
  const [page, setPage] = useState(0);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [search, setSearch] = useState({ loading: false, items: [], strategy: '', query: '' });

  const [activeNote, setActiveNote] = useState(null);
  const [graph, setGraph] = useState(null);
  const [graphStale, setGraphStale] = useState(true);
  const [loading, setLoading] = useState({ sidebar: true, notes: true, note: false, graph: false });
  const [connectionDown, setConnectionDown] = useState(false);
  const [workspaceToken, setWorkspaceToken] = useState(() => getWorkspaceAccessToken());
  const [vaultChangeRevision, setVaultChangeRevision] = useState(0);

  /** 编辑器未保存内容的重载保护：切换笔记前由编辑区注册拦截器 */
  const navigationGuard = useRef(null);
  const openRequest = useRef(0);
  const listRequestIdRef = useRef(0);
  const sseConnectedRef = useRef(false);
  const activeNoteRef = useRef(activeNote);
  const noteMutationQueuesRef = useRef(new Map());

  // refreshNotes 的身份随 filter/page/sort 变化，openNote 又依赖它：
  // SSE 订阅 effect 若直接依赖两者，每次筛选/翻页都会断流重连（token 模式
  // 重连窗口内还会丢事件）。这里用 ref 持有最新版本，订阅本身保持稳定。
  // （二者此时尚未定义，只能先置空，渲染完成后由下方 effect 回填）
  const refreshNotesRef = useRef(null);
  const openNoteRef = useRef(null);

  useEffect(() => {
    activeNoteRef.current = activeNote;
  }, [activeNote]);

  useEffect(() => {
    const syncWorkspaceToken = () => setWorkspaceToken(getWorkspaceAccessToken());
    window.addEventListener('lattice:ai-settings-change', syncWorkspaceToken);
    return () => window.removeEventListener('lattice:ai-settings-change', syncWorkspaceToken);
  }, []);

  const handleError = useCallback(
    (error, fallbackMessage) => {
      if (error?.name === 'AbortError') return;

      if (error instanceof ApiError) {
        if (error.isOffline || error.isTimeout) {
          setConnectionDown(true);
          toast.error(error.message, {
            dedupeKey: `api-connectivity:${error.code}`,
          });
          return;
        }
        toast.error(error.message, {
          detail: error.requestId ? `请求编号 ${error.requestId}` : undefined,
          // Initial load fans out to several endpoints. A shared server failure must
          // remain one actionable notice rather than covering the workspace in copies.
          dedupeKey: `api-error:${error.status}:${error.code}`,
        });
        return;
      }

      toast.error(fallbackMessage ?? '操作失败，请重试');
      // 非预期异常保留在控制台，便于排查
      console.error('[lattice] 未预期的错误', error);
    },
    [toast],
  );

  const confirmFileOperation = useCallback(async (operation) => {
    if (typeof requestFileConfirmation !== 'function') {
      throw new Error('文件操作确认组件未挂载，已阻止本次写入');
    }
    const result = await requestFileConfirmation({ ...operation, vaultDir });
    return result?.confirmed === true
      ? { confirmed: true, secondConfirmed: result.secondConfirmed === true }
      : null;
  }, [requestFileConfirmation, vaultDir]);

  // ── 数据加载 ────────────────────────────────────────────────────
  // scope: 'all' = 完整侧栏（含画布/附件全库扫描/vault 信息）；
  // 'notes' = 只刷 folders/tags/overview/index。SSE 笔记级事件走 'notes'：
  // 附件与画布文件不会被 .md watcher 事件改变，全库附件扫描没必要每次跑。
  const refreshSidebar = useCallback(
    async ({ silent = false, scope = 'all' } = {}) => {
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
        if (scope === 'notes') {
          setConnectionDown(false);
          return;
        }
        const vaultInfo = await vaultApi.info().catch(() => null);
        setVaultDir(vaultInfo?.vaultDir ?? '');
        setProfile(normalizeVaultProfile(vaultInfo?.profile));
        try {
          setCanvasFiles(ensureDefaultCanvas(await canvasApi.list()));
        } catch (error) {
          // An older bundled backend may not provide this optional list endpoint.
          // Keep the default canvas usable while the package is updated as one unit.
          setCanvasFiles(ensureDefaultCanvas([]));
          if (!(error instanceof ApiError && error.status === 404)) {
            handleError(error, '加载画布文件列表失败');
          }
        }
        try {
          // 优先用全库扫描接口（attachments/ 之外的任意文件夹也算），
          // 旧版后端没有该接口时回退到仅列 attachments/ 目录。
          let files;
          try {
            files = await vaultAttachmentsApi.listAll();
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
            files = await vaultAttachmentsApi.list();
          }
          setAttachmentFiles(normalizeAttachmentFiles(files));
        } catch (error) {
          // 附件列举失败不应拖垮侧边栏，静默降级为空列表。
          setAttachmentFiles([]);
          handleError(error, '加载附件列表失败');
        }
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
    // 请求序号防竞态：快速切换目录/排序/翻页时，旧请求晚到会覆盖新筛选的结果
    const requestId = ++listRequestIdRef.current;
    setLoading((current) => ({ ...current, notes: true }));
    try {
      const params = { sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
      if (filter.kind === 'folder') params.folderId = filter.folderId ?? UNFILED;
      if (filter.kind === 'tag') params.tagId = filter.tagId;
      if (filter.kind === 'inbox') params.inboxStatus = filter.inboxStatus ?? 'all';

      const result = await notesApi.list(params);
      if (requestId !== listRequestIdRef.current) return;
      setNotes(result.items);
      setNotesTotal(result.total);
      setConnectionDown(false);
    } catch (error) {
      if (requestId !== listRequestIdRef.current) return;
      handleError(error, '加载笔记列表失败');
    } finally {
      if (requestId === listRequestIdRef.current) {
        setLoading((current) => ({ ...current, notes: false }));
      }
    }
  }, [filter, page, sort, handleError]);

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(0, Math.ceil(notesTotal / PAGE_SIZE) - 1)));
  }, [notesTotal]);

  const setSortOrder = useCallback((nextSort) => {
    setSort(nextSort);
    setPage(0);
  }, []);

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
    const searchInboxStatus = filter.kind === 'inbox' ? (filter.inboxStatus ?? 'all') : undefined;

    searchApi
      .query(keyword, { limit: 40, folderId: searchFolderId, inboxStatus: searchInboxStatus })
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
  }, [debouncedQuery, filter.folderId, filter.inboxStatus, filter.kind, handleError]);

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

  // 无副作用探针：编辑器报告"当前是否有未保存草稿"，供 SSE 外部更新
  // 决定是否自动刷新（有草稿时自动刷新会静默覆盖外部修改或本地草稿）
  const dirtyProbe = useRef(null);
  const registerDirtyProbe = useCallback((probe) => {
    dirtyProbe.current = probe;
  }, []);
  const hasUnsavedChanges = useCallback(() => dirtyProbe.current?.() === true, []);

  /** 返回 true 允许切换；返回 false 表示被拦下（守卫返回 false，通常因未保存内容） */
  const confirmNavigation = useCallback(() => {
    const guard = navigationGuard.current;
    if (typeof guard !== 'function') return true;
    return guard() !== false;
  }, []);

  const openNote = useCallback(
    async (id) => {
      const requestId = ++openRequest.current;
      if (!id) {
        setActiveNote(null);
        return null;
      }
      setLoading((current) => ({ ...current, note: true }));
      try {
        const note = await notesApi.get(id);
        if (vaultFiles.isAvailable() && note.filePath) {
          try {
            const content = await vaultFiles.readMarkdown(note.filePath);
            if (content !== null) note.content = content;
          } catch {
            // 盘上文件刚被外部删除而索引未更新时读盘会抛错：
            // 回退 API 返回的投影内容，笔记本身仍然可读
          }
        }
        if (requestId !== openRequest.current) return null;
        setActiveNote(note);
        setConnectionDown(false);
        return note;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          if (requestId !== openRequest.current) return null;
          setActiveNote(null);
          toast.info('这篇笔记已经不存在了，列表已刷新');
          refreshNotes();
          refreshSidebar({ silent: true });
        } else {
          handleError(error, '打开笔记失败');
        }
        return null;
      } finally {
        if (requestId === openRequest.current) setLoading((current) => ({ ...current, note: false }));
      }
    },
    [handleError, refreshNotes, refreshSidebar, toast],
  );

  useEffect(() => {
    refreshNotesRef.current = refreshNotes;
    openNoteRef.current = openNote;
  });

  /** 按标题打开；标题不存在时返回 null，由调用方决定是否创建 */
  const findNoteByFilePath = useCallback(
    async (filePath) => {
      const expectedPath = normalizeNoteFilePath(filePath);
      if (!expectedPath) return null;

      let lastError = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          const index = await notesApi.index();
          setNoteIndex(index ?? []);
          const match = (index ?? []).find((entry) => normalizeNoteFilePath(entry.filePath) === expectedPath);
          if (match) {
            void refreshSidebar({ silent: true });
            return match;
          }
        } catch (error) {
          lastError = error;
          break;
        }
        if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 180));
      }

      if (lastError) handleError(lastError, '打开外部 Markdown 文件失败');
      return null;
    },
    [handleError, refreshSidebar],
  );

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
            properties: input.properties ?? {},
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const filePath = uniqueNoteFilePath(note, folders, noteIndex);
          const confirmation = await confirmFileOperation({
            type: 'create',
            path: filePath,
            contentSummary: `创建 Markdown 笔记「${note.title}」，正文约 ${String(note.content).length} 个字符`,
            impact: '新增 1 个 Markdown 文件，并等待索引同步',
          });
          if (!confirmation) return null;
          const written = await vaultFiles.writeMarkdown(filePath, { ...note, filePath }, confirmation);
          if (!written) throw new Error('无法创建 Markdown 文件');
          for (let attempt = 0; attempt < 4; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 220));
            try {
              const indexed = await notesApi.get(note.id);
              if (vaultFiles.isAvailable() && indexed.filePath) {
                indexed.content = await vaultFiles.readMarkdown(indexed.filePath) ?? indexed.content;
              }
              // 不在这里 setActiveNote：调用方会经 openInTab（先过未保存守卫）打开，
              // 提前激活会把旧笔记的草稿顶掉，守卫即使弹出「取消」也无法恢复
              await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
              setGraphStale(true);
              return indexed;
            } catch (error) {
              if (attempt === 3) throw error;
            }
          }
        }
        const filePath = uniqueNoteFilePath({
          id: input.id,
          title: input.title?.trim() || '未命名笔记',
          folderId: input.folderId ?? null,
        }, folders, noteIndex);
        const confirmation = await confirmFileOperation({
          type: 'create',
          path: filePath,
          contentSummary: `创建 Markdown 笔记「${input.title?.trim() || '未命名笔记'}」`,
          impact: '新增 1 个 Markdown 文件，并更新知识库索引',
        });
        if (!confirmation) return null;
        const note = await notesApi.create({ ...input, ...confirmation });
        // 同桌面分支：激活交给调用方的 openInTab，避免顶掉未保存的草稿
        await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
        setGraphStale(true);
        return note;
      } catch (error) {
        handleError(error, '新建笔记失败');
        return null;
      }
    },
    [confirmFileOperation, folders, handleError, noteIndex, refreshNotes, refreshSidebar],
  );

  /** 保存后即时更新列表中的对应行；与服务器/磁盘的完整同步交给 SSE 驱动的刷新 */
  const patchNoteListItem = useCallback((saved) => {
    if (!saved?.id) return;
    setNotes((current) => current.map((item) => (
      item.id === saved.id
        ? { ...item, title: saved.title ?? item.title, filePath: saved.filePath ?? item.filePath, updatedAt: saved.updatedAt ?? item.updatedAt }
        : item
    )));
  }, []);

  // Keep mutations for one note ordered so a rename cannot be followed by an
  // older autosave that still targets the previous file path.
  const enqueueNoteMutation = useCallback((id, operation) => {
    const previous = noteMutationQueuesRef.current.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    noteMutationQueuesRef.current.set(id, next);
    next.then(
      () => {
        if (noteMutationQueuesRef.current.get(id) === next) noteMutationQueuesRef.current.delete(id);
      },
      () => {
        if (noteMutationQueuesRef.current.get(id) === next) noteMutationQueuesRef.current.delete(id);
      },
    );
    return next;
  }, []);

  /**
   * 保存笔记。成功后直接用返回体更新编辑区，省掉一次回读请求。
   * 错误会继续向上抛，让编辑区保留未保存状态并给出内联提示。
   *
   * 保存后的列表/侧栏同步交给 SSE（watcher 投影完成后会带 80ms 去抖广播，
   * useVault 的事件订阅统一刷新），这里只做即时的本地行内更新，
   * 不再人为等待 + 全量刷新——否则连续自动保存就是每秒十几个请求的风暴。
   */
  const saveNote = useCallback(
    (id, patch) => enqueueNoteMutation(id, async () => {
      const current = activeNoteRef.current?.id === id ? activeNoteRef.current : null;
      const nextPatch = { ...patch };

      // A queued autosave may have been prepared before a rename completed.
      // Keep its content/properties, but do not let its stale title or version
      // move the note back to the old path.
      if (
        current
        && nextPatch.title !== undefined
        && nextPatch.expectedHash
        && current.contentHash
        && nextPatch.expectedHash !== current.contentHash
      ) {
        delete nextPatch.title;
        nextPatch.expectedHash = current.contentHash;
      }
      if (current && vaultFiles.isAvailable() && current.filePath) {
        // 桌面模式与 API 的 expectedHash 对齐：落盘前回读磁盘内容比对，
        // 防止外部编辑器的修改被旧草稿静默覆盖（与 API 分支的 409 同形，
        // EditorPane 据此展示冲突横幅；patch 不带 expectedHash 即「仍要保存」的显式覆盖）
        if (nextPatch.expectedHash) {
          const diskContent = await vaultFiles.readMarkdown(current.filePath);
          if (diskContent !== null && diskContent !== current.content) {
            const conflict = new Error('笔记已被外部程序修改，已拦截本次保存以避免覆盖外部改动');
            conflict.status = 409;
            conflict.code = 'CONFLICT';
            throw conflict;
          }
        }
        const saved = {
          ...current,
          ...nextPatch,
          updatedAt: new Date().toISOString(),
        };
        const pathChanged = saved.title !== current.title || saved.folderId !== current.folderId;
        const nextPath = pathChanged
          ? uniqueNoteFilePath(saved, folders, noteIndex)
          : current.filePath ?? noteFilePath(saved, folders);
        // 普通覆盖是编辑器的正常保存，不需要阻塞式确认；改变标题或目录会改变
        // 磁盘路径，仍作为高风险的移动/重命名操作单独确认。
        const confirmation = pathChanged
          ? await confirmFileOperation({
            type: 'move',
            path: current.filePath ?? nextPath,
            targetPath: nextPath,
            contentSummary: `将「${current.filePath}」移动到「${nextPath}」并更新正文`,
            impact: '改变文件路径并更新 1 篇笔记的索引',
          })
          : {};
        if (pathChanged && !confirmation) throw new Error('用户取消了文件操作');
        const written = nextPath === current.filePath
          ? await vaultFiles.writeMarkdown(current.filePath, saved, confirmation)
          : await vaultFiles.moveMarkdown(current.filePath, nextPath, saved, confirmation);
        if (!written) throw new Error('无法写入 Markdown 文件');
        saved.filePath = nextPath;
        activeNoteRef.current = saved;
        setActiveNote(saved);
        setGraphStale(true);
        patchNoteListItem(saved);
        return saved;
      }
      try {
        const pathChanged = nextPatch.title !== undefined || nextPatch.folderId !== undefined;
        const confirmation = pathChanged
          ? await confirmFileOperation({
            type: 'move',
            path: current?.filePath ?? `${id}.md`,
            contentSummary: '更新笔记标题或目录归属，并同步调整文件路径',
            impact: '改变 1 篇笔记的文件路径并更新索引',
          })
          : {};
        if (pathChanged && !confirmation) throw new Error('用户取消了文件操作');
        const saved = await notesApi.update(id, { ...nextPatch, ...confirmation });
        activeNoteRef.current = activeNoteRef.current?.id === saved.id
          ? { ...activeNoteRef.current, ...saved }
          : activeNoteRef.current;
        setActiveNote((current) => (current && current.id === saved.id ? saved : current));
        setGraphStale(true);
        patchNoteListItem(saved);
        // SSE 未连接时兜底刷一次列表，保证标题/路径变化立即可见
        if (!sseConnectedRef.current) refreshNotes();
        return saved;
      } catch (error) {
        handleError(error, '保存失败');
        throw error;
      }
    }),
    [confirmFileOperation, enqueueNoteMutation, folders, handleError, noteIndex, patchNoteListItem, refreshNotes],
  );

  const deleteNote = useCallback(
    async (id) => {
      try {
        const current = activeNote?.id === id ? activeNote : null;
        let deletedOnDisk = false;
        const confirmation = await confirmFileOperation({
          type: 'delete',
          path: current?.filePath ?? `${id}.md`,
          contentSummary: `删除笔记「${current?.title ?? id}」及其 Markdown 文件`,
          impact: '移除 1 个 Markdown 文件；已生成快照，可在操作历史中撤销',
          reversible: true,
          requiresSecondConfirmation: true,
        });
        if (!confirmation) return false;
        if (vaultFiles.isAvailable() && current?.filePath) {
          const removed = await vaultFiles.removeMarkdown(current.filePath, confirmation);
          if (!removed) throw new Error('无法删除 Markdown 文件');
          deletedOnDisk = true;
        } else {
          await notesApi.remove(id, { body: confirmation, retries: 0 });
        }
        setActiveNote((current) => (current && current.id === id ? null : current));
        setGraphStale(true);
        if (deletedOnDisk && sseConnectedRef.current) {
          // 桌面模式：watcher 完成投影后 SSE 会驱动一次 notes 范围的刷新。
          // 此时立即刷新大概率拉到删除前的索引，已删笔记会在列表里短暂
          // 「复活」到下一轮 SSE 才被纠正——信任 SSE 即可（断线时走下面的兜底）
        } else {
          await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
        }
        toast.success('笔记已删除');
        return true;
      } catch (error) {
        handleError(error, '删除笔记失败');
        return false;
      }
    },
    [activeNote, confirmFileOperation, handleError, refreshNotes, refreshSidebar, toast],
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
        const saved = await saveNote(id, { title });
        await Promise.all([refreshNotes(), refreshSidebar({ silent: true })]);
        setGraphStale(true);
        return saved;
      } catch (error) {
        handleError(error, '重命名笔记失败');
        return null;
      }
    },
    [handleError, refreshNotes, refreshSidebar, saveNote],
  );

  const createFolder = useCallback(
    async (name, parentId = null) => {
      try {
        const confirmation = await confirmFileOperation({
          type: 'mkdir',
          path: name,
          contentSummary: `创建目录「${name}」`,
          impact: '新增 1 个目录，后续笔记可移动到该目录',
        });
        if (!confirmation) return null;
        const folder = await foldersApi.create({ name, parentId, ...confirmation });
        await refreshSidebar({ silent: true });
        toast.success(`已创建目录「${folder.name}」`);
        return folder;
      } catch (error) {
        handleError(error, '创建目录失败');
        return null;
      }
    },
    [confirmFileOperation, handleError, refreshSidebar, toast],
  );

  const moveFolder = useCallback(
    async (id, parentId) => {
      try {
        const confirmation = await confirmFileOperation({
          type: 'move',
          path: `folder:${id}`,
          contentSummary: '移动目录及其下属笔记文件',
          impact: '可能移动多个 Markdown 文件，并更新它们的索引路径',
        });
        if (!confirmation) return false;
        await foldersApi.update(id, { parentId, ...confirmation });
        await refreshSidebar({ silent: true });
        toast.success(parentId ? '文件夹已移动' : '文件夹已移至根目录');
        return true;
      } catch (error) {
        handleError(error, '移动文件夹失败');
        return false;
      }
    },
    [confirmFileOperation, handleError, refreshSidebar, toast],
  );

  // 外部编辑器、同步软件和文件管理器都会直接改变 Vault。watcher 完成
  // 投影后通过 SSE 通知这里，避免界面继续展示已经不存在的旧投影。
  useEffect(() => {
    const EventSourceCtor = window.EventSource ?? globalThis.EventSource;
    if (typeof EventSourceCtor !== 'function') return undefined;

    let source = null;
    let disposed = false;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let refreshTimer = null;
    let refreshInFlight = false;

    // 刷新在途时新到达的请求合并为一次「补跑」：既不并发重入（会有状态竞争），
    // 也不丢弃（否则刷新期间到达的最后一条变更会被吞掉，界面停留旧数据）。
    // 范围合并取更宽的一侧：notes 事件合并到 all 时按 all 补跑。
    let refreshPendingScope = null;
    const runRefresh = async (scope = 'all') => {
      refreshInFlight = true;
      try {
        await Promise.all([refreshNotesRef.current(), refreshSidebar({ silent: true, scope })]);
      } finally {
        refreshInFlight = false;
        if (refreshPendingScope) {
          const nextScope = refreshPendingScope;
          refreshPendingScope = null;
          void runRefresh(nextScope);
        }
      }
    };

    const refreshFromVault = (scope = 'all') => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (refreshInFlight) {
          refreshPendingScope = refreshPendingScope === 'all' || scope === 'all' ? 'all' : 'notes';
          return;
        }
        void runRefresh(scope);
      }, 80);
    };

    const handleMessage = (message) => {
      let change;
      try {
        change = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!change || change.action === 'ready') return;
      // 服务端已过滤 skipped/absent，这里防御性兜底：投影未变化的事件不值得
      // 触发一轮全量刷新
      if (change.action === 'skipped' || change.action === 'absent') return;

      if (change.action === 'reconciled') {
        // 目录级差量对齐：无实际变化（纯启动对齐）时不刷；有变化时可能涉及
        // 目录增删，按完整范围刷
        const changed = (change.added ?? 0) + (change.updated ?? 0) + (change.removed ?? 0);
        if (!changed) return;
        setGraphStale(true);
        setVaultChangeRevision((value) => value + 1);
        refreshFromVault('all');
        return;
      }

      const current = activeNoteRef.current;
      const currentFile = current?.filePath ? String(current.filePath).replaceAll('\\', '/') : null;
      const changeFile = change.file ? String(change.file).replaceAll('\\', '/') : null;
      const touchesCurrentNote = Boolean(current) && (current.id === change.id || (currentFile && changeFile && currentFile === changeFile));
      if (change.action === 'removed' && touchesCurrentNote) {
        openRequest.current += 1;
        activeNoteRef.current = null;
        setActiveNote(null);
        toast.info('当前笔记已从本地文件夹删除，界面已同步');
      } else if (change.action === 'updated' && touchesCurrentNote) {
        if (hasUnsavedChanges()) {
          toast.info('笔记已被外部程序修改；当前有未保存的草稿，已保留你的编辑，可手动保存覆盖');
        } else {
          openNoteRef.current?.(current.id);
        }
      }
      // 笔记级事件只刷核心数据（folders/tags/overview/index），跳过画布与
      // 附件的全库扫描——自动保存风暴从每秒十几个请求降到四个
      setGraphStale(true);
      // 事件是在 SQLite 投影完成后发布的，Review 可以安全地重新读取当前事实。
      setVaultChangeRevision((value) => value + 1);
      refreshFromVault('notes');
    };

    // 无令牌（默认本机模式）：直连，EventSource 自带断线重连
    if (!workspaceToken) {
      const eventsUrl = new URL(`${BASE_URL}/vault/events`, window.location.origin);
      source = new EventSourceCtor(eventsUrl.toString());
      source.onopen = () => {
        sseConnectedRef.current = true;
        refreshFromVault();
      };
      source.onerror = () => {
        sseConnectedRef.current = false;
      };
      source.onmessage = handleMessage;
      return () => {
        disposed = true;
        clearTimeout(refreshTimer);
        source?.close();
      };
    }

    // 配置了工作区令牌：长期令牌不进 URL，先换取一次性短时票据再开流；
    // 票据核销后 EventSource 的自动重连必然 401，因此出错时手动关闭、
    // 换新票据重连（指数退避）
    const connect = async () => {
      if (disposed) return;
      try {
        const ticket = await createSseTicket();
        if (disposed) return;
        if (!ticket?.ticket) throw new Error('事件流票据获取失败');
        const eventsUrl = new URL(`${BASE_URL}/vault/events`, window.location.origin);
        eventsUrl.searchParams.set('sseTicket', ticket.ticket);
        source = new EventSourceCtor(eventsUrl.toString());
        source.onopen = () => {
          sseConnectedRef.current = true;
          reconnectAttempts = 0;
          refreshFromVault();
        };
        source.onmessage = handleMessage;
        source.onerror = () => {
          sseConnectedRef.current = false;
          if (disposed) return;
          source?.close();
          source = null;
          reconnectAttempts += 1;
          reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempts, 15_000));
        };
      } catch {
        if (disposed) return;
        reconnectTimer = setTimeout(connect, 5_000);
      }
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [hasUnsavedChanges, refreshSidebar, toast, workspaceToken]);

  const moveCanvas = useCallback(
    async (fromPath, toPath) => {
      try {
        const confirmation = await confirmFileOperation({
          type: 'move',
          path: fromPath,
          targetPath: toPath,
          contentSummary: `移动画布「${fromPath}」到「${toPath}」`,
          impact: '改变 1 个 Canvas 文件的路径',
        });
        if (!confirmation) return false;
        await canvasApi.move(fromPath, toPath, confirmation);
        await refreshSidebar({ silent: true });
        return true;
      } catch (error) {
        handleError(error, '移动画布文件失败');
        return false;
      }
    },
    [confirmFileOperation, handleError, refreshSidebar],
  );

  const renameCanvas = useCallback(
    async (fromPath, toPath) => {
      try {
        const confirmation = await confirmFileOperation({
          type: 'rename',
          path: fromPath,
          targetPath: toPath,
          contentSummary: `重命名 Canvas 文件为「${toPath}」`,
          impact: '改变 1 个 Canvas 文件的路径',
        });
        if (!confirmation) return false;
        await canvasApi.rename(fromPath, toPath, confirmation);
        await refreshSidebar({ silent: true });
        return true;
      } catch (error) {
        handleError(error, '重命名画布失败');
        return false;
      }
    },
    [confirmFileOperation, handleError, refreshSidebar],
  );

  const deleteCanvas = useCallback(
    async (filePath) => {
      try {
        const confirmation = await confirmFileOperation({
          type: 'delete',
          path: filePath,
          contentSummary: `删除 Canvas 文件「${filePath}」`,
          impact: '移除 1 个 Canvas 文件；已生成快照，可撤销',
          requiresSecondConfirmation: true,
        });
        if (!confirmation) return false;
        await canvasApi.remove(filePath, confirmation);
        await refreshSidebar({ silent: true });
        return true;
      } catch (error) {
        handleError(error, '删除画布失败');
        return false;
      }
    },
    [confirmFileOperation, handleError, refreshSidebar],
  );

  const createCanvas = useCallback(
    async (folderPath = '') => {
      const filePath = nextCanvasPath(canvasFiles, folderPath);
      try {
        const confirmation = await confirmFileOperation({
          type: 'create',
          path: filePath,
          contentSummary: `创建空白 Canvas「${filePath}」`,
          impact: '新增 1 个 Canvas 文件',
        });
        if (!confirmation) return null;
        await canvasApi.save(filePath, { nodes: [], edges: [], ...confirmation });
        await refreshSidebar({ silent: true });
        return filePath;
      } catch (error) {
        handleError(error, '新建白板失败');
        return null;
      }
    },
    [canvasFiles, confirmFileOperation, handleError, refreshSidebar],
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
         const rootCopy = await createFolder(name, source.parentId ?? null);
         if (!rootCopy) return false;
        folderIds.set(source.id, rootCopy.id);

        const copyChildren = async (original, parentId) => {
          for (const child of original.children ?? []) {
             const copy = await createFolder(child.name, parentId);
             if (!copy) return;
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
    [createFolder, folders, handleError, noteIndex, refreshNotes, refreshSidebar, toast],
  );

  const deleteFolder = useCallback(
    async (id) => {
      try {
        const confirmation = await confirmFileOperation({
          type: 'delete',
          path: `folder:${id}`,
          contentSummary: '删除目录；目录下的笔记会移至未分类，相关文件可能被移动',
          impact: '影响目录及其下属笔记路径，操作可撤销但需核对结果',
          requiresSecondConfirmation: true,
        });
        if (!confirmation) return false;
        const result = await foldersApi.remove(id, { body: confirmation, retries: 0 });
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
    [confirmFileOperation, handleError, refreshNotes, refreshSidebar, toast],
  );

  const renameFolder = useCallback(
    async (id, name) => {
      try {
        const confirmation = await confirmFileOperation({
          type: 'rename',
          path: `folder:${id}`,
          targetPath: name,
          contentSummary: `重命名目录为「${name}」，同步更新其下笔记路径`,
          impact: '可能移动多个 Markdown 文件，并更新索引路径',
        });
        if (!confirmation) return false;
        await foldersApi.update(id, { name, ...confirmation });
        await refreshSidebar({ silent: true });
        return true;
      } catch (error) {
        handleError(error, '重命名目录失败');
        return false;
      }
    },
    [confirmFileOperation, handleError, refreshSidebar],
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

  const updateInboxStatus = useCallback(
    async (note, status) => {
      if (!note?.id || !['captured', 'processing', 'processed'].includes(status)) return false;
      try {
        const saved = await saveNote(note.id, {
          properties: { ...(note.properties ?? {}), type: 'inbox', status },
        });
        setActiveNote((current) => (current && current.id === saved.id ? saved : current));
        toast.success(status === 'processed' ? 'Inbox 内容已标记为已处理' : 'Inbox 状态已更新');
        return true;
      } catch (error) {
        handleError(error, '更新 Inbox 状态失败');
        return false;
      }
    },
    [handleError, saveNote, toast],
  );

  const archiveInboxNote = useCallback(
    async (note, folderId) => {
      if (!note?.id || folderId === undefined) return false;
      try {
        const properties = { ...(note.properties ?? {}), status: 'processed' };
        delete properties.type;
        const saved = await saveNote(note.id, { folderId, properties });
        setActiveNote((current) => (current && current.id === saved.id ? saved : current));
        toast.success('内容已归档到项目');
        return true;
      } catch (error) {
        handleError(error, '归档 Inbox 内容失败');
        return false;
      }
    },
    [handleError, saveNote, toast],
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
    setPage(0);
    setQuery('');
  }, []);

  const selectTag = useCallback((tagId) => {
    setFilter({ kind: 'tag', tagId });
    setPage(0);
    setQuery('');
  }, []);

  const selectInbox = useCallback((status = 'all') => {
    setFilter({ kind: 'inbox', folderId: null, tagId: null, inboxStatus: status });
    setPage(0);
    setQuery('');
  }, []);

  const clearFilter = useCallback(() => {
    setFilter(DEFAULT_FILTER);
    setPage(0);
  }, []);

  return {
    // 数据
    folders,
    profile,
    vaultDir,
    tags,
    overview,
    notes,
    notesTotal,
    page,
    pageCount: Math.max(1, Math.ceil(notesTotal / PAGE_SIZE)),
    noteIndex,
    canvasFiles,
    attachmentFiles,
    activeNote,
    graph,
    graphStale,
    search,
    filter,
    sort,
    query,
    loading,
    connectionDown,
    vaultChangeRevision,

    // 状态设置
    setQuery,
    setSort: setSortOrder,
    setPage,
    selectFolder,
    selectTag,
    selectInbox,
    clearFilter,
    setActiveNote,

    // 动作
    openNote,
    findNoteByFilePath,
    openByTitle,
    createNote,
    saveNote,
    deleteNote,
    duplicateNote,
    renameNote,
    createFolder,
    moveFolder,
    moveCanvas,
    renameCanvas,
    deleteCanvas,
    createCanvas,
    duplicateFolder,
    renameFolder,
    deleteFolder,
    moveNote,
    updateInboxStatus,
    archiveInboxNote,
    togglePin,
    resolveTitle,
    refreshNotes,
    refreshSidebar,
    refreshGraph,
    registerNavigationGuard,
    registerDirtyProbe,
    confirmNavigation,
  };
}
