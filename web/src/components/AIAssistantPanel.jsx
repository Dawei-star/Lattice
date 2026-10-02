import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiApi } from '../api/ai.js';
import { filesApi } from '../api/files.js';
import { renderMarkdown } from '../lib/markdown.js';
import { getActiveAiProvider, hasExternalAi, hydrateAiSettingsFromServer, loadAiSettings, saveAiSettings, subscribeAiSettings } from '../settings/aiSettings.js';

const LAST_SESSION_KEY = 'lattice-ai-active-session-v2';
const SYSTEM_ROOT_FOLDERS = new Set(['inbox', 'daily', 'journal']);
const FILE_KERNEL_ACTIONS = new Set(['create', 'update', 'delete', 'move', 'copy']);

const WELCOME_MESSAGE = {
  id: 'ai-welcome',
  role: 'assistant',
  content: '你好，我是 Lattice 知识库助手。可以直接问「这篇笔记讲了什么」，我会检索全库相关知识并给出带来源引用的回答；也可以让我搜索、整理、编辑或移动文件，写操作前都会先给出可确认的预览。',
  suggestions: ['总结当前笔记的内容', '搜索最近修改的项目笔记', '检查当前笔记的 Markdown 问题'],
};

function newSessionId() {
  return `sess-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`;
}

// 流式原始输出里，动作围栏与「自动读取」标记不直接展示给用户
function displayStreamText(raw) {
  const fenceIndex = raw.indexOf('```lattice-actions');
  const visible = fenceIndex >= 0 ? raw.slice(0, fenceIndex) : raw;
  return visible.replace(/\[\[自动读取文件中…\]\]/g, '').trimEnd();
}

