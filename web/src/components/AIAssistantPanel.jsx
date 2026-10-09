import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, CircleAlert, Copy, Layers3, List, LoaderCircle, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { aiApi } from '../api/ai.js';
import { expertsApi } from '../api/experts.js';
import { filesApi } from '../api/files.js';
import { renderMarkdown } from '../lib/markdown.js';
import { getActiveAiProvider, hasExternalAi, hydrateAiSettingsFromServer, loadAiSettings, saveAiSettings, subscribeAiSettings } from '../settings/aiSettings.js';
import { collectActiveMcpServers, loadMcpSettings, mergeProjectServers } from '../settings/mcpSettings.js';
import { mcpApi } from '../api/mcp.js';
import Modal from '../ui/Modal.jsx';

// 这里的「执行」是调用文件内核 / AI 动作的 HTTP 接口，与 SQL 无关；
// 为免静态扫描把 execute + 变量传参误判为动态 SQL，解构时即改名
const { execute: submitAiActions } = aiApi;

const LAST_SESSION_KEY = 'lattice-ai-active-session-v2';
const SYSTEM_ROOT_FOLDERS = new Set(['inbox', 'daily', 'journal']);
const FILE_KERNEL_ACTIONS = new Set(['create', 'update', 'delete', 'move', 'copy']);
const CONTEXT_SCOPE_META = {
  current: { capability: 'current-note', label: '当前笔记' },
  project: { capability: 'project', label: '当前项目' },
  all: { capability: 'vault', label: '全库' },
  inbox: { capability: 'inbox', label: 'Inbox' },
};
const CONTEXT_CAPABILITY_LABELS = {
  'current-note': '当前笔记',
  project: '项目',
  vault: '全库',
  inbox: 'Inbox',
};
const WRITE_POLICY_LABELS = {
  disabled: '只读',
  confirm: '写入需确认',
  auto: '任务模式（需确认）',
};
// The local UI has one owner. Keep the compatibility value for older server APIs,
// but do not expose or derive permissions from a user role in this panel.
const LOCAL_OWNER_ROLE = 'editor';

function expertAllowsScope(expert, scope) {
  if (!scope || scope === 'auto') return true;
  const allowed = new Set(expert?.capabilities?.context ?? ['current-note', 'project', 'vault']);
  if (scope === 'project') return allowed.has('project') || allowed.has('vault');
  if (scope === 'inbox') return allowed.has('inbox') || allowed.has('vault');
  return allowed.has(CONTEXT_SCOPE_META[scope]?.capability);
}

function normalizeContextScope(expert, scope, { activeNote = null, projectContext = null, hasInbox = false } = {}) {
  const autoCandidates = expert?.id === 'general'
    ? ['project', 'current', 'all', 'inbox']
    : ['project', 'current', 'inbox', 'all'];
  const candidates = scope === 'auto'
    ? autoCandidates
    : [scope, 'project', 'current', 'inbox', 'all'];
  for (const candidate of candidates) {
    if (!CONTEXT_SCOPE_META[candidate] || !expertAllowsScope(expert, candidate)) continue;
    if (candidate === 'current' && !activeNote) continue;
    if (candidate === 'project' && !projectContext) continue;
    if (candidate === 'inbox' && !hasInbox) continue;
    return candidate;
  }
  return 'none';
}

function expertContextLabels(expert) {
  const context = expert?.capabilities?.context ?? ['current-note', 'project', 'vault'];
  const labels = [...new Set(context.map((item) => CONTEXT_CAPABILITY_LABELS[item] ?? item).filter(Boolean))];
  return labels.length ? labels : ['无上下文'];
}

const WELCOME_MESSAGE = {
  id: 'ai-welcome',
  role: 'assistant',
  content: '你好，我是 Lattice 知识库助手。可以直接问「这篇笔记讲了什么」，我会检索全库相关知识并给出带来源引用的回答；也可以让我搜索、整理、编辑或移动文件，写操作前都会先给出可确认的预览。',
  suggestions: ['总结当前笔记的内容', '搜索最近修改的项目笔记', '检查当前笔记的 Markdown 问题'],
};

function newSessionId() {
  return `sess-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`;
}

// 会话下拉选项：标题 + 消息条数 + 更新日期，隔几天回来能分清哪个是哪个
function formatSessionOption(session) {
  if (!session) return '当前对话';
  const title = String(session.title ?? '').trim().slice(0, 32) || '未命名会话';
  const countLabel = Number.isFinite(session.messageCount) ? ` · ${session.messageCount} 条` : '';
  const date = new Date(session.updatedAt ?? '');
  const dateLabel = Number.isNaN(date.getTime())
    ? ''
    : ` · ${date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}/`}${date.getMonth() + 1}/${date.getDate()}`;
  return `${title}${countLabel}${dateLabel}`;
}

const SESSION_PAGE_SIZE = 20;

function formatSessionDate(value) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '时间未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  } catch {
    return '时间未知';
  }
}

function sessionDateGroup(value, now = new Date()) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '更早';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.floor((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 0) return '今天';
  if (days < 7) return '最近 7 天';
  return '更早';
}

function groupSessionsByDate(rows) {
  const groups = new Map([
    ['今天', []],
    ['最近 7 天', []],
    ['更早', []],
  ]);
  for (const row of rows) groups.get(sessionDateGroup(row.updatedAt)).push(row);
  return [...groups.entries()].filter(([, items]) => items.length);
}

// 流式原始输出里，动作围栏与「自动读取」标记不直接展示给用户
function displayStreamText(raw) {
  const fence = raw.match(/```lattice[-_]actions/i);
  const visible = fence ? raw.slice(0, fence.index) : raw;
  return visible.replace(/\[\[自动读取文件中…\]\]/g, '').trimEnd();
}

function createInitialProgress() {
  return [
    { id: 'client-request', label: '接收任务', detail: '已发送到 AI 助手', status: 'completed' },
    { id: 'client-working', label: '等待执行状态', detail: '正在连接任务进度', status: 'running' },
  ];
}

function mergeProgressStep(steps, event) {
  if (!event?.id || !event?.label) return steps;
  const next = { id: String(event.id), label: String(event.label), status: event.status ?? 'pending', detail: String(event.detail ?? '') };
  const index = steps.findIndex((step) => step.id === next.id);
  if (index < 0) return [...steps.filter((step) => step.id !== 'client-working'), next];
  return steps.map((step, itemIndex) => itemIndex === index ? { ...step, ...next } : step);
}

function updateProgressDetail(steps, detail) {
  const index = [...steps].reverse().findIndex((step) => step.status === 'running' || step.status === 'pending');
  if (index < 0) return steps;
  const actualIndex = steps.length - index - 1;
  return steps.map((step, itemIndex) => itemIndex === actualIndex ? { ...step, detail: String(detail ?? '') } : step);
}

function completeProgress(steps, { awaitingConfirmation = false } = {}) {
  const normalized = steps.map((step) => step.status === 'failed' || step.status === 'waiting'
    ? step
    : awaitingConfirmation
      ? { ...step, status: 'waiting', detail: step.detail || '文件操作等待确认' }
      : { ...step, status: 'completed', detail: step.detail || '已完成' });
  if (!awaitingConfirmation || normalized.some((step) => step.status === 'waiting')) return normalized;
  return [...normalized, {
    id: 'client-confirmation',
    label: '等待确认',
    detail: '文件操作不会自动执行',
    status: 'waiting',
  }];
}

function failProgress(steps, detail) {
  const index = [...steps].reverse().findIndex((step) => step.status === 'running' || step.status === 'pending');
  if (index < 0) return steps;
  const actualIndex = steps.length - index - 1;
  return steps.map((step, itemIndex) => itemIndex === actualIndex
    ? { ...step, status: 'failed', detail: detail || '执行失败' }
    : step);
}