export default function AIAssistantPanel({ open, onClose, noteIndex = [], folders = [], activeNote, onOpenNote, onOperationComplete, initialPrompt = '', initialPromptPreferModel = false, onInitialPromptConsumed }) {
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [digesting, setDigesting] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [tab, setTab] = useState('chat');
  const [sessions, setSessions] = useState([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [sessionId, setSessionId] = useState(() => {
    try {
      const stored = localStorage.getItem(LAST_SESSION_KEY);
      return stored && stored.trim() ? stored : newSessionId();
    } catch {
      return newSessionId();
    }
  });
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const [execution, setExecution] = useState(null);
  const [error, setError] = useState('');
  const [retryMessage, setRetryMessage] = useState('');
  const [related, setRelated] = useState([]);
  const [relatedOpen, setRelatedOpen] = useState(true);
  const [contextScope, setContextScope] = useState('auto');
  const abortRef = useRef(null);
  const forceModelRef = useRef(false);
  const loadedSessionRef = useRef(null);
  const messagesRef = useRef(null);
  const draftRef = useRef(null);
  const streamTextRef = useRef('');
  const streamStatusRef = useRef('');
  const streamFrameRef = useRef(0);
  const stickToBottomRef = useRef(true);

  const activeProvider = getActiveAiProvider(settings);
  const connectionState = !hasExternalAi(settings) ? 'local' : activeProvider?.verified ? 'connected' : 'configured';
  const composerBusy = sending || digesting;

  const flushStream = () => {
    streamFrameRef.current = 0;
    setStreamText(streamTextRef.current);
    setStreamStatus(streamStatusRef.current);
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

  const requestOptions = useMemo(() => {
    const accessToken = settings.accessToken?.trim();
    return accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};
  }, [settings.accessToken]);

  // 会话列表（服务端持久化，跨端可用）
  const refreshSessions = useCallback(async () => {
    try {
      const response = await aiApi.listSessions(requestOptions);
      setSessions(response?.data ?? response ?? []);
    } catch {
      // 会话列表加载失败不影响当前对话
    } finally {
      setSessionsReady(true);
    }
  }, [requestOptions]);

  const refreshHistory = useCallback(async ({ reportError = false } = {}) => {
    try {
      const [aiEntries, fileEntries] = await Promise.all([
        aiApi.history({ query: { limit: 80 }, ...requestOptions }),
        filesApi.log({ query: { limit: 80 }, ...requestOptions }),
      ]);
      const aiHistory = aiEntries?.data ?? aiEntries ?? [];
      const fileHistory = (fileEntries?.data ?? fileEntries ?? [])
        // AI agent writes are already represented by /ai/history. The file API
        // is the source of truth for the GUI's confirmed local operations.
        .filter((entry) => entry.source === 'files-api')
        .map((entry) => ({
          ...entry,
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
      localStorage.setItem(LAST_SESSION_KEY, sessionId);
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
    if (container && stickToBottomRef.current) container.scrollTop = container.scrollHeight;
  }, [messages, streamText, sending, preview, execution]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return undefined;
    const updateScrollIntent = () => {
      stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 96;
    };
    updateScrollIntent();
    container.addEventListener('scroll', updateScrollIntent, { passive: true });
    return () => container.removeEventListener('scroll', updateScrollIntent);
  }, [open]);

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

  const effectiveContextScope = useMemo(() => {
    if (contextScope === 'current') return activeNote ? 'current' : 'all';
    if (contextScope === 'project') return projectContext ? 'project' : 'all';
    if (contextScope === 'auto') return projectContext ? 'project' : 'all';
    return 'all';
  }, [activeNote, contextScope, projectContext]);

  const contextScopeLabel = effectiveContextScope === 'current'
    ? '当前笔记'
    : effectiveContextScope === 'project'
      ? `项目：${projectContext.name}`
      : '全库';

  const scopedNoteIndex = useMemo(() => {
    if (effectiveContextScope === 'current') return activeNote ? [activeNote] : [];
    if (effectiveContextScope === 'project' && projectContext) {
      return noteIndex.filter((note) => projectContext.folderIds.has(note.folderId));
    }
    return noteIndex;
  }, [activeNote, effectiveContextScope, noteIndex, projectContext]);

  const inboxItems = useMemo(
    () => noteIndex.filter((note) => note.properties?.type === 'inbox'),
    [noteIndex],
  );
  const pendingInboxItems = useMemo(
    () => inboxItems.filter((note) => ['captured', 'processing'].includes(note.properties?.status ?? 'captured')),
    [inboxItems],
  );

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

  const send = async (value = draft, options = {}) => {
    const message = String(value).trim();
    if (!message || composerBusy) return;
    const preferModel = options.preferModel ?? (forceModelRef.current || settings.preferModel === true);
    forceModelRef.current = false;
    const requestSessionId = sessionId;
    const stale = () => sessionIdRef.current !== requestSessionId;
    setDraft('');
    setError('');
    setRetryMessage('');
    setExecution(null);
    setPreview(null);
    streamTextRef.current = '';
    streamStatusRef.current = '';
    setStreamText('');
    setStreamStatus('');
    appendMessage({ id: `user-${Date.now()}`, role: 'user', content: message });
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const payload = await aiApi.streamChat({
        message,
        context,
        sessionId,
        mode: settings.autoApprove ? 'agent' : 'assist',
        preferModel,
        autoApprove: settings.autoApprove === true,
        actor: 'local-user',
        role: settings.role,
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
          else if (event.type === 'round') {
            streamTextRef.current = '';
            streamStatusRef.current = `第 ${event.round} 轮 · 继续执行任务…`;
            queueStreamFlush();
          } else if (event.type === 'status') {
            streamStatusRef.current = event.text ?? '';
            queueStreamFlush();
          } else if (event.type === 'done') {
            streamStatusRef.current = '';
            queueStreamFlush();
          }
        },
      });
      if (stale()) return;

      const assistant = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: payload?.reply ?? '已收到请求。',
        suggestions: payload?.suggestions ?? [],
        references: payload?.references ?? [],
        meta: payload?.meta,
      };
      appendMessage(assistant);
      if (settings.autoApprove === true) refreshHistory();
      if (payload?.actions?.length) {
        const previewResponse = await buildOperationPreview(payload.actions, requestOptions, settings.role);
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
      }
    } finally {
      // 清理必须无条件执行：切换会话会 abort 旧请求，若在这里跳过 setSending，
      // composerBusy 会永久卡住。内容写入（消息/预览/报错）才需要 stale 守卫。
      abortRef.current = null;
      setSending(false);
      streamTextRef.current = '';
      streamStatusRef.current = '';
      setStreamText('');
      setStreamStatus('');
    }
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
      localStorage.setItem(LAST_SESSION_KEY, id);
    } catch {
      // 忽略
    }
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

  const executePreview = async () => {
    if (!preview || preview.blocked || sending) return;
    setSending(true);
    setStreamStatus('正在执行文件操作…');
    setError('');
    try {
      const results = [];
      // 保持模型给出的顺序：后一个动作可能依赖前一个 mkdir/move。
      for (const operation of preview.fileOperations ?? []) {
        try {
          const response = await filesApi.execute({ ...operation.mutation, confirmed: true }, requestOptions);
          const result = response?.data ?? response;
          results.push({
            id: operation.id,
            type: operation.originalType,
            path: operation.path,
            targetPath: operation.targetPath,
            status: 'completed',
            result,
          });
        } catch (requestError) {
          results.push({
            id: operation.id,
            type: operation.originalType,
            path: operation.path,
            targetPath: operation.targetPath,
            status: 'failed',
            error: requestError?.message ?? '操作失败',
          });
        }
      }

      if (preview.aiOperations?.length) {
        const response = await aiApi.execute({
          actions: preview.aiOperations,
          actor: 'local-user',
          role: settings.role,
          source: 'ai-chat',
          confirmed: true,
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
      <aside className="ai-assistant" aria-label="AI 知识库助手">
        <header className="ai-assistant__header">
          <div className="ai-assistant__identity">
            <span className="ai-assistant__mark" aria-hidden="true">✦</span>
            <div>
              <span className="ai-assistant__eyebrow">LATTICE / COMMAND</span>
              <h2>AI 知识库助手</h2>
            </div>
          </div>
          <div className="ai-assistant__header-actions">
            <span className={`ai-assistant__status is-${connectionState}`} title={CONNECTION_STATE_META[connectionState].title}>
              <span className="ai-assistant__status-dot" />
              {CONNECTION_STATE_META[connectionState].label}
            </span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭 AI 知识库助手">×</button>
          </div>
        </header>

        <nav className="ai-assistant__tabs" aria-label="AI 面板视图">
          <button type="button" className={tab === 'chat' ? 'is-active' : ''} onClick={() => setTab('chat')}>对话</button>
          <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={loadHistory}>操作历史 <span>{history.length || ''}</span></button>
          <button type="button" className="ai-assistant__tab-action" onClick={startNewSession} title="开启一个新会话">新对话</button>
        </nav>

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
            {!history.length ? <div className="ai-assistant__empty">还没有 AI 操作记录</div> : history.map((entry) => <HistoryEntry key={entry.id} entry={entry} />)}
          </div>
        ) : (
          <>
            <div className="ai-assistant__session-bar">
              <select
                className="ai-assistant__session-select"
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
                aria-label="切换历史会话"
              >
                {!sessions.some((session) => session.id === sessionId) ? <option value={sessionId}>当前对话</option> : null}
                {sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
              </select>
              <button type="button" className="icon-btn ai-assistant__session-action" onClick={startNewSession} title="新建会话" aria-label="新建会话">＋</button>
              <button type="button" className="icon-btn icon-btn--danger ai-assistant__session-action" onClick={deleteCurrentSession} title="删除当前会话" aria-label="删除当前会话">🗑</button>
            </div>

            <div className="ai-assistant__context-strip">
              <label className="ai-assistant__scope-picker" title="选择 AI 检索和文件上下文范围">
                <span className="ai-assistant__context-icon" aria-hidden="true">⌁</span>
                <select value={contextScope} onChange={(event) => setContextScope(event.target.value)} aria-label="AI 上下文范围">
                  <option value="auto">自动上下文 · {projectContext ? '当前项目' : '全库'}</option>
                  <option value="current" disabled={!activeNote}>当前笔记</option>
                  <option value="project" disabled={!projectContext}>当前项目</option>
                  <option value="all">全库</option>
                </select>
              </label>
              <span className="ai-assistant__context-meta">
                <span className="ai-assistant__context-count">{scopedNoteIndex.length} 个文件</span>
                <span className={`ai-assistant__model-label is-${connectionState}`}>
                  {activeProvider?.model && connectionState !== 'local' ? `模型 · ${activeProvider.model}` : '本地响应'}
                </span>
              </span>
            </div>

            <section className="ai-assistant__workbench" aria-label="工作区脉搏">
              <div className="ai-assistant__workbench-head">
                <div>
                  <span className="ai-assistant__eyebrow">WORKSPACE PULSE</span>
                  <strong>{activeNote ? '正在协作的笔记' : '知识库概览'}</strong>
                </div>
                <span className="ai-assistant__workbench-scope">{contextScopeLabel}</span>
              </div>
              <div className="ai-assistant__pulse-grid">
                <div><strong>{scopedNoteIndex.length}</strong><span>{effectiveContextScope === 'current' ? '当前范围' : '范围文件'}</span></div>
                <div><strong>{pendingInboxItems.length}</strong><span>待整理 Inbox</span></div>
                <div><strong>{related.length}</strong><span>相关笔记</span></div>
              </div>
              {activeNote ? (
                <button type="button" className="ai-assistant__current-file" onClick={() => onOpenNote?.(activeNote.id)} title="打开当前笔记">
                  <span className="ai-assistant__current-file-icon" aria-hidden="true">#</span>
                  <span className="ai-assistant__current-file-copy"><strong>{activeNote.title}</strong><small>{activeNote.filePath ?? '当前打开的笔记'}{activeNote.wordCount ? ` · ${activeNote.wordCount} 字` : ''}</small></span>
                  <span className="ai-assistant__current-file-arrow" aria-hidden="true">↗</span>
                </button>
              ) : <div className="ai-assistant__current-file is-empty"><span className="ai-assistant__current-file-icon" aria-hidden="true">⌁</span><span>打开一篇笔记后，AI 会自动锁定写作上下文</span></div>}
            </section>

            {related.length ? (
              <div className="ai-assistant__related">
                <button type="button" className="ai-assistant__related-toggle" onClick={() => setRelatedOpen((value) => !value)} aria-expanded={relatedOpen}>
                  相关笔记（语义）<span>{relatedOpen ? '▾' : '▸'}</span>
                </button>
                {relatedOpen ? <div className="ai-assistant__related-list">
                  {related.map((item) => (
                    <button type="button" key={item.id} className="ai-assistant__related-chip" onClick={() => onOpenNote?.(item.id)} title={`${item.filePath ?? ''}\n相关度 ${(item.score * 100).toFixed(0)}%`}>
                      <strong>{item.title}</strong>
                      <small>{Math.round(item.score * 100)}% 相关{item.anchor ? ` · ${item.anchor}` : ''}</small>
                    </button>
                  ))}
                </div> : null}
              </div>
            ) : null}

            <div className="ai-assistant__messages" aria-live="polite" ref={messagesRef}>
              {messages.map((message) => <Message key={message.id} message={message} onSuggestion={send} onOpenNote={onOpenNote} />)}
              {sending ? (
                <div className="ai-message ai-message--assistant">
                  <span className="ai-message__avatar" aria-hidden="true">✦</span>
                  <div className="ai-message__body">
                    {streamText ? <div className="ai-message__content markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(displayStreamText(streamText)) }} /> : <div className="ai-message__typing"><span /><span /><span /></div>}
                    <span className="ai-message__meta">{streamStatus || (streamText ? '生成中…' : '正在检索知识与文件上下文…')}</span>
                  </div>
                </div>
              ) : null}
            </div>

            {preview ? <OperationPreview preview={preview} onConfirm={executePreview} onCancel={() => setPreview(null)} disabled={sending} /> : null}
            {execution ? <ExecutionSummary result={execution} /> : null}
            {error ? (
              <div className="ai-assistant__error" role="alert">
                <span>{error}</span>
                {retryMessage ? <button type="button" className="btn btn--sm" onClick={() => send(retryMessage)}>重试</button> : null}
              </div>
            ) : null}

            <div className="ai-assistant__composer">
              <div className="ai-assistant__quick-actions-head"><span>常用指令</span><small>{contextScopeLabel} · {settings.autoApprove ? '自动执行已开启' : '写入前确认'}</small></div>
              <div className="ai-assistant__quick-actions">
                <button type="button" disabled={composerBusy} onClick={() => send('总结当前笔记的核心内容，并给出相关笔记')}><span className="ai-assistant__quick-icon">✦</span><span><strong>理解笔记</strong><small>摘要 + 关联</small></span></button>
                <button type="button" disabled={composerBusy} onClick={() => send('搜索最近修改的项目笔记')}><span className="ai-assistant__quick-icon">⌕</span><span><strong>搜索知识库</strong><small>按内容定位</small></span></button>
                <button type="button" disabled={composerBusy} onClick={() => send(settings.autoApprove
                  ? '把我的文件整理分类好：先检索全库了解每篇笔记的主题，再把它们移动到按主题命名的目录里，最后汇报整理结果'
                  : '整理当前 Vault 的文件')}
                ><span className="ai-assistant__quick-icon">↗</span><span><strong>{settings.autoApprove ? '自动整理' : '整理建议'}</strong><small>规划文件结构</small></span></button>
                <button type="button" disabled={composerBusy || pendingInboxItems.length === 0} onClick={() => send('请整理 Inbox 中待整理的收集内容：先读取 status 为 captured 或 processing 的 Inbox 笔记，判断它们最适合归入哪个现有项目目录；无法可靠判断的保留在 Inbox 并说明原因。对确认后的归档使用 archive 动作，path 填原 Inbox 文件，targetPath 填项目内的新文件路径，不要处理 status 为 processed 的内容。', { preferModel: true })}><span className="ai-assistant__quick-icon">✦</span><span><strong>整理 Inbox</strong><small>{pendingInboxItems.length ? `${pendingInboxItems.length} 条待处理` : '暂无待处理'}</small></span></button>
                <button type="button" disabled={composerBusy} onClick={() => send('检查当前笔记的 Markdown 问题')}><span className="ai-assistant__quick-icon">✓</span><span><strong>检查内容</strong><small>结构与格式</small></span></button>
                <button type="button" disabled={composerBusy} onClick={runDigest}><span className="ai-assistant__quick-icon">☰</span><span><strong>{digesting ? '生成中' : '每日摘要'}</strong><small>汇总今日变更</small></span></button>
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
                    ? '下达任务指令，AI 会自主多轮执行并汇报…'
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
                      <span className="ai-assistant__mode-copy"><strong>模型优先</strong><small>{settings.preferModel ? '外部模型' : '本地快路径'}</small></span>
                    </label>
                    <label className={`ai-assistant__mode-toggle ${settings.autoApprove ? 'is-on' : ''}`} title="开启后 AI 进入任务模式：自主多轮执行检索、读文件和写操作，全部动作记录在操作历史中；关闭则写操作需要逐批确认">
                      <input type="checkbox" id="ai-auto-approve" checked={settings.autoApprove === true} onChange={toggleAutoApprove} />
                      <span className="ai-assistant__mode-switch" aria-hidden="true" />
                      <span className="ai-assistant__mode-copy"><strong>任务模式</strong><small>{settings.autoApprove ? '自动执行' : '逐步确认'}</small></span>
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

function Message({ message, onSuggestion, onOpenNote }) {
  const metaLine = message.meta?.provider === 'external' && message.meta?.model
    ? `${message.meta.model}${message.meta?.latencyMs ? ` · ${(message.meta.latencyMs / 1000).toFixed(1)}s` : ''}${message.meta?.rounds > 1 ? ` · ${message.meta.rounds} 轮` : ''}`
    : message.meta?.provider === 'local-instant'
      ? `本地即时回答 · 未调用模型${message.meta?.latencyMs ? ` · ${message.meta.latencyMs}ms` : ''}`
      : message.meta?.provider === 'local'
        ? '本地模式 · 未配置外部模型'
        : null;
  const executed = Array.isArray(message.meta?.executed) ? message.meta.executed : [];
  const executedFailed = Array.isArray(message.meta?.executedFailed) ? message.meta.executedFailed : [];
  return (
    <article className={`ai-message ai-message--${message.role}`}>
      {message.role === 'assistant' ? <span className="ai-message__avatar" aria-hidden="true">✦</span> : null}
      <div className="ai-message__body">
        <div className="ai-message__content markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content ?? '') }} />
        {executed.length ? (
          <details className="ai-message__executed">
            <summary>⚡ 已自动执行 {executed.length} 项操作</summary>
            <ul>{executed.map((item, index) => <li key={index}>{item}</li>)}</ul>
            {executedFailed.length ? <ul className="has-failures">{executedFailed.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
          </details>
        ) : null}
        {metaLine ? <span className="ai-message__meta">{metaLine}</span> : null}
        {message.references?.length ? <div className="ai-message__references">{message.references.map((reference, index) => (
          <button type="button" key={reference.id ?? `${reference.title}-${index}`} onClick={() => reference.id && onOpenNote?.(reference.id)} title={reference.excerpt ?? ''}>
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
      </div>
    </article>
  );
}

function OperationPreview({ preview, onConfirm, onCancel, disabled }) {
  return (
    <section className="ai-operation-preview" aria-label="文件操作预览">
      <header><div><span className="ai-assistant__eyebrow">ACTION PREVIEW</span><h3>确认文件操作</h3></div><span className="ai-operation-preview__risk">{preview.summary}</span></header>
      <div className="ai-operation-preview__list">{preview.operations.map((operation) => <div className={`ai-operation ${operation.risk}`} key={operation.id}><span className="ai-operation__icon">{operation.type === 'delete' ? '×' : operation.type === 'read' ? '⌕' : '↗'}</span><div className="ai-operation__body"><strong>{operation.summary}</strong><small>{operation.risk === 'destructive' ? '删除操作不可逆' : operation.requiresConfirmation ? '确认后写入 Vault' : '只读操作'}</small>{operation.diff ? <pre className="ai-operation__diff">{operation.diff}</pre> : null}</div></div>)}</div>
      <footer><button type="button" onClick={onCancel} disabled={disabled}>取消</button><button type="button" className="is-primary" onClick={onConfirm} disabled={disabled || preview.blocked}>{preview.blocked ? '当前角色只读' : '确认执行'}</button></footer>
    </section>
  );
}

function ExecutionSummary({ result }) {
  return <div className={`ai-execution-summary ${result.failed ? 'has-failures' : ''}`}><span>{result.failed ? '!' : '✓'}</span><strong>{result.failed ? `${result.completed} 项完成，${result.failed} 项失败` : `已完成 ${result.completed} 项操作`}</strong></div>;
}

function HistoryEntry({ entry }) {
  const action = entry.action ?? {};
  return <div className="ai-history-entry"><span className={`ai-history-entry__status ${entry.status}`}>{entry.status === 'completed' ? '✓' : '!'}</span><div><strong>{action.type} · {action.path}</strong><small>{action.targetPath ? `→ ${action.targetPath} · ` : ''}{formatTime(entry.at)} · {entry.source}</small></div></div>;
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

async function buildOperationPreview(actions, requestOptions, role) {
  const fileActions = actions.filter((action) => FILE_KERNEL_ACTIONS.has(action?.type));
  const archiveActions = actions.filter((action) => action?.type === 'archive');
  const fileOperations = await Promise.all(fileActions.map(async (action, index) => {
    const mutation = toFileMutation(action);
    const response = await filesApi.preview(mutation, requestOptions);
    const data = response?.data ?? response;
    return {
      ...data,
      id: String(action.id ?? `file-op-${index + 1}`),
      originalType: action.type,
      type: action.type,
      path: action.path,
      targetPath: action.targetPath,
      mutation,
      risk: action.type === 'delete' ? 'destructive' : 'write',
      requiresConfirmation: true,
    };
  }));

  let archivePreview = null;
  if (archiveActions.length) {
    const response = await aiApi.preview({ actions: archiveActions, actor: 'local-user', role }, requestOptions);
    archivePreview = response?.data ?? response;
  }

  const archiveOperations = (archivePreview?.operations ?? []).map((operation, index) => ({
    ...operation,
    id: String(operation.id ?? `archive-op-${index + 1}`),
  }));
  const operations = [...fileOperations, ...archiveOperations];
  if (!operations.length) return null;
  const blocked = role === 'viewer' || fileOperations.some((operation) => operation.blocked) || archivePreview?.blocked === true;
  const writes = operations.filter((operation) => operation.requiresConfirmation !== false).length;
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}`,
    blocked,
    operations,
    fileOperations,
    aiOperations: archiveActions,
    aiPlanHash: archivePreview?.planHash ?? null,
    summary: `${operations.length} 项操作 · ${writes} 项需要确认`,
    createdAt: new Date().toISOString(),
  };
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