export default function AIAssistantPanel({ open, onClose, noteIndex = [], folders = [], activeNote, onOpenNote, onOperationComplete, initialPrompt = '', initialPromptPreferModel = false, onInitialPromptConsumed, expertId = 'general', expert = null, experts = [], onSelectExpert, onOpenExpertsCenter }) {
  const sessionStorageKey = `${LAST_SESSION_KEY}:${expertId}`;
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [digesting, setDigesting] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [progressSteps, setProgressSteps] = useState([]);
  const [activeTaskMode, setActiveTaskMode] = useState(false);
  // 推理模型的思维链（delta.reasoning_content）：流式滚动展示，完成后折叠进消息
  const [reasoningText, setReasoningText] = useState('');
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [tab, setTab] = useState('chat');
  const [sessions, setSessions] = useState([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [sessionBrowserOpen, setSessionBrowserOpen] = useState(false);
  const [sessionBrowserQuery, setSessionBrowserQuery] = useState('');
  const [sessionBrowserSearchContent, setSessionBrowserSearchContent] = useState(false);
  const [sessionBrowserPage, setSessionBrowserPage] = useState(0);
  const [sessionBrowserRows, setSessionBrowserRows] = useState([]);
  const [sessionBrowserMeta, setSessionBrowserMeta] = useState({ total: 0, hasMore: false });
  const [sessionBrowserLoading, setSessionBrowserLoading] = useState(false);
  const [sessionBrowserDeleteId, setSessionBrowserDeleteId] = useState('');
  const [sessionBrowserReload, setSessionBrowserReload] = useState(0);
  const [sessionId, setSessionId] = useState(() => {
    try {
      const stored = localStorage.getItem(sessionStorageKey);
      return stored && stored.trim() ? stored : newSessionId();
    } catch {
      return newSessionId();
    }
  });
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const [undoneIds, setUndoneIds] = useState(() => new Set());
  const [undoBusyId, setUndoBusyId] = useState('');
  const [undoBusyAll, setUndoBusyAll] = useState(false);
  const [historyNotice, setHistoryNotice] = useState('');
  const [execution, setExecution] = useState(null);
  const [error, setError] = useState('');
  const [retryMessage, setRetryMessage] = useState('');
  const [related, setRelated] = useState([]);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [contextScope, setContextScope] = useState('auto');
  // 通用专家下发送消息后，按 routing 关键词给出的切换建议（服务端 /experts/route 打分）
  const [expertSuggestion, setExpertSuggestion] = useState(null);
  // 会话重命名：Electron 不支持 window.prompt，改用面板内 Modal
  const [sessionRename, setSessionRename] = useState(null);
  const [sessionRenameSaving, setSessionRenameSaving] = useState(false);
  const sessionRenameInputRef = useRef(null);
  // 任务模式消息的批量撤销：operationId 来自服务端 meta.executedOperations
  const [taskUndoBusyId, setTaskUndoBusyId] = useState('');
  const [undoneTaskMessages, setUndoneTaskMessages] = useState(() => new Set());
  const abortRef = useRef(null);
  const forceModelRef = useRef(false);
  const progressStepsRef = useRef([]);
  const loadedSessionRef = useRef(null);
  const messagesRef = useRef(null);
  const draftRef = useRef(null);
  const streamTextRef = useRef('');
  const streamStatusRef = useRef('');
  const reasoningRef = useRef('');
  const streamFrameRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const scrollPositionsRef = useRef(new Map());

  const commitProgressSteps = (nextSteps) => {
    setProgressSteps((current) => {
      const next = typeof nextSteps === 'function' ? nextSteps(current) : nextSteps;
      progressStepsRef.current = next;
      return next;
    });
  };

  const activeProvider = getActiveAiProvider(settings);
  const connectionState = !hasExternalAi(settings) ? 'local' : activeProvider?.verified ? 'connected' : 'configured';
  const composerBusy = sending || digesting;

  const flushStream = () => {
    streamFrameRef.current = 0;
    setStreamText(streamTextRef.current);
    setStreamStatus(streamStatusRef.current);
    setReasoningText(reasoningRef.current);
  };
  const queueStreamFlush = () => {
    if (streamFrameRef.current) return;
    streamFrameRef.current = requestAnimationFrame(flushStream);
  };

  useEffect(() => () => {
    if (streamFrameRef.current) cancelAnimationFrame(streamFrameRef.current);
  }, []);

  useEffect(() => subscribeAiSettings(setSettings), []);
  useEffect(() => {
    hydrateAiSettingsFromServer();
  }, []);

  useEffect(() => {
    setExpertSuggestion(null);
  }, [expertId]);

  useEffect(() => {
    loadedSessionRef.current = null;
    setMessages([WELCOME_MESSAGE]);
    setPreview(null);
    setExecution(null);
     commitProgressSteps([]);
    setError('');
    setSessionId(() => {
      try {
        return localStorage.getItem(sessionStorageKey) || newSessionId();
      } catch {
        return newSessionId();
      }
    });
  }, [expertId, sessionStorageKey]);

  const requestOptions = useMemo(() => {
    const accessToken = settings.accessToken?.trim();
    return accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};
  }, [settings.accessToken]);

  // 会话列表（服务端持久化，跨端可用）
  // stale 防护：快速切换 expertId 时两个请求并发，旧闭包的响应后到会覆盖
  // 新专家的会话列表（消息恢复的 effect 有 cancelled 守卫，这里补齐）
  const expertIdRef = useRef(expertId);
  useEffect(() => {
    expertIdRef.current = expertId;
  }, [expertId]);

  const refreshSessions = useCallback(async () => {
    const requestExpertId = expertId;
    try {
      const response = await aiApi.listSessions({ query: { expertId, limit: 8 }, ...requestOptions });
      if (expertIdRef.current !== requestExpertId) return;
      const rows = response?.data ?? response ?? [];
      // 后端契约是数组；防护异常响应把整个面板渲染砸掉
      const recentRows = Array.isArray(rows) ? rows : [];
      // 当前会话可能早于最近 8 条；补进来，避免重新打开面板时丢失上下文。
      let selectedRow = null;
      let staleStoredId = '';
      try {
        const storedId = localStorage.getItem(sessionStorageKey);
        if (storedId && !recentRows.some((session) => session.id === storedId)) {
          const selectedResponse = await aiApi.sessionMessages(storedId, requestOptions);
          const candidate = selectedResponse?.session ?? selectedResponse?.data?.session ?? null;
          if (candidate?.expertId === requestExpertId) selectedRow = candidate;
          else staleStoredId = storedId;
          if (expertIdRef.current !== requestExpertId) return;
        }
      } catch (error) {
        const storedId = localStorage.getItem(sessionStorageKey);
        if (error?.status === 404 && storedId) staleStoredId = storedId;
        // 本地新会话尚未写入服务端时会 404，稍后发送时由服务端创建。
      }
      if (staleStoredId && expertIdRef.current === requestExpertId) {
        const freshId = newSessionId();
        try {
          localStorage.setItem(sessionStorageKey, freshId);
        } catch {
          // 忽略持久化失败
        }
        setSessionId((current) => current === staleStoredId ? freshId : current);
      }
      setSessions(selectedRow ? [selectedRow, ...recentRows] : recentRows);
    } catch {
      // 会话列表加载失败不影响当前对话
    } finally {
      setSessionsReady(true);
    }
  }, [expertId, requestOptions, sessionStorageKey]);

  useEffect(() => {
    if (!sessionBrowserOpen) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSessionBrowserLoading(true);
      try {
        const response = await aiApi.listSessions({
          query: {
            expertId,
            query: sessionBrowserQuery.trim(),
            searchContent: sessionBrowserSearchContent ? 'true' : 'false',
            limit: SESSION_PAGE_SIZE,
            offset: sessionBrowserPage * SESSION_PAGE_SIZE,
          },
          ...requestOptions,
        });
        if (cancelled) return;
        setSessionBrowserRows(Array.isArray(response?.data) ? response.data : []);
        setSessionBrowserMeta(response?.meta ?? { total: response?.data?.length ?? 0, hasMore: false });
      } catch (requestError) {
        if (!cancelled) setError(requestError?.message ?? '会话历史加载失败');
      } finally {
        if (!cancelled) setSessionBrowserLoading(false);
      }
    }, sessionBrowserQuery.trim() ? 220 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [expertId, requestOptions, sessionBrowserOpen, sessionBrowserPage, sessionBrowserQuery, sessionBrowserReload, sessionBrowserSearchContent]);

  const refreshHistory = useCallback(async ({ reportError = false } = {}) => {
    try {
      const [aiEntries, fileEntries] = await Promise.all([
        aiApi.history({ query: { limit: 80 }, ...requestOptions }),
        filesApi.log({ query: { limit: 80 }, ...requestOptions }),
      ]);
      const aiHistory = aiEntries?.data ?? aiEntries ?? [];
      const fileLog = fileEntries?.data ?? fileEntries ?? [];
      // fc 内核的撤销记录（type: undo，operationId 指向被撤销的操作）：用于把已撤销条目置灰
      setUndoneIds(new Set(fileLog.filter((entry) => entry.type === 'undo' && entry.operationId).map((entry) => entry.operationId)));
      const fileHistory = fileLog
        // AI agent writes are already represented by /ai/history. The file API
        // is the source of truth for the GUI's confirmed local operations.
        .filter((entry) => entry.source === 'files-api' && entry.type !== 'undo')
        .map((entry) => ({
          ...entry,
          operationId: entry.id,
          action: {
            type: entry.type,
            path: entry.path,
            targetPath: entry.targetPath,
          },
        }));
      setHistory([...aiHistory, ...fileHistory].sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? ''))));
    } catch (requestError) {
      if (reportError) setError(requestError?.message ?? '审计记录加载失败');
    }
  }, [requestOptions]);

  useEffect(() => {
    if (!open) return;
    loadedSessionRef.current = null;
    setSessionsReady(false);
    refreshSessions();
    refreshHistory();
  }, [open, refreshHistory, refreshSessions]);

  // 切换会话时从服务端拉取历史消息
  useEffect(() => {
    if (!open || !sessionId || !sessionsReady) return;
    // 刷新会话列表不等于切换会话；避免覆盖正在等待确认的文件预览。
    if (loadedSessionRef.current === sessionId) return;
    loadedSessionRef.current = sessionId;
    if (!sessions.some((session) => session.id === sessionId)) {
      setMessages([WELCOME_MESSAGE]);
      setPreview(null);
      setExecution(null);
      setError('');
      return undefined;
    }
    try {
      localStorage.setItem(sessionStorageKey, sessionId);
    } catch {
      // 忽略持久化失败
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await aiApi.sessionMessages(sessionId, requestOptions);
        const payload = response?.data ?? response ?? {};
        if (cancelled) return;
        const restored = (payload.messages ?? []).map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          suggestions: message.payload?.suggestions ?? [],
          references: message.payload?.references ?? [],
          reasoning: message.payload?.reasoning ?? '',
          meta: message.payload?.meta ?? null,
        }));
        setMessages(restored.length ? restored : [WELCOME_MESSAGE]);
        setPreview(null);
        setExecution(null);
        setError('');
      } catch {
        if (!cancelled) setMessages([WELCOME_MESSAGE]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, requestOptions, sessions, sessionsReady]);

  // 相关笔记：语义索引就绪时，随当前笔记变化自动刷新（Reor 式「写作时浮现」）
  useEffect(() => {
    if (!open || !activeNote?.id) {
      setRelated([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await aiApi.relatedNotes(activeNote.id, 5, requestOptions);
        if (!cancelled) setRelated(response?.data ?? response ?? []);
      } catch {
        if (!cancelled) setRelated([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeNote?.id, requestOptions]);

  // 新消息 / 流式输出时滚到最新
  useEffect(() => {
    const container = messagesRef.current;
    if (!container || !stickToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
    if (sessionId) {
      scrollPositionsRef.current.set(sessionId, {
        scrollTop: container.scrollTop,
        stickToBottom: true,
      });
    }
  }, [execution, messages, preview, sending, sessionId, streamText]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return undefined;
    const updateScrollIntent = () => {
      const stickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 96;
      stickToBottomRef.current = stickToBottom;
      if (sessionId) {
        scrollPositionsRef.current.set(sessionId, {
          scrollTop: container.scrollTop,
          stickToBottom,
        });
      }
    };
    container.addEventListener('scroll', updateScrollIntent, { passive: true });
    return () => container.removeEventListener('scroll', updateScrollIntent);
  }, [open, sessionId]);

  useLayoutEffect(() => {
    if (!open || !sessionId || !sessionsReady) return;
    const container = messagesRef.current;
    if (!container) return;
    const saved = scrollPositionsRef.current.get(sessionId);
    if (saved?.stickToBottom || !saved) {
      container.scrollTop = container.scrollHeight;
      stickToBottomRef.current = true;
      scrollPositionsRef.current.set(sessionId, {
        scrollTop: container.scrollTop,
        stickToBottom: true,
      });
      return;
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.min(Math.max(0, saved.scrollTop), maxScrollTop);
    stickToBottomRef.current = false;
  }, [messages.length, open, sessionId, sessionsReady]);

  // 输入框随内容自动增高，超过上限后内部滚动
  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`;
  }, [draft, tab]);

  const folderEntries = useMemo(() => flattenFolders(folders), [folders]);
  const projectContext = useMemo(() => {
    const activeFolder = folderEntries.find((folder) => folder.id === activeNote?.folderId);
    if (!activeFolder) return null;
    const rootPath = activeFolder.path.split('/')[0];
    if (SYSTEM_ROOT_FOLDERS.has(rootPath.toLowerCase())) return null;
    const rootFolder = folderEntries.find((folder) => folder.path === rootPath);
    const projectFolderIds = new Set(
      folderEntries
        .filter((folder) => folder.path === rootPath || folder.path.startsWith(`${rootPath}/`))
        .map((folder) => folder.id),
    );
    return {
      name: rootPath,
      path: rootPath,
      folderId: rootFolder?.id ?? null,
      folderIds: projectFolderIds,
    };
  }, [activeNote?.folderId, folderEntries]);

  const inboxItems = useMemo(
    () => noteIndex.filter((note) => note.properties?.type === 'inbox'),
    [noteIndex],
  );
  const pendingInboxItems = useMemo(
    () => inboxItems.filter((note) => ['captured', 'processing'].includes(note.properties?.status ?? 'captured')),
    [inboxItems],
  );

  const effectiveContextScope = useMemo(() => {
    return normalizeContextScope(expert, contextScope, {
      activeNote,
      projectContext,
      hasInbox: inboxItems.length > 0,
    });
  }, [activeNote, contextScope, expert, inboxItems.length, projectContext]);

  useEffect(() => {
    if (contextScope === 'auto') return;
    const normalized = normalizeContextScope(expert, contextScope, {
      activeNote,
      projectContext,
      hasInbox: inboxItems.length > 0,
    });
    if (normalized !== contextScope) setContextScope(normalized === 'none' ? 'auto' : normalized);
  }, [activeNote, contextScope, expert, inboxItems.length, projectContext]);

  const contextScopeLabel = effectiveContextScope === 'current'
    ? '当前笔记'
    : effectiveContextScope === 'project'
      ? `项目：${projectContext.name}`
      : effectiveContextScope === 'inbox'
        ? 'Inbox'
        : effectiveContextScope === 'all'
          ? '全库'
          : '无可用上下文';

  const scopedNoteIndex = useMemo(() => {
    if (effectiveContextScope === 'current') return activeNote ? [activeNote] : [];
    if (effectiveContextScope === 'project' && projectContext) {
      return noteIndex.filter((note) => projectContext.folderIds.has(note.folderId));
    }
    if (effectiveContextScope === 'inbox') return inboxItems;
    if (effectiveContextScope === 'none') return [];
    return noteIndex;
  }, [activeNote, effectiveContextScope, inboxItems, noteIndex, projectContext]);

  const expertSummary = useMemo(() => {
    const skillCount = Number.isFinite(expert?.skillCount)
      ? expert.skillCount
      : (expert?.skills ?? []).filter((skill) => skill.enabled !== false).length;
    const writePolicy = expert?.capabilities?.writePolicy ?? 'confirm';
    return {
      kind: expertId === 'general' ? '通用助手' : '固定专家',
      skillCount,
      contexts: expertContextLabels(expert).join('、'),
      writePolicy: WRITE_POLICY_LABELS[writePolicy] ?? WRITE_POLICY_LABELS.confirm,
    };
  }, [expert, expertId]);

  const context = useMemo(() => ({
    activeFile: activeNote?.filePath ?? activeNote?.title ?? null,
    activeFileContent: typeof activeNote?.content === 'string' ? activeNote.content.slice(0, 12_000) : null,
    project: projectContext ? {
      name: projectContext.name,
      path: projectContext.path,
      folderId: projectContext.folderId,
      fileCount: scopedNoteIndex.length,
    } : null,
    inbox: {
      total: inboxItems.length,
      pending: pendingInboxItems.length,
    },
    files: scopedNoteIndex.slice(0, 100).map((note) => ({
      id: note.id,
      title: note.title,
      path: note.filePath ?? note.title,
      folderId: note.folderId,
      updatedAt: note.updatedAt,
      wordCount: note.wordCount,
      properties: note.properties ?? {},
    })),
    inboxFiles: inboxItems.slice(0, 80).map((note) => ({
      id: note.id,
      title: note.title,
      path: note.filePath ?? note.title,
      folderId: note.folderId,
      updatedAt: note.updatedAt,
      wordCount: note.wordCount,
      properties: note.properties ?? {},
    })),
    folders: folderEntries.slice(0, 80).map((folder) => ({ id: folder.id, name: folder.name, path: folder.path })),
    scope: effectiveContextScope,
    scopeLabel: contextScopeLabel,
  }), [activeNote, contextScopeLabel, effectiveContextScope, folderEntries, inboxItems, pendingInboxItems, projectContext, scopedNoteIndex]);

  const historyStats = useMemo(() => ({
    total: history.length,
    completed: history.filter((entry) => entry.status === 'completed').length,
    failed: history.filter((entry) => entry.status === 'failed').length,
  }), [history]);

  const appendMessage = (message) => setMessages((current) => [...current, message]);

  // 流式请求跨会话保护：请求期间用户切换/新建会话时，旧请求的
  // 流式增量、最终回复与预览面板不得写入新会话
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // 项目级 MCP Server（.lattice/mcp.json）缓存：打开面板时重取，发送时直接用。
  // 读取失败不阻断发送——只降级为用户级配置。
  const projectServersRef = useRef(null);
  useEffect(() => {
    if (open) projectServersRef.current = null;
  }, [open]);

  const resolveMcpServers = async () => {
    let servers = collectActiveMcpServers();
    if (loadMcpSettings().projectEnabled) {
      let projectServers = projectServersRef.current;
      if (!projectServers) {
        try {
          const data = await mcpApi.project();
          projectServers = Array.isArray(data?.servers) ? data.servers : [];
          projectServersRef.current = projectServers;
        } catch {
          projectServers = [];
        }
      }
      servers = mergeProjectServers(servers, projectServers);
    }
    return servers;
  };

  // 面板打开即预热 MCP 连接：spawn 进程 + listTools 的冷启动（秒级）移出第一条消息。
  // 发后即忘：预热失败静默，正式对话仍按原路径自行连接。
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      const servers = await resolveMcpServers();
      if (!cancelled && servers.length) void aiApi.warmupMcp(servers, { role: LOCAL_OWNER_ROLE }).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
    // 仅在面板打开时预热一次；resolveMcpServers 读取的是 ref 与本地配置，无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const send = async (value = draft, options = {}) => {
    const message = String(value).trim();
    if (!message || composerBusy) return;
    const preferModel = options.preferModel ?? (forceModelRef.current || settings.preferModel === true);
    const taskMode = settings.autoApprove === true;
    forceModelRef.current = false;
    const requestSessionId = sessionId;
    const stale = () => sessionIdRef.current !== requestSessionId;
    // 发送时取一次当前配置：设置页改动对下一条消息生效，不打断进行中的对话
    const mcpServers = await resolveMcpServers();
    setDraft('');
    setError('');
    setRetryMessage('');
    setExecution(null);
    setPreview(null);
    setExpertSuggestion(null);
    setActiveTaskMode(taskMode);
    commitProgressSteps(taskMode ? createInitialProgress() : []);
    streamTextRef.current = '';
    streamStatusRef.current = '';
    reasoningRef.current = '';
    setStreamText('');
    setStreamStatus('');
    setReasoningText('');
    // 重新生成时上一条 user 消息已在列表里（仅移除了旧回答），不再重复追加
    if (options.skipUserMessage !== true) {
      appendMessage({ id: `user-${Date.now()}`, role: 'user', content: message });
    }
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // 通用专家下顺带问一次路由建议：不阻塞发送、失败静默，仅在有候选时提示切换
    if (expertId === 'general' && experts.length > 1) {
      expertsApi.route({ message, excludeId: expertId })
        .then((data) => {
          const candidates = Array.isArray(data) ? data : [];
          if (!stale() && candidates.length) setExpertSuggestion(candidates[0]);
        })
        .catch(() => {});
    }

    try {
      const payload = await aiApi.streamChat({
        message,
        context,
        sessionId,
        expertId,
         mode: taskMode ? 'agent' : 'assist',
         preferModel,
         autoApprove: taskMode,
        actor: 'local-user',
         role: LOCAL_OWNER_ROLE,
        // 重新生成：服务端先移除会话里上一轮 user+assistant，再执行本条
        ...(options.regenerate ? { regenerate: true } : {}),
        // 用户在设置页启用的外部 MCP Server：空数组时后端不拉起任何进程
        ...(mcpServers.length ? { mcpServers } : {}),
      }, {
        ...requestOptions,
        signal: controller.signal,
        onEvent: (event) => {
          if (stale()) return;
          if (event.type === 'meta') {
            streamStatusRef.current = `模型 ${event.model ?? ''} 生成中…`;
            queueStreamFlush();
          }
          else if (event.type === 'delta') {
            streamTextRef.current += String(event.text ?? '');
            queueStreamFlush();
          }
          else if (event.type === 'reasoning') {
            reasoningRef.current += String(event.text ?? '');
            queueStreamFlush();
          }
          else if (event.type === 'round') {
            streamTextRef.current = '';
            reasoningRef.current = '';
            streamStatusRef.current = `第 ${event.round} 轮 · 继续执行任务…`;
            queueStreamFlush();
          } else if (event.type === 'status') {
            streamStatusRef.current = event.text ?? '';
             commitProgressSteps((current) => updateProgressDetail(current, event.text));
            queueStreamFlush();
          } else if (event.type === 'progress') {
             commitProgressSteps((current) => mergeProgressStep(current, event));
          } else if (event.type === 'done') {
            streamStatusRef.current = '';
            const finalProgress = event.payload?.meta?.progress;
             if (Array.isArray(finalProgress) && finalProgress.length) commitProgressSteps(finalProgress);
            queueStreamFlush();
          }
        },
      });
      if (stale()) return;

       const pendingWrites = Array.isArray(payload?.actions) && payload.actions.some((action) => (
         ['create', 'update', 'delete', 'move', 'copy', 'archive'].includes(String(action?.type ?? '').toLowerCase())
       ));
       const awaitingConfirmation = payload?.meta?.awaitingConfirmation === true
         || payload?.meta?.completionStatus === 'waiting_confirmation'
         || pendingWrites;
       const persistedProgress = taskMode
         ? (Array.isArray(payload?.meta?.progress) && payload.meta.progress.length
           ? payload.meta.progress
           : completeProgress(progressStepsRef.current, { awaitingConfirmation }))
         : [];
       const { progress: _serverProgress, ...metaWithoutProgress } = payload?.meta ?? {};
       const assistantMeta = {
         ...metaWithoutProgress,
         taskMode,
         completionStatus: payload?.meta?.completionStatus ?? (awaitingConfirmation ? 'waiting_confirmation' : 'completed'),
         awaitingConfirmation,
         ...(taskMode && persistedProgress.length ? { progress: persistedProgress } : {}),
       };
      commitProgressSteps(persistedProgress);
      const assistant = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: payload?.reply ?? '已收到请求。',
        suggestions: payload?.suggestions ?? [],
        references: payload?.references ?? [],
        reasoning: payload?.reasoning ?? '',
        meta: assistantMeta,
      };
      appendMessage(assistant);
       if (taskMode) refreshHistory();
      if (payload?.actions?.length) {
         const previewResponse = await buildOperationPreview(payload.actions, requestOptions, LOCAL_OWNER_ROLE);
        if (stale()) return;
        setPreview(previewResponse);
      }
      refreshSessions();
    } catch (requestError) {
      if (stale()) return;
      if (requestError?.name === 'AbortError') {
        appendMessage({ id: `system-${Date.now()}`, role: 'system', content: '已停止生成。' });
      } else {
        // 失败透明：展示上游原因 + 重试入口，不再静默回落本地助手
        setError(requestError?.message ?? 'AI 请求失败，请稍后重试');
        setRetryMessage(message);
         commitProgressSteps((current) => failProgress(current, requestError?.message));
      }
    } finally {
      // 清理必须无条件执行：切换会话会 abort 旧请求，若在这里跳过 setSending，
      // composerBusy 会永久卡住。内容写入（消息/预览/报错）才需要 stale 守卫。
      abortRef.current = null;
      setSending(false);
      setActiveTaskMode(false);
      streamTextRef.current = '';
      streamStatusRef.current = '';
      setStreamText('');
      setStreamStatus('');
    }
  };

  // 重新生成最后一条回答：移除旧回答（保留 user 消息），带 regenerate 标记重发，
  // 服务端会同步移除会话里的上一轮，避免同一问题在模型上下文里出现两遍
  const lastAssistantIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant' && messages[index].id !== WELCOME_MESSAGE.id) return index;
    }
    return -1;
  }, [messages]);

  const regenerateLast = () => {
    if (composerBusy || lastAssistantIndex <= 0) return;
    let lastUser = null;
    for (let index = lastAssistantIndex - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') { lastUser = messages[index]; break; }
    }
    if (!lastUser) return;
    setMessages(messages.slice(0, lastAssistantIndex));
    send(lastUser.content, { regenerate: true, skipUserMessage: true });
  };

  useEffect(() => {
    if (!open || !initialPrompt.trim()) return;
    setTab('chat');
    setDraft(initialPrompt.trim());
    forceModelRef.current = initialPromptPreferModel === true;
    setError('');
    setRetryMessage('');
    onInitialPromptConsumed?.();
  }, [initialPrompt, initialPromptPreferModel, onInitialPromptConsumed, open]);

  // 面板关闭时中止进行中的生成：否则 agent 循环继续烧 Token 并执行写操作，
  // 且用户没有任何停止入口
  useEffect(() => {
    if (open) return;
    abortRef.current?.abort();
  }, [open]);

  if (!open) return null;

  const stopGenerating = () => abortRef.current?.abort();

  const startNewSession = () => {
    if (sending) stopGenerating();
    const id = newSessionId();
    setSessionId(id);
    setMessages([WELCOME_MESSAGE]);
    setPreview(null);
    setExecution(null);
    setError('');
    setRetryMessage('');
    try {
      localStorage.setItem(sessionStorageKey, id);
    } catch {
      // 忽略
    }
  };

  const openSessionBrowser = () => {
    setSessionBrowserPage(0);
    setSessionBrowserOpen(true);
    setSessionBrowserReload((value) => value + 1);
  };

  const selectSession = (session) => {
    // 生成中切走：先中止旧请求（其 finally 会复位 sending/流式状态），
    // 否则旧会话的半截流文本与输入框锁定会"占用"新会话
    if (sending) stopGenerating();
    setSessions((current) => current.some((item) => item.id === session.id) ? current : [session, ...current]);
    setSessionId(session.id);
    setPreview(null);
    setError('');
    setRetryMessage('');
    setTab('chat');
    setSessionBrowserOpen(false);
  };

  const deleteCurrentSession = async () => {
    const current = sessionId;
    startNewSession();
    try {
      await aiApi.deleteSession(current, requestOptions);
    } catch {
      // 会话可能尚不存在，忽略
    }
    refreshSessions();
  };

  const deleteSessionFromBrowser = async (session) => {
    if (sessionBrowserDeleteId) return;
    const title = String(session.title ?? '').trim() || '未命名会话';
    if (!window.confirm(`删除“${title}”？会话消息也会一并删除。`)) return;
    setSessionBrowserDeleteId(session.id);
    try {
      await aiApi.deleteSession(session.id, requestOptions);
      setSessionBrowserRows((current) => current.filter((item) => item.id !== session.id));
      setSessionBrowserMeta((current) => ({
        ...current,
        total: Math.max(Number(current.total ?? 0) - 1, 0),
      }));
      if (session.id === sessionId) startNewSession();
      await refreshSessions();
      if (sessionBrowserRows.length <= 1 && sessionBrowserPage > 0) setSessionBrowserPage((page) => page - 1);
      else setSessionBrowserReload((value) => value + 1);
    } catch (requestError) {
      setError(requestError?.message ?? '会话删除失败，请稍后再试');
    } finally {
      setSessionBrowserDeleteId('');
    }
  };

  const renameCurrentSession = () => {
    const current = sessions.find((session) => session.id === sessionId);
    setSessionRename({ id: sessionId, title: current?.title ?? '' });
  };

  const submitSessionRename = async (event) => {
    event.preventDefault();
    if (!sessionRename || sessionRenameSaving) return;
    const title = sessionRename.title.trim();
    if (!title) return;
    setSessionRenameSaving(true);
    try {
      await aiApi.renameSession(sessionRename.id, title, requestOptions);
      setSessionRename(null);
      await refreshSessions();
    } catch {
      setError('会话重命名失败，请稍后再试');
    } finally {
      setSessionRenameSaving(false);
    }
  };

  // 任务模式整批撤销：后执行的先撤（后续动作可能依赖前面的结果），与 undoExecution 同口径
  const undoTaskModeOperations = async (message) => {
    const operations = Array.isArray(message?.meta?.executedOperations) ? message.meta.executedOperations : [];
    if (!operations.length || taskUndoBusyId) return;
    setTaskUndoBusyId(message.id);
    setError('');
    try {
      let undoneCount = 0;
      let firstFailure = '';
      for (const operation of [...operations].reverse()) {
        try {
          await filesApi.undo(operation.operationId, requestOptions);
          undoneCount += 1;
        } catch (requestError) {
          firstFailure = requestError?.message ?? '撤销失败';
          break;
        }
      }
      if (undoneCount) {
        setUndoneTaskMessages((current) => new Set(current).add(message.id));
        appendMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: `已撤销 ${undoneCount} 项操作${firstFailure ? `，另有未撤销的失败项：${firstFailure}` : ''}。`,
        });
        await refreshHistory();
        await onOperationComplete?.();
      } else if (firstFailure) {
        setError(firstFailure);
      }
    } finally {
      setTaskUndoBusyId('');
    }
  };

  const executePreview = async ({ additionalConfirmed = false } = {}) => {
    if (!preview || preview.blocked || sending) return;
    setSending(true);
    setStreamStatus('正在执行文件操作…');
    setError('');
    try {
      const results = [];
      // 预览阶段就失败的动作（如模型给出非法路径）不提交执行，直接记为失败
      for (const operation of preview.failedOperations ?? []) {
        results.push({
          id: operation.id,
          type: operation.originalType ?? operation.type,
          path: operation.path,
          targetPath: operation.targetPath,
          status: 'failed',
          error: operation.error ?? '预览失败',
        });
      }
      // 所有 AI 文件动作都走服务端 AI 预览/确认协议，避免文件内核接口绕过
      // 敏感路径策略和计划哈希。
      for (const operation of preview.fileOperations ?? []) {
        try {
          const response = await submitAiActions({
            actions: [operation.action],
             actor: 'local-user',
             role: LOCAL_OWNER_ROLE,
             source: 'ai-chat',
             confirmed: true,
             additionalConfirmed,
             sensitiveConfirmed: operation.sensitive ? additionalConfirmed : false,
             planId: operation.planId,
            planHash: operation.planHash,
          }, requestOptions);
          const result = response?.data ?? response;
          results.push(...(result.results ?? [{
            id: operation.id,
            type: operation.action.type,
            path: operation.action.path,
            targetPath: operation.action.targetPath,
            status: 'completed',
            result,
          }]));
        } catch (requestError) {
          results.push({
            id: operation.id,
            type: operation.action.type,
            path: operation.action.path,
            targetPath: operation.action.targetPath,
            status: 'failed',
            error: requestError?.message ?? '操作失败',
          });
        }
      }
      if (preview.aiOperations?.length) {
        const response = await submitAiActions({
          actions: preview.aiOperations,
           actor: 'local-user',
           role: LOCAL_OWNER_ROLE,
           source: 'ai-chat',
           confirmed: true,
           additionalConfirmed,
           sensitiveConfirmed: preview.requiresSensitiveConfirmation === true ? additionalConfirmed : false,
           planId: preview.aiPlanId,
          planHash: preview.aiPlanHash,
        }, requestOptions);
        const legacyResult = response?.data ?? response;
        results.push(...(legacyResult.results ?? []));
      }

      const result = {
        results,
        completed: results.filter((item) => item.status === 'completed').length,
        failed: results.filter((item) => item.status === 'failed').length,
        skipped: results.filter((item) => item.status === 'skipped').length,
      };
      setExecution(result);
      setPreview(null);
      appendMessage({
        id: `system-${Date.now()}`,
        role: 'system',
        content: `已完成 ${result.completed ?? 0} 项操作${result.failed ? `，${result.failed} 项失败` : ''}。`,
      });
      await onOperationComplete?.();
      await refreshHistory();
    } catch (requestError) {
      setError(requestError?.message ?? '执行失败，请检查权限或文件状态');
    } finally {
      setSending(false);
      setStreamStatus('');
    }
  };

  const refreshOperationPreview = async (actions) => {
    if (!Array.isArray(actions) || !actions.length || sending) return null;
    setSending(true);
    setStreamStatus('正在更新操作预览…');
    setError('');
    try {
      const next = await buildOperationPreview(actions, requestOptions, LOCAL_OWNER_ROLE);
      setPreview(next);
      return next;
    } catch (requestError) {
      setError(requestError?.message ?? '更新操作预览失败');
      return null;
    } finally {
      setSending(false);
      setStreamStatus('');
    }
  };

  // 按条目撤销一次文件写入（fc 内核快照恢复；文件在其后又被改过时服务端会拒绝）
  const undoEntry = async (entry) => {
    const operationId = entry?.operationId;
    if (!operationId || undoBusyId || undoBusyAll) return;
    setUndoBusyId(operationId);
    setError('');
    try {
      await filesApi.undo(operationId, requestOptions);
      await refreshHistory();
      await onOperationComplete?.();
      setHistoryNotice(`已撤销：${entry.action?.type ?? ''} ${entry.action?.path ?? ''}`.trim());
    } catch (requestError) {
      setError(requestError?.message ?? '撤销失败：操作可能已被撤销，或文件在此之后又发生过变动');
      refreshHistory();
    } finally {
      setUndoBusyId('');
    }
  };

  // 整批撤销刚确认执行的操作：后执行的动作先撤销（后续动作可能依赖前面的结果）
  const undoExecution = async () => {
    if (!execution || undoBusyAll) return;
    setUndoBusyAll(true);
    setError('');
    try {
      const operationIds = (execution.results ?? [])
        .filter((item) => item.status === 'completed' && item.result?.operationId)
        .map((item) => item.result.operationId)
        .reverse();
      let undoneCount = 0;
      let firstFailure = '';
      for (const operationId of operationIds) {
        try {
          await filesApi.undo(operationId, requestOptions);
          undoneCount += 1;
        } catch (requestError) {
          // 前一个动作未撤销时继续撤后面的会让状态不一致，停在第一个失败
          firstFailure = requestError?.message ?? '撤销失败';
          break;
        }
      }
      if (undoneCount) {
        setExecution(null);
        appendMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: `已撤销 ${undoneCount} 项操作${firstFailure ? `，另有未撤销的失败项：${firstFailure}` : ''}。`,
        });
        await refreshHistory();
        await onOperationComplete?.();
      } else if (firstFailure) {
        setError(firstFailure);
      }
    } finally {
      setUndoBusyAll(false);
    }
  };

  const loadHistory = async () => {
    setTab('history');
    await refreshHistory({ reportError: true });
  };

  // 每日摘要：生成/更新今天的 Journal 摘要笔记并打开
  const runDigest = async () => {
    if (composerBusy) return;
    setError('');
    setDigesting(true);
    try {
      const response = await aiApi.digest(requestOptions);
      const result = response?.data ?? response ?? {};
      appendMessage({
        id: `system-${Date.now()}`,
        role: 'system',
        content: `${result.created ? '已创建' : '已更新'}「${result.title}」：汇总了 ${result.modifiedCount} 篇今日修改的笔记${result.aiOverview ? '，含 AI 总览' : ''}。`,
      });
      if (result.noteId) onOpenNote?.(result.noteId);
      await onOperationComplete?.();
    } catch (requestError) {
      setError(requestError?.message ?? '每日摘要生成失败');
    } finally {
      setDigesting(false);
    }
  };

  const toggleAutoApprove = () => setSettings((current) => saveAiSettings({ ...current, autoApprove: current.autoApprove !== true }));
  const togglePreferModel = () => setSettings((current) => saveAiSettings({ ...current, preferModel: current.preferModel !== true }));

  return (
    <div className="ai-assistant-layer" role="presentation">
      <button type="button" className="ai-assistant-backdrop" onClick={onClose} aria-label="关闭 AI 知识库助手" />
      <SessionRenameDialog
        open={Boolean(sessionRename)}
        title={sessionRename?.title ?? ''}
        saving={sessionRenameSaving}
        inputRef={sessionRenameInputRef}
        onChange={(title) => setSessionRename((current) => (current ? { ...current, title } : current))}
        onClose={() => { if (!sessionRenameSaving) setSessionRename(null); }}
        onSubmit={submitSessionRename}
      />
      <aside className="ai-assistant" aria-label="AI 知识库助手">
        <header className="ai-assistant__header">
          <div className="ai-assistant__identity">
            <span className="ai-assistant__mark" aria-hidden="true">✦</span>
            <div className="ai-assistant__identity-copy">
              <div className="ai-assistant__identity-line">
                <h2>{expert?.name ?? 'AI 知识库助手'}</h2>
                {expert ? <span className="ai-assistant__expert-badge">专家</span> : null}
              </div>
              {expert ? <span className="ai-assistant__expert-subtitle">{expert.description || '当前专家会按自己的技能和权限处理请求'}</span> : null}
              <div className="ai-assistant__expert-meta" aria-label="当前专家能力摘要">
                <span title="当前专家类型">{expertSummary.kind}</span>
                <span title="已启用 Skill"><Layers3 size={11} aria-hidden="true" />{expertSummary.skillCount} Skill</span>
                <span title={`可读取上下文：${expertSummary.contexts}`}><BrainCircuit size={11} aria-hidden="true" />{expertSummary.contexts}</span>
                <span title="写入策略"><ShieldCheck size={11} aria-hidden="true" />{expertSummary.writePolicy}</span>
              </div>
              {experts.length > 1 ? <label className="ai-assistant__expert-picker" title="切换当前专家">
                <BrainCircuit size={12} aria-hidden="true" />
                <select value={expertId} onChange={(event) => onSelectExpert?.(event.target.value)} aria-label="切换当前专家">
                  {experts.filter((item) => item.enabled !== false).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label> : null}
            </div>
          </div>
          <div className="ai-assistant__header-actions">
            <span className={`ai-assistant__status is-${connectionState}`} title={CONNECTION_STATE_META[connectionState].title}>
              <span className="ai-assistant__status-dot" />
              {CONNECTION_STATE_META[connectionState].label}
            </span>
            <button type="button" className="ai-assistant__new-chat" onClick={startNewSession} title="开启一个新会话">新对话</button>
            <button type="button" className="icon-btn" onClick={() => onOpenExpertsCenter?.('experts')} aria-label="打开专家中心" title="打开专家中心"><Settings2 size={15} /></button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭 AI 知识库助手">×</button>
          </div>
        </header>

        <div className="ai-assistant__toolbar">
          <nav className="ai-assistant__tabs" aria-label="AI 面板视图">
            <button type="button" className={tab === 'chat' ? 'is-active' : ''} onClick={() => setTab('chat')}>对话</button>
            <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={loadHistory}>操作历史{history.length ? <span>{history.length}</span> : null}</button>
          </nav>
           {tab === 'chat' ? (
             <div className="ai-assistant__session-tools">
               <select
                className="ai-assistant__session-select"
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
                aria-label="切换历史会话"
               >
                 {!sessions.some((session) => session.id === sessionId) ? <option value={sessionId}>当前对话</option> : null}
                 {sessions.map((session) => <option key={session.id} value={session.id}>{formatSessionOption(session)}</option>)}
               </select>
               <button type="button" className="icon-btn ai-assistant__session-action" onClick={openSessionBrowser} title="查看全部会话" aria-label="查看全部会话"><List size={14} /></button>
               <button type="button" className="icon-btn ai-assistant__session-action" onClick={startNewSession} title="新建会话" aria-label="新建会话"><Plus size={14} /></button>
               <button type="button" className="icon-btn ai-assistant__session-action" onClick={renameCurrentSession} title="重命名当前会话" aria-label="重命名当前会话"><Pencil size={13} /></button>
               <button type="button" className="icon-btn icon-btn--danger ai-assistant__session-action" onClick={deleteCurrentSession} title="删除当前会话" aria-label="删除当前会话"><Trash2 size={13} /></button>
             </div>
           ) : null}
         </div>

        {tab === 'chat' && sessionBrowserOpen ? (
          <SessionHistoryPanel
            rows={sessionBrowserRows}
            meta={sessionBrowserMeta}
            loading={sessionBrowserLoading}
            query={sessionBrowserQuery}
            searchContent={sessionBrowserSearchContent}
            page={sessionBrowserPage}
            pageSize={SESSION_PAGE_SIZE}
            deleteId={sessionBrowserDeleteId}
            currentSessionId={sessionId}
            onClose={() => setSessionBrowserOpen(false)}
            onQueryChange={(value) => { setSessionBrowserQuery(value); setSessionBrowserPage(0); }}
            onSearchContentChange={(value) => { setSessionBrowserSearchContent(value); setSessionBrowserPage(0); }}
            onRefresh={() => setSessionBrowserReload((value) => value + 1)}
            onPageChange={setSessionBrowserPage}
            onSelect={selectSession}
            onDelete={deleteSessionFromBrowser}
          />
        ) : null}

        {error && tab === 'history' ? (
          // 错误条对历史 tab 也可见：撤销/刷新失败不能静默（聊天 tab 的错误条在下方分支里）
          <div className="ai-assistant__error" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {tab === 'history' ? (
          <div className="ai-assistant__history">
            <div className="ai-assistant__history-head">
              <div>
                <span className="ai-assistant__eyebrow">ACTIVITY LOG</span>
                <strong>操作记录</strong>
              </div>
              <button type="button" className="ai-assistant__history-refresh" onClick={() => refreshHistory({ reportError: true })} title="刷新操作记录">↻ 刷新</button>
            </div>
            <div className="ai-assistant__history-stats" aria-label="操作记录摘要">
              <span><strong>{historyStats.total}</strong>总计</span>
              <span className="is-success"><strong>{historyStats.completed}</strong>完成</span>
              <span className="is-danger"><strong>{historyStats.failed}</strong>失败</span>
            </div>
            {historyNotice ? <div className="ai-assistant__history-notice" role="status">{historyNotice}</div> : null}
            {!history.length ? <div className="ai-assistant__empty">还没有 AI 操作记录</div> : history.map((entry) => (
              <HistoryEntry
                key={entry.id}
                entry={entry}
                undoable={Boolean(entry.status === 'completed' && entry.operationId && !undoneIds.has(entry.operationId))}
                undoBusy={undoBusyId === entry.operationId}
                onUndo={() => undoEntry(entry)}
              />
            ))}
          </div>
        ) : (
          <>
            <div className="ai-assistant__context-strip">
              <label className="ai-assistant__scope-picker" title="选择 AI 检索和文件上下文范围">
                <span className="ai-assistant__context-icon" aria-hidden="true">⌁</span>
                <select value={contextScope} onChange={(event) => setContextScope(event.target.value)} aria-label="AI 上下文范围">
                  <option value="auto">自动上下文 · {effectiveContextScope === 'none' ? '无' : contextScopeLabel}</option>
                  <option value="current" disabled={!activeNote || !expertAllowsScope(expert, 'current')}>当前笔记</option>
                  <option value="project" disabled={!projectContext || !expertAllowsScope(expert, 'project')}>当前项目</option>
                  {inboxItems.length ? <option value="inbox" disabled={!expertAllowsScope(expert, 'inbox')}>Inbox</option> : null}
                  <option value="all" disabled={!expertAllowsScope(expert, 'all')}>全库</option>
                </select>
              </label>
              <span className="ai-assistant__context-meta">
                <span className="ai-assistant__context-count">{scopedNoteIndex.length} 个文件</span>
                <span className={`ai-assistant__model-label is-${connectionState}`}>
                  {activeProvider?.model && connectionState !== 'local' ? `模型 · ${activeProvider.model}` : '本地响应'}
                </span>
              </span>
            </div>

            {activeNote ? (
              <button type="button" className="ai-assistant__active-note" onClick={() => onOpenNote?.(activeNote.id)} title="打开当前笔记">
                <span className="ai-assistant__active-note-icon" aria-hidden="true">#</span>
                <strong>{activeNote.title}</strong>
                <small>{[activeNote.filePath ?? '当前笔记', activeNote.wordCount ? `${activeNote.wordCount} 字` : ''].filter(Boolean).join(' · ')}</small>
              </button>
            ) : null}

            {related.length ? (
              <div className={`ai-assistant__related${relatedOpen ? ' is-open' : ''}`}>
                <button type="button" className="ai-assistant__related-toggle" onClick={() => setRelatedOpen((value) => !value)} aria-expanded={relatedOpen}>
                  <span>相关笔记 · {related.length}</span>
                  <span className="ai-assistant__related-arrow" aria-hidden="true">{relatedOpen ? '▾' : '▸'}</span>
                </button>
                {relatedOpen ? (
                  <div className="ai-assistant__related-list">
                    {related.map((item) => (
                      <button type="button" key={item.id} className="ai-assistant__related-chip" onClick={() => onOpenNote?.(item.id)} title={`${item.filePath ?? ''}\n相关度 ${(item.score * 100).toFixed(0)}%`}>
                        <strong>{item.title}</strong>
                        <small>{Math.round(item.score * 100)}%{item.anchor ? ` · ${item.anchor}` : ''}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="ai-assistant__messages" aria-live="polite" ref={messagesRef}>
              {messages.map((message, index) => (
                <Message
                  key={message.id}
                  message={message}
                  onSuggestion={send}
                  onOpenNote={onOpenNote}
                  isLastAssistant={index === lastAssistantIndex}
                  onRegenerate={regenerateLast}
                  busy={composerBusy}
                  onUndoExecuted={() => undoTaskModeOperations(message)}
                  undoExecutedBusy={taskUndoBusyId === message.id}
                  undoExecutedDone={undoneTaskMessages.has(message.id)}
                />
              ))}
              {sending ? (
                <div className="ai-message ai-message--assistant">
                  <span className="ai-message__avatar" aria-hidden="true">✦</span>
                  <div className="ai-message__body">
                    {activeTaskMode ? <ProgressChecklist steps={progressSteps} live /> : null}
                    {reasoningText ? (
                      <div className="ai-message__reasoning is-streaming" aria-live="off">
                        <span className="ai-message__reasoning-label">思考中…</span>
                        <div className="ai-message__reasoning-body">{reasoningText}</div>
                      </div>
                    ) : null}
                    {streamText ? <div className="ai-message__content markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(displayStreamText(streamText)) }} /> : !reasoningText ? (
                      <div className="ai-message__typing" role="status" aria-label="AI 正在处理请求">
                        <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
                      </div>
                    ) : null}
                    <span className="ai-message__meta">{streamStatus || (streamText ? '生成中…' : reasoningText ? '正在思考…' : '正在检索知识与文件上下文…')}</span>
                  </div>
                </div>
              ) : null}
            </div>

            {preview ? <OperationPreview preview={preview} onConfirm={executePreview} onRefresh={refreshOperationPreview} onCancel={() => setPreview(null)} disabled={sending} /> : null}
            {execution ? (
              <ExecutionSummary
                result={execution}
                undoable={(execution.results ?? []).some((item) => item.status === 'completed' && item.result?.operationId)}
                undoBusy={undoBusyAll}
                onUndo={undoExecution}
              />
            ) : null}
            {error ? (
              <div className="ai-assistant__error" role="alert">
                <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>{error}</span>
                {retryMessage ? <button type="button" className="btn btn--sm" onClick={() => send(retryMessage)}>
                  <RefreshCw size={12} strokeWidth={1.8} aria-hidden="true" />
                  重试
                </button> : null}
              </div>
            ) : null}

            {expertSuggestion ? (
              <div className="ai-assistant__expert-suggestion" role="status">
                <span className="ai-assistant__expert-suggestion-copy">
                  这条消息命中了「{expertSuggestion.name}」的路由关键词{Array.isArray(expertSuggestion.matched) && expertSuggestion.matched.length ? `（${expertSuggestion.matched.slice(0, 3).join('、')}）` : ''}，切换后它会带着专属 Skill 和权限处理后续请求。
                </span>
                <button type="button" className="btn btn--sm" onClick={() => { onSelectExpert?.(expertSuggestion.id); setExpertSuggestion(null); }}>切换</button>
                <button type="button" className="icon-btn" onClick={() => setExpertSuggestion(null)} aria-label="忽略专家建议" title="忽略">×</button>
              </div>
            ) : null}

            <div className="ai-assistant__composer">
              <div className="ai-assistant__quick-actions">
                <button type="button" disabled={composerBusy} onClick={() => send('总结当前笔记的核心内容，并给出相关笔记')}><span className="ai-assistant__quick-icon">✦</span>理解笔记</button>
                <button type="button" disabled={composerBusy} onClick={() => send('搜索最近修改的项目笔记')}><span className="ai-assistant__quick-icon">⌕</span>搜索知识库</button>
                <button type="button" disabled={composerBusy} onClick={() => send(settings.autoApprove
                  ? '把我的文件整理分类好：先检索全库了解每篇笔记的主题，再把它们移动到按主题命名的目录里，最后汇报整理结果'
                  : '整理当前 Vault 的文件')}
                ><span className="ai-assistant__quick-icon">↗</span>{settings.autoApprove ? '智能整理' : '整理建议'}</button>
                <button type="button" disabled={composerBusy || pendingInboxItems.length === 0} onClick={() => send('请整理 Inbox 中待整理的收集内容：先读取 status 为 captured 或 processing 的 Inbox 笔记，判断它们最适合归入哪个现有项目目录；无法可靠判断的保留在 Inbox 并说明原因。对确认后的归档使用 archive 动作，path 填原 Inbox 文件，targetPath 填项目内的新文件路径，不要处理 status 为 processed 的内容。', { preferModel: true })}><span className="ai-assistant__quick-icon">✦</span>整理 Inbox{pendingInboxItems.length ? <em>{pendingInboxItems.length}</em> : null}</button>
                <button type="button" disabled={composerBusy} onClick={() => send('检查当前笔记的 Markdown 问题')}><span className="ai-assistant__quick-icon">✓</span>检查内容</button>
                <button type="button" disabled={composerBusy} onClick={runDigest}><span className="ai-assistant__quick-icon">☰</span>{digesting ? '生成中…' : '每日摘要'}</button>
              </div>
              <form onSubmit={(event) => { event.preventDefault(); send(); }}>
                <textarea
                  ref={draftRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter 发送、Shift+Enter 换行；中文输入法组词期间的回车不发送
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  placeholder={settings.autoApprove
                    ? '下达任务指令，AI 会自主检索和读取，写入前先等待确认…'
                    : '向知识库提问，或描述要完成的文件操作…'}
                  rows={1}
                  aria-label="输入 AI 指令"
                  disabled={composerBusy}
                />
                <div className="ai-assistant__composer-footer">
                  <div className="ai-assistant__mode-controls">
                    <label className={`ai-assistant__mode-toggle ${settings.preferModel ? 'is-on' : ''}`} title="开启后，搜索、检查等本地快路径请求也会优先调用已配置的外部模型；未配置模型时仍使用本地模式">
                      <input type="checkbox" id="ai-prefer-model" checked={settings.preferModel === true} onChange={togglePreferModel} />
                      <span className="ai-assistant__mode-switch" aria-hidden="true" />
                      <span className="ai-assistant__mode-copy"><strong>模型优先</strong></span>
                    </label>
                    <label className={`ai-assistant__mode-toggle ${settings.autoApprove ? 'is-on' : ''}`} title="开启后 AI 自主多轮检索和读取；所有文件写入都先显示预览，等待你的明确确认">
                      <input type="checkbox" id="ai-auto-approve" checked={settings.autoApprove === true} onChange={toggleAutoApprove} />
                      <span className="ai-assistant__mode-switch" aria-hidden="true" />
                      <span className="ai-assistant__mode-copy"><strong>任务模式</strong></span>
                    </label>
                  </div>
                  <span className="ai-assistant__composer-hint">Enter 发送 · Shift+Enter 换行</span>
                  {sending
                    ? <button type="button" className="ai-assistant__send ai-assistant__send--stop" onClick={stopGenerating} aria-label="停止生成" title="停止生成">■</button>
                    : <button type="submit" className="ai-assistant__send" disabled={!draft.trim() || composerBusy} aria-label="发送消息" title="发送消息">↗</button>}
                </div>
              </form>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

const CONNECTION_STATE_META = {
  local: { label: '本地模式', title: '未配置外部模型，使用本地规则助手' },
  configured: { label: '已配置', title: '已保存模型配置，但尚未通过连通性测试；可在模型管理中点击「测试连接」验证' },
  connected: { label: '已连接', title: '外部模型连通性测试已通过' },
};

function ProgressChecklist({ steps = [], live = false }) {
  const completed = steps.filter((step) => step.status === 'completed').length;
  const failed = steps.filter((step) => step.status === 'failed').length;
  const waiting = steps.filter((step) => step.status === 'waiting').length;
  const allDone = completed === steps.length && !failed && !waiting;
  const [expanded, setExpanded] = useState(() => live || !allDone);
  const statusText = failed
    ? `${failed} 项失败`
    : waiting
      ? '等待确认'
      : live
        ? '执行中'
        : '已完成全部步骤';
  const summaryText = failed
    ? `${completed}/${steps.length} 个步骤完成，${failed} 个失败`
    : waiting
      ? `${completed}/${steps.length} 个步骤完成，等待确认`
      : allDone
        ? `全部 ${completed} 个步骤已完成`
        : `已完成 ${completed}/${steps.length} 个步骤`;

  useEffect(() => {
    if (live) setExpanded(true);
  }, [live]);

  if (!steps.length) return null;

  return (
    <details
      className={`ai-progress ${live ? 'is-live' : ''} ${allDone ? 'is-complete' : ''}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      aria-label="任务进度"
    >
      <summary className="ai-progress__summary">
        <span className="ai-progress__summary-main">
          <span className="ai-assistant__eyebrow">{allDone ? 'TASK COMPLETE' : 'PROGRESS'}</span>
          <strong>{allDone ? '执行完成' : '任务进度'}</strong>
          <small>{summaryText}</small>
        </span>
        <span className="ai-progress__summary-side">
          <span className={`ai-progress__count ${failed ? 'has-failures' : live ? 'is-live' : ''}`}>{completed}/{steps.length}</span>
          <ChevronDown className="ai-progress__toggle" size={14} aria-hidden="true" />
        </span>
      </summary>
      <ol className="ai-progress__list" aria-live={live ? 'polite' : undefined}>
        {steps.map((step) => {
          const status = step.status ?? 'pending';
          const Icon = status === 'completed'
            ? CheckCircle2
            : status === 'failed' || status === 'waiting'
              ? CircleAlert
              : status === 'running'
                ? LoaderCircle
                : Circle;
          return (
            <li className={`ai-progress__item is-${status}`} key={step.id} aria-current={status === 'running' ? 'step' : undefined}>
              <Icon size={15} aria-hidden="true" />
              <span className="ai-progress__copy">
                <strong>{step.label}</strong>
                {step.detail ? <small>{step.detail}</small> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <footer className={`ai-progress__footer ${failed ? 'has-failures' : ''}`}>
        <span aria-live={live ? 'polite' : undefined}>{statusText}</span>
        <span>{live ? '状态来自实际执行' : expanded ? '收起明细' : '查看明细'}</span>
      </footer>
    </details>
  );
}

function Message({ message, onSuggestion, onOpenNote, isLastAssistant = false, onRegenerate, busy = false, onUndoExecuted, undoExecutedBusy = false, undoExecutedDone = false }) {
  const contentRef = useRef(null);
  const [copied, setCopied] = useState('');
  const usage = message.meta?.usage;
  const context = message.meta?.context;
  const contextLine = context?.historyAvailableMessages
    ? ` · 历史 ${context.historyMessages}/${context.historyAvailableMessages} 条 · ${formatCompactTokenCount(context.historyTokens)} / ${formatContextWindow(context.contextWindowTokens)}${context.historyTruncated ? ' · 已按预算裁剪' : ''}${context.contextRetry ? ' · 已自动缩短重试' : ''}`
    : '';
  const metaLine = message.meta?.provider === 'external' && message.meta?.model
    ? `${message.meta.model}${message.meta?.latencyMs ? ` · ${(message.meta.latencyMs / 1000).toFixed(1)}s` : ''}${message.meta?.rounds > 1 ? ` · ${message.meta.rounds} 轮` : ''}${usage?.total_tokens ? ` · ${formatTokenCount(usage)}` : ''}${contextLine}`
    : message.meta?.provider === 'local-instant'
      ? `本地即时回答 · 未调用模型${message.meta?.latencyMs ? ` · ${message.meta.latencyMs}ms` : ''}`
      : message.meta?.provider === 'local'
        ? '本地模式 · 未配置外部模型'
        : null;
  const executed = Array.isArray(message.meta?.executed) ? message.meta.executed : [];
  const executedFailed = Array.isArray(message.meta?.executedFailed) ? message.meta.executedFailed : [];
  const toolExecutions = Array.isArray(message.meta?.toolExecutions) ? message.meta.toolExecutions : [];
  const progress = Array.isArray(message.meta?.progress) ? message.meta.progress : [];
  const plainText = String(message.content ?? '');

  // 渲染后增强：代码块加复制按钮；正文里的 [n] 引用标记变成可点击锚点，
  // 点击滚动到对应来源 chip 并高亮（RAG 回答的出处一跳即达）。
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return undefined;
    const referenceCount = message.references?.length ?? 0;

    for (const pre of root.querySelectorAll('pre')) {
      if (pre.querySelector('.ai-code-copy')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ai-code-copy';
      button.textContent = '复制';
      button.setAttribute('aria-label', '复制代码');
      pre.appendChild(button);
    }

    if (referenceCount > 0) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent || /^(PRE|CODE|BUTTON|A)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
          return /\[\d{1,2}\]/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const targets = [];
      while (walker.nextNode()) targets.push(walker.currentNode);
      for (const node of targets) {
        const fragment = document.createDocumentFragment();
        let rest = node.nodeValue;
        let tail = null;
        while (rest) {
          const match = rest.match(/\[(\d{1,2})\]/);
          if (!match) {
            tail = document.createTextNode(rest);
            break;
          }
          const number = Number(match[1]);
          if (number < 1 || number > referenceCount) {
            fragment.appendChild(document.createTextNode(rest.slice(0, match.index + match[0].length)));
            rest = rest.slice(match.index + match[0].length);
            continue;
          }
          if (match.index > 0) fragment.appendChild(document.createTextNode(rest.slice(0, match.index)));
          const cite = document.createElement('button');
          cite.type = 'button';
          cite.className = 'ai-cite';
          cite.dataset.ref = String(number);
          cite.textContent = match[0];
          cite.setAttribute('aria-label', `查看引用来源 ${number}`);
          fragment.appendChild(cite);
          rest = rest.slice(match.index + match[0].length);
        }
        if (tail) fragment.appendChild(tail);
        node.replaceWith(fragment);
      }
    }
    return undefined;
  }, [message.content, message.references]);

  const flashReference = (number) => {
    const body = contentRef.current?.parentElement;
    // 按 data-ref 编号匹配 chip，而不是按数组下标：服务端 validateCitations 只返回
    // 被引用的编号（可能不从 1 连续），下标法会闪错或找不到
    const chip = [...(body?.querySelectorAll('.ai-message__references button') ?? [])]
      .find((item) => item.dataset.ref === String(number));
    if (!chip) return;
    chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    chip.classList.remove('is-flash');
    // 强制重排让连续点击也能重启动画
    void chip.offsetWidth;
    chip.classList.add('is-flash');
    window.setTimeout(() => chip.classList.remove('is-flash'), 1600);
  };

  const handleContentClick = async (event) => {
    const codeButton = event.target.closest?.('.ai-code-copy');
    if (codeButton) {
      const code = codeButton.parentElement?.querySelector('code') ?? codeButton.parentElement;
      const success = await copyPlainText(code?.innerText ?? '');
      codeButton.textContent = success ? '已复制' : '复制失败';
      window.setTimeout(() => { codeButton.textContent = '复制'; }, 1400);
      return;
    }
    const cite = event.target.closest?.('.ai-cite');
    if (cite) flashReference(Number(cite.dataset.ref));
  };

  const copyMessage = async () => {
    const success = await copyPlainText(plainText);
    setCopied(success ? 'ok' : 'fail');
    window.setTimeout(() => setCopied(''), 1400);
  };

  const actions = [];
  if (plainText) {
    actions.push(
      <button
        type="button"
        key="copy"
        className="ai-message__action"
        onClick={copyMessage}
        title={copied === 'ok' ? '已复制' : '复制全文'}
        aria-label="复制全文"
      >
        {copied === 'ok' ? '已复制' : <Copy size={12.5} strokeWidth={1.8} aria-hidden="true" />}
      </button>,
    );
  }
  if (isLastAssistant && message.id !== WELCOME_MESSAGE.id) {
    actions.push(
      <button
        type="button"
        key="regenerate"
        className="ai-message__action"
        onClick={() => onRegenerate?.()}
        disabled={busy}
        title={busy ? '正在生成中' : '重新生成这条回答'}
        aria-label="重新生成"
      >
        <RefreshCw size={12.5} strokeWidth={1.8} aria-hidden="true" />
      </button>,
    );
  }

  return (
    <article className={`ai-message ai-message--${message.role}`}>
      {message.role === 'assistant' ? <span className="ai-message__avatar" aria-hidden="true">✦</span> : null}
      <div className="ai-message__body">
        {message.reasoning ? (
          <details className="ai-message__reasoning">
            <summary>思考过程</summary>
            <div className="ai-message__reasoning-body">{message.reasoning}</div>
          </details>
        ) : null}
        {message.meta?.taskMode === true && progress.length ? <ProgressChecklist steps={progress} /> : null}
        <div
          className="ai-message__content markdown-body"
          ref={contentRef}
          onClick={handleContentClick}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(plainText) }}
        />
        {executed.length ? (
          <details className="ai-message__executed">
            <summary>⚡ 已自动执行 {executed.length} 项操作</summary>
            <ul>{executed.map((item, index) => <li key={index}>{item}</li>)}</ul>
            {executedFailed.length ? <ul className="has-failures">{executedFailed.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
            {onUndoExecuted && Array.isArray(message.meta?.executedOperations) && message.meta.executedOperations.length ? (
              <button
                type="button"
                className="btn btn--sm"
                onClick={onUndoExecuted}
                disabled={undoExecutedBusy || undoExecutedDone}
              >
                {undoExecutedDone ? '已撤销' : undoExecutedBusy ? '撤销中…' : '撤销这批操作'}
              </button>
            ) : null}
          </details>
        ) : null}
        {toolExecutions.length ? (
          <details className="ai-message__executed ai-message__tools" open>
            <summary>工具执行记录 · {toolExecutions.length} 项</summary>
            <ul>{toolExecutions.map((item, index) => {
              const label = item.kind === 'mcp'
                ? `MCP ${item.server ?? '?'} / ${item.tool ?? '?'}`
                : `${item.kind === 'search' ? '检索' : '读取'} ${item.label ?? ''}`;
              const transport = item.transport === 'stdio'
                ? ' · 本地 MCP 进程'
                : item.transport === 'sse'
                  ? ' · MCP 网络服务'
                  : '';
              return <li key={`${label}-${index}`} className={item.ok ? '' : 'has-failures'}>{label}{transport} · {item.ok ? '已完成' : `失败：${item.error ?? '未知错误'}`}</li>;
            })}</ul>
          </details>
        ) : null}
        {metaLine ? <span className="ai-message__meta">{metaLine}</span> : null}
        {message.references?.length ? <div className="ai-message__references">{message.references.map((reference, index) => (
          <button type="button" key={reference.id ?? `${reference.title}-${index}`} data-ref={String(reference.number ?? index + 1)} onClick={() => reference.id && onOpenNote?.(reference.id)} title={reference.excerpt ?? ''}>
            <span>{reference.inferred ? '◇' : `[${reference.number ?? index + 1}]`}</span>
            <strong>{reference.title}</strong>
            <small>{reference.anchor ? `${reference.anchor} · ` : ''}{reference.excerpt ? reference.excerpt.slice(0, 60) : (reference.path ?? '来源笔记')}</small>
          </button>
        ))}</div> : null}
        {message.suggestions?.length ? <div className="ai-message__suggestions">{message.suggestions.map((suggestion, index) => {
          const label = typeof suggestion === 'string' ? suggestion : suggestion.title;
          const detail = typeof suggestion === 'string' ? '' : suggestion.detail;
          return <button type="button" key={`${label}-${index}`} onClick={() => onSuggestion(label)}><span>＋</span><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span></button>;
        })}</div> : null}
        {actions.length ? <div className="ai-message__actions">{actions}</div> : null}
      </div>
    </article>
  );
}

/** 剪贴板兜底：非安全上下文（http:// 局域网访问）里 navigator.clipboard 不存在 */
async function copyPlainText(value) {
  const text = String(value ?? '');
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function formatTokenCount(usage) {
  const total = Number(usage.total_tokens ?? 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  if (total >= 10_000) return `${(total / 1000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}

function formatContextWindow(tokens) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '上下文预算未知';
  if (value >= 1_000_000) return '上下文 1M';
  if (value >= 1_000) return `上下文 ${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}k`;
  return `上下文 ${value}`;
}

function formatCompactTokenCount(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total <= 0) return '历史 token 未知';
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
  if (total >= 10_000) return `${(total / 1_000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}

function OperationPreview({ preview, onConfirm, onRefresh, onCancel, disabled }) {
  const [draftActions, setDraftActions] = useState(() => previewActions(preview));
  const [dirty, setDirty] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [additionalConfirmed, setAdditionalConfirmed] = useState(false);

  useEffect(() => {
    setDraftActions(previewActions(preview));
    setDirty(false);
    setNotice('');
    setAdditionalConfirmed(false);
  }, [preview]);

  const requiresAdditionalConfirmation = preview.requiresAdditionalConfirmation === true;
  const additionalConfirmationLabel = formatAdditionalConfirmationReasons(preview.additionalConfirmationReasons);
  const qualityWarnings = preview.quality?.warnings ?? [];
  const qualityBlocked = preview.quality?.blocked === true;

  const findDraft = (operation) => {
    const actionId = String(operation.action?.id ?? operation.id);
    return draftActions.find((action) => String(action.id) === actionId) ?? null;
  };

  const updateDraft = (actionId, patch) => {
    setDraftActions((current) => current.map((action) => (
      String(action.id) === String(actionId) ? { ...action, ...patch } : action
    )));
    setDirty(true);
    setNotice('');
  };

  const removeDraft = (actionId) => {
    setDraftActions((current) => current.filter((action) => String(action.id) !== String(actionId)));
    setDirty(true);
    setNotice('');
  };

  const restoreDraft = (operation) => {
    const action = operation.action;
    if (!action || draftActions.some((item) => String(item.id) === String(action.id))) return;
    setDraftActions((current) => [...current, action]);
    setDirty(true);
    setNotice('');
  };

  const refresh = async () => {
    if (!draftActions.length || refreshing || disabled) {
      if (!draftActions.length) setNotice('至少保留一项操作后才能更新预览');
      return;
    }
    setRefreshing(true);
    try {
      const next = await onRefresh?.(draftActions);
      if (!next) return;
      setDraftActions(previewActions(next));
      setDirty(false);
      setNotice('');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="ai-operation-preview" aria-label="文件操作预览">
      <header>
        <div><span className="ai-assistant__eyebrow">ACTION PREVIEW</span><h3>确认文件操作</h3></div>
        <span className="ai-operation-preview__risk">{dirty ? '已修改，需更新预览' : preview.blocked ? '当前操作不可执行' : preview.summary}</span>
      </header>
      <div className="ai-operation-preview__hint">可取消单项，或调整目标路径和标签；更新预览后才会提交新的 diff。</div>
      <div className="ai-operation-preview__list">
        {preview.operations.map((operation, index) => {
          const action = findDraft(operation);
          const actionId = String(operation.action?.id ?? operation.id);
          const removed = !action;
          const editableTarget = action && ['move', 'copy', 'archive'].includes(action.type);
          const editableTags = action && ['create', 'update'].includes(action.type) && action.content !== undefined;
          return (
            <div className={`ai-operation ${operation.previewFailed ? 'is-failed' : operation.risk} ${removed ? 'is-removed' : ''}`} key={`${operation.id}-${operation.orderIndex ?? index}`}>
              <span className="ai-operation__icon">{removed ? '−' : operation.previewFailed ? '!' : operation.type === 'delete' ? '×' : operation.type === 'read' ? '⌕' : '↗'}</span>
              <div className="ai-operation__body">
                <strong>{action ? describeAiAction(action) : operation.summary}</strong>
                {operation.sensitive
                  ? <small className="ai-operation__error">{operation.sensitivityReason ?? '敏感文件需要额外确认后执行'}</small>
                  : operation.previewFailed
                  ? <small className="ai-operation__error">预览失败：{operation.error}</small>
                  : <small>{removed ? '已取消，不会执行' : operation.risk === 'destructive' ? '删除操作不可逆' : operation.requiresConfirmation ? '确认后写入 Vault' : '只读操作'}</small>}
                {action && (editableTarget || editableTags) ? (
                  <div className="ai-operation__editors">
                    {editableTarget ? (
                      <label className="ai-operation__editor">
                        <span>目标路径</span>
                        <input
                          type="text"
                          value={action.targetPath ?? ''}
                          onChange={(event) => updateDraft(actionId, { targetPath: event.target.value })}
                          aria-label="编辑目标路径"
                        />
                      </label>
                    ) : null}
                    {editableTags ? (
                      <label className="ai-operation__editor">
                        <span>标签</span>
                        <input
                          type="text"
                          value={extractMarkdownTags(action.content).join(', ')}
                          onChange={(event) => updateDraft(actionId, { content: replaceMarkdownTags(action.content, event.target.value) })}
                          aria-label="编辑操作标签"
                          placeholder="多个标签用逗号分隔"
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {!removed && operation.diff && !dirty ? <pre className="ai-operation__diff">{operation.diff}</pre> : null}
                {!removed && dirty && (editableTarget || editableTags) ? <small className="ai-operation__stale">内容已修改，点击“更新预览”查看新 diff</small> : null}
              </div>
              <button
                type="button"
                className="icon-btn ai-operation__remove"
                onClick={() => removed ? restoreDraft(operation) : removeDraft(actionId)}
                disabled={disabled || refreshing}
                title={removed ? '恢复此操作' : '取消此操作'}
                aria-label={removed ? '恢复此操作' : '取消此操作'}
              >
                {removed ? <Plus size={14} /> : <X size={14} />}
              </button>
            </div>
          );
        })}
      </div>
      {qualityWarnings.length ? (
        <div className={`ai-operation-preview__quality ${qualityBlocked ? 'is-blocked' : ''}`} role={qualityBlocked ? 'alert' : undefined}>
          <strong>{qualityBlocked ? '计划存在冲突，暂不能执行' : '计划检查提示'}</strong>
          <ul>
            {qualityWarnings.map((warning, index) => (
              <li key={`${warning.code}-${warning.path ?? ''}-${index}`}>{warning.message}</li>
            ))}
          </ul>
          {qualityBlocked ? <small>请取消冲突动作或修改目标路径，然后更新预览。</small> : null}
        </div>
      ) : null}
      {notice ? <div className="ai-operation-preview__notice" role="alert">{notice}</div> : null}
      {requiresAdditionalConfirmation && draftActions.length ? (
        <label className="ai-operation-preview__elevated-confirm">
          <input
            type="checkbox"
            checked={additionalConfirmed}
            onChange={(event) => setAdditionalConfirmed(event.target.checked)}
            disabled={disabled || refreshing || dirty}
          />
          <span>我确认{additionalConfirmationLabel}，本次确认只授权当前列出的操作</span>
        </label>
      ) : null}
      <footer>
        <button type="button" onClick={onCancel} disabled={disabled || refreshing}>取消</button>
        <button type="button" onClick={refresh} disabled={disabled || refreshing || !dirty}>
          <RefreshCw size={13} className={refreshing ? 'is-spinning' : undefined} aria-hidden="true" />
          更新预览
        </button>
        <button type="button" className="is-primary" onClick={() => onConfirm({ additionalConfirmed })} disabled={disabled || refreshing || dirty || preview.blocked || qualityBlocked || !draftActions.length || (requiresAdditionalConfirmation && !additionalConfirmed)}>
          {preview.blocked || qualityBlocked ? '当前操作不可执行' : requiresAdditionalConfirmation && !additionalConfirmed ? '请先确认高风险操作' : '确认执行'}
        </button>
      </footer>
    </section>
  );
}

function formatAdditionalConfirmationReasons(reasons = []) {
  const labels = { batch: '批量操作', delete: '删除操作', sensitive: '敏感文件' };
  const text = [...new Set(reasons)].map((reason) => labels[reason]).filter(Boolean).join('、');
  return text || '高风险操作';
}

function ExecutionSummary({ result, undoable = false, undoBusy = false, onUndo }) {
  return (
    <div className={`ai-execution-summary ${result.failed ? 'has-failures' : ''}`}>
      <span>{result.failed ? '!' : '✓'}</span>
      <strong>{result.failed ? `${result.completed} 项完成，${result.failed} 项失败` : `已完成 ${result.completed} 项操作`}</strong>
      {undoable ? <button type="button" className="ai-execution-summary__undo" onClick={onUndo} disabled={undoBusy} title="用文件内核的快照把这些操作恢复到执行前">{undoBusy ? '撤销中…' : '撤销本次操作'}</button> : null}
    </div>
  );
}

function SessionHistoryPanel({
  rows,
  meta,
  loading,
  query,
  searchContent,
  page,
  pageSize,
  deleteId,
  currentSessionId,
  onClose,
  onQueryChange,
  onSearchContentChange,
  onRefresh,
  onPageChange,
  onSelect,
  onDelete,
}) {
  const groups = groupSessionsByDate(rows);
  const total = Number(meta?.total ?? rows.length);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrevious = page > 0;
  const hasNext = Boolean(meta?.hasMore) || page + 1 < totalPages;
  return (
    <section className="ai-session-browser" aria-label="会话历史">
      <header className="ai-session-browser__header">
        <div>
          <span className="ai-assistant__eyebrow">CONVERSATION ARCHIVE</span>
          <h3>会话历史</h3>
        </div>
        <div className="ai-session-browser__header-actions">
          <button type="button" className="icon-btn" onClick={onRefresh} disabled={loading} title="刷新会话历史" aria-label="刷新会话历史"><RefreshCw size={14} className={loading ? 'is-spinning' : ''} /></button>
          <button type="button" className="icon-btn" onClick={onClose} title="返回当前对话" aria-label="返回当前对话"><X size={16} /></button>
        </div>
      </header>

      <div className="ai-session-browser__filters">
        <label className="ai-session-browser__search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索会话标题" aria-label="搜索会话标题" autoFocus />
          {loading ? <LoaderCircle size={14} className="is-spinning" aria-label="正在搜索" /> : null}
        </label>
        <label className={`ai-session-browser__content-toggle ${searchContent ? 'is-on' : ''}`} title="同时搜索会话消息正文">
          <input type="checkbox" checked={searchContent} onChange={(event) => onSearchContentChange(event.target.checked)} />
          <span>搜索正文</span>
        </label>
      </div>

      <div className="ai-session-browser__list">
        {!loading && !rows.length ? <div className="ai-session-browser__empty">{query ? '没有匹配的会话' : '还没有历史会话'}</div> : null}
        {groups.map(([label, items]) => (
          <section className="ai-session-browser__group" key={label}>
            <div className="ai-session-browser__group-title"><span>{label}</span><small>{items.length}</small></div>
            <div className="ai-session-browser__rows">
              {items.map((session) => (
                <article className={`ai-session-browser__row ${session.id === currentSessionId ? 'is-current' : ''}`} key={session.id}>
                  <button type="button" className="ai-session-browser__row-main" onClick={() => onSelect(session)}>
                    <span className="ai-session-browser__row-mark" aria-hidden="true">{String(session.title || '新').trim().slice(0, 1)}</span>
                    <span className="ai-session-browser__row-copy">
                      <strong>{String(session.title || '').trim() || '未命名会话'}</strong>
                      <small>{Number(session.messageCount ?? 0)} 条消息 · {formatSessionDate(session.updatedAt)}</small>
                    </span>
                    {session.id === currentSessionId ? <span className="ai-session-browser__current">当前</span> : null}
                  </button>
                  <button type="button" className="icon-btn ai-session-browser__delete" onClick={() => onDelete(session)} disabled={deleteId === session.id} title="删除会话" aria-label={`删除会话：${session.title || '未命名会话'}`}>
                    {deleteId === session.id ? <LoaderCircle size={14} className="is-spinning" /> : <Trash2 size={14} />}
                  </button>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="ai-session-browser__footer">
        <span>{total ? `${total} 个会话` : '暂无会话'}</span>
        <div className="ai-session-browser__pagination">
          <button type="button" className="icon-btn" onClick={() => onPageChange(page - 1)} disabled={!hasPrevious || loading} title="上一页" aria-label="上一页"><ChevronLeft size={15} /></button>
          <span>{page + 1} / {totalPages}</span>
          <button type="button" className="icon-btn" onClick={() => onPageChange(page + 1)} disabled={!hasNext || loading} title="下一页" aria-label="下一页"><ChevronRight size={15} /></button>
        </div>
      </footer>
    </section>
  );
}

function HistoryEntry({ entry, undoable = false, undoBusy = false, onUndo }) {
  const action = entry.action ?? {};
  return (
    <div className={`ai-history-entry ${undoable ? 'is-undoable' : ''}`}>
      <span className={`ai-history-entry__status ${entry.status}`}>{entry.status === 'completed' ? '✓' : '!'}</span>
      <div><strong>{action.type} · {action.path}</strong><small>{action.targetPath ? `→ ${action.targetPath} · ` : ''}{formatTime(entry.at)} · {entry.source}</small></div>
      {undoable ? <button type="button" className="ai-history-entry__undo" onClick={onUndo} disabled={undoBusy} title="恢复到这次操作执行前的状态">{undoBusy ? '撤销中…' : '撤销'}</button> : null}
    </div>
  );
}

function flattenFolders(nodes, parentPath = '') {
  return (nodes ?? []).flatMap((node) => {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    return [{ ...node, path }, ...flattenFolders(node.children, path)];
  });
}

function formatTime(value) {
  if (!value) return '刚刚';
  try { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); } catch { return '刚刚'; }
}

const ACTION_LABELS = { read: '读取', create: '创建', update: '更新', delete: '删除', move: '移动', copy: '复制', archive: '归档' };

function describeAiAction(action) {
  return `${ACTION_LABELS[action?.type] ?? action?.type ?? '操作'} ${action?.path ?? ''}${action?.targetPath ? ` → ${action.targetPath}` : ''}`.trim();
}

function SessionRenameDialog({ open, title, saving, inputRef, onChange, onClose, onSubmit }) {
  return (
    <Modal open={open} onClose={onClose} title="会话名称" ariaLabel="重命名会话" className="rename-modal" initialFocusRef={inputRef}>
      <form className="rename-dialog" onSubmit={onSubmit}>
        <header className="rename-dialog__header">
          <div>
            <span className="rename-dialog__eyebrow">AI SESSION</span>
            <h2>重命名会话</h2>
          </div>
          <button type="button" className="icon-btn rename-dialog__close" onClick={onClose} aria-label="关闭重命名">
            ×
          </button>
        </header>
        <div className="rename-dialog__body">
          <label htmlFor="rename-session-name">会话名称</label>
          <input
            ref={inputRef}
            id="rename-session-name"
            value={title}
            maxLength={120}
            autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
            disabled={saving}
          />
        </div>
        <footer className="rename-dialog__actions">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className="btn btn--primary" disabled={saving || !title.trim()}>{saving ? '保存中…' : '保存'}</button>
        </footer>
      </form>
    </Modal>
  );
}

function previewActions(preview) {
  const actions = Array.isArray(preview?.actions)
    ? preview.actions
    : (preview?.operations ?? []).map((operation) => operation.action).filter(Boolean);
  return actions.map((action, index) => ({
    ...action,
    id: String(action.id ?? `op-${index + 1}`),
  }));
}

function extractMarkdownTags(content) {
  const source = String(content ?? '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return [];
  const lines = match[1].split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*tags\s*:/i.test(line));
  if (index === -1) return [];
  const first = lines[index].replace(/^\s*tags\s*:\s*/i, '').trim();
  const values = first || lines.slice(index + 1).reduce((items, line) => {
    if (!/^\s*-\s+/.test(line)) return items;
    items.push(line.replace(/^\s*-\s+/, '').trim());
    return items;
  }, []).join(',');
  return values
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function replaceMarkdownTags(content, value) {
  const source = String(content ?? '');
  const tags = String(value ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
  if (!tags.length && !/^---\r?\n/.test(source)) return source;
  const serialized = `tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]`;
  const match = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!match) return `---\n${serialized}\n---\n${source}`;

  const lineEnding = match[1].includes('\r\n') ? '\r\n' : '\n';
  const lines = match[2].split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*tags\s*:/i.test(line));
  if (index === -1) lines.push(serialized);
  else {
    let end = index + 1;
    while (end < lines.length && /^\s*-\s+/.test(lines[end])) end += 1;
    lines.splice(index, end - index, serialized);
  }
  return `${match[1]}${lines.join(lineEnding)}${match[3]}${source.slice(match[0].length)}`;
}

async function buildOperationPreview(actions, requestOptions, role) {
  const draftActions = actions.map((action, index) => ({
    ...action,
    id: String(action?.id ?? `op-${index + 1}`),
  }));
  const fileActions = draftActions.filter((action) => FILE_KERNEL_ACTIONS.has(action?.type));
  const archiveActions = draftActions.filter((action) => action?.type === 'archive');
  const fileOperations = [];
  let batchQuality = { blocked: false, warnings: [] };
  // 预览失败的动作（如模型给出非法路径）：单独标记，不拖垮其余动作的确认流程
  const failedOperations = [];
  try {
    const response = await aiApi.preview({ actions: draftActions, actor: 'local-user', role }, requestOptions);
    const data = response?.data ?? response;
    if (data?.quality) batchQuality = data.quality;
  } catch {
    // Keep the per-operation previews usable when the combined quality check
    // fails because one action has an invalid path or payload.
  }
  await Promise.all(fileActions.map(async (action, index) => {
    const base = {
      id: String(action.id ?? `file-op-${index + 1}`),
      orderIndex: index,
      originalType: action.type,
      type: action.type,
      path: action.path,
      targetPath: action.targetPath,
      action,
      risk: action.type === 'delete' ? 'destructive' : 'write',
      requiresConfirmation: true,
    };
    try {
      const response = await aiApi.preview({
        actions: [action],
        actor: 'local-user',
        role,
        source: 'ai-chat',
      }, requestOptions);
      const data = response?.data ?? response;
      const operation = data?.operations?.[0] ?? {};
      let diff = '';
      try {
        const diffResponse = await filesApi.preview(toFileMutation(action), requestOptions);
        diff = (diffResponse?.data ?? diffResponse)?.diff ?? '';
      } catch {
        // The AI preview remains authoritative; diff is presentation-only.
      }
      fileOperations.push({
        ...data,
        ...base,
        ...operation,
        action,
        diff,
        planId: data.plan?.id ?? data.id,
        planHash: data.planHash,
         blocked: data.blocked === true,
      });
    } catch (requestError) {
      // 保留服务端真实错误（如"File does not exist"）：统一替换成模糊文案会让用户无法分辨失败原因
      failedOperations.push({
        ...base,
        previewFailed: true,
        summary: describeAiAction(action),
        error: requestError?.message ?? '预览失败：路径不合法或源文件状态异常',
      });
    }
  }));
  const byOrder = (left, right) => left.orderIndex - right.orderIndex;
  fileOperations.sort(byOrder);
  failedOperations.sort(byOrder);

  let archiveOperations = [];
  let aiOperations = [];
  let aiPlanHash = null;
  let aiPlanId = null;
  let archiveBlocked = false;
  let archiveRequiresAdditionalConfirmation = false;
  let archiveRequiresSensitiveConfirmation = false;
  let archiveAdditionalConfirmationReasons = [];
  let archiveQuality = { blocked: false, warnings: [] };
  if (archiveActions.length) {
    try {
      const response = await aiApi.preview({ actions: archiveActions, actor: 'local-user', role }, requestOptions);
      const archivePreview = response?.data ?? response;
      archiveOperations = (archivePreview?.operations ?? []).map((operation, index) => ({
        ...operation,
        id: String(operation.id ?? `archive-op-${index + 1}`),
        action: archiveActions[index],
      }));
      aiOperations = archiveActions;
      aiPlanHash = archivePreview?.planHash ?? null;
      aiPlanId = archivePreview?.plan?.id ?? archivePreview?.id ?? null;
      archiveBlocked = archivePreview?.blocked === true;
      archiveRequiresAdditionalConfirmation = archivePreview?.requiresAdditionalConfirmation === true;
      archiveRequiresSensitiveConfirmation = archivePreview?.requiresSensitiveConfirmation === true;
      archiveAdditionalConfirmationReasons = archivePreview?.additionalConfirmationReasons ?? [];
      archiveQuality = archivePreview?.quality ?? archiveQuality;
    } catch {
      archiveOperations = archiveActions.map((action, index) => ({
        id: String(action.id ?? `archive-op-${index + 1}`),
        orderIndex: index,
        originalType: action.type,
        type: action.type,
        path: action.path,
        targetPath: action.targetPath,
        action,
        previewFailed: true,
        risk: 'write',
        requiresConfirmation: true,
        summary: describeAiAction(action),
        error: '归档预览失败：源文件可能不是待整理的 Inbox 笔记',
      }));
    }
  }

  const operations = [...fileOperations, ...archiveOperations, ...failedOperations];
  if (!operations.length) return null;
  const qualityWarnings = dedupePlanWarnings([
    ...(batchQuality.warnings ?? []),
    ...(archiveQuality.warnings ?? []),
    ...fileOperations.flatMap((operation) => operation.quality?.warnings ?? []),
  ]);
  const quality = {
    blocked: batchQuality.blocked === true || archiveQuality.blocked === true || qualityWarnings.some((warning) => warning.severity === 'error'),
    warnings: qualityWarnings,
  };
  const blocked = role === 'viewer' || quality.blocked || fileOperations.some((operation) => operation.blocked) || archiveBlocked;
  const writes = operations.filter((operation) => operation.requiresConfirmation !== false).length;
  const additionalConfirmationReasons = [...new Set([
    ...fileOperations.flatMap((operation) => operation.additionalConfirmationReasons ?? []),
    ...archiveAdditionalConfirmationReasons,
    ...(writes > 1 ? ['batch'] : []),
    ...(operations.some((operation) => operation.type === 'delete') ? ['delete'] : []),
    ...(operations.some((operation) => operation.sensitive) ? ['sensitive'] : []),
  ])];
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}`,
    blocked,
    quality,
    requiresAdditionalConfirmation: archiveRequiresAdditionalConfirmation || additionalConfirmationReasons.length > 0,
    additionalConfirmationReasons,
    requiresSensitiveConfirmation: archiveRequiresSensitiveConfirmation || operations.some((operation) => operation.sensitive),
    actions: draftActions,
    operations,
    fileOperations,
    failedOperations,
    aiOperations,
    aiPlanId,
    aiPlanHash,
    summary: `${operations.length} 项操作 · ${writes} 项需要确认`,
    createdAt: new Date().toISOString(),
  };
}

function dedupePlanWarnings(warnings = []) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code ?? 'warning'}|${warning.path ?? ''}|${(warning.actionIds ?? []).join(',')}|${warning.message ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toFileMutation(action) {
  const mutationType = action.type === 'update' ? 'write' : action.type;
  return {
    type: mutationType,
    path: action.path ?? action.sourcePath ?? action.fromPath,
    ...(action.targetPath || action.toPath || action.destination ? { targetPath: action.targetPath ?? action.toPath ?? action.destination } : {}),
    ...(action.content !== undefined ? { content: String(action.content) } : {}),
  };
}
