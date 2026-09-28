import { useEffect, useMemo, useState } from 'react';
import { aiApi } from '../api/ai.js';
import { renderMarkdown } from '../lib/markdown.js';
import { createAiProvider, getActiveAiProvider, hasExternalAi, loadAiSettings, saveAiSettings, subscribeAiSettings } from '../settings/aiSettings.js';

const INITIAL_MESSAGE = {
  id: 'ai-welcome',
  role: 'assistant',
  content: '你好，我是 Lattice 文件助手。告诉我需要搜索、整理、编辑或移动什么文件，我会先给出可确认的操作预览。',
  suggestions: ['搜索最近修改的项目笔记', '整理当前 Vault 的文件', '检查当前笔记的 Markdown 问题'],
};

export default function AIAssistantPanel({ open, onClose, noteIndex = [], folders = [], activeNote, onOpenNote, onOperationComplete, onOpenSettings }) {
  const [messages, setMessages] = useState([INITIAL_MESSAGE]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [tab, setTab] = useState('chat');
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const [execution, setExecution] = useState(null);
  const [error, setError] = useState('');

  const activeProvider = getActiveAiProvider(settings);

  useEffect(() => subscribeAiSettings(setSettings), []);

  const context = useMemo(() => ({
    activeFile: activeNote?.filePath ?? activeNote?.title ?? null,
    files: noteIndex.slice(0, 100).map((note) => ({
      id: note.id,
      title: note.title,
      path: note.filePath ?? note.title,
      folderId: note.folderId,
      updatedAt: note.updatedAt,
      wordCount: note.wordCount,
    })),
    folders: flattenFolders(folders).slice(0, 80).map((folder) => ({ id: folder.id, name: folder.name, path: folder.path })),
  }), [activeNote, folders, noteIndex]);

  const requestOptions = useMemo(() => {
    const accessToken = settings.accessToken?.trim();
    return accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};
  }, [settings.accessToken]);

  if (!open) return null;

  const send = async (value = draft) => {
    const message = String(value).trim();
    if (!message || sending) return;
    setDraft('');
    setError('');
    setExecution(null);
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', content: message }]);
    setSending(true);

    try {
      const response = await aiApi.chat({
        message,
        context,
        provider: hasExternalAi(settings) ? {
          endpoint: activeProvider.endpoint,
          apiKey: activeProvider.apiKey,
          model: activeProvider.model,
          authHeader: activeProvider.authHeader,
        } : null,
        actor: 'local-user',
        role: settings.role,
      }, requestOptions);
      const payload = response?.data ?? response ?? {};
      const assistant = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: payload.reply ?? '已收到请求。',
        suggestions: payload.suggestions ?? [],
        references: payload.references ?? [],
        meta: payload.meta,
      };
      setMessages((current) => [...current, assistant]);
      if (payload.actions?.length) {
        const previewResponse = await aiApi.preview({ actions: payload.actions, actor: 'local-user', role: settings.role }, requestOptions);
        setPreview(previewResponse?.data ?? previewResponse);
      }
    } catch (requestError) {
      setError(requestError?.message ?? 'AI 请求失败，请稍后重试');
    } finally {
      setSending(false);
    }
  };

  const executePreview = async () => {
    if (!preview || preview.blocked || sending) return;
    setSending(true);
    setError('');
    try {
      const response = await aiApi.execute({
        actions: preview.operations,
        actor: 'local-user',
        role: settings.role,
        source: 'ai-chat',
        confirmed: true,
      }, requestOptions);
      const result = response?.data ?? response;
      setExecution(result);
      setPreview(null);
      setMessages((current) => [...current, {
        id: `system-${Date.now()}`,
        role: 'system',
        content: `已完成 ${result.completed ?? 0} 项操作${result.failed ? `，${result.failed} 项失败` : ''}。`,
      }]);
      await onOperationComplete?.();
    } catch (requestError) {
      setError(requestError?.message ?? '执行失败，请检查权限或文件状态');
    } finally {
      setSending(false);
    }
  };

  const loadHistory = async () => {
    setTab('history');
    try {
      const response = await aiApi.history({ query: { limit: 80 }, ...requestOptions });
      setHistory(response?.data ?? response ?? []);
    } catch (requestError) {
      setError(requestError?.message ?? '审计记录加载失败');
    }
  };

  const saveConnection = (patch) => setSettings((current) => saveAiSettings({ ...current, ...patch }));
  const updateProvider = (providerId, patch) => setSettings((current) => saveAiSettings({
    ...current,
    providers: current.providers.map((provider) => provider.id === providerId ? { ...provider, ...patch } : provider),
  }));
  const selectProvider = (providerId) => setSettings((current) => saveAiSettings({ ...current, activeProviderId: providerId }));
  const addProvider = () => {
    const provider = createAiProvider();
    setSettings((current) => saveAiSettings({ ...current, providers: [...current.providers, provider], activeProviderId: provider.id }));
  };
  const removeProvider = (providerId) => setSettings((current) => {
    const providers = current.providers.filter((provider) => provider.id !== providerId);
    const nextProviders = providers.length ? providers : [createAiProvider()];
    const activeProviderId = current.activeProviderId === providerId ? nextProviders[0].id : current.activeProviderId;
    return saveAiSettings({ ...current, providers: nextProviders, activeProviderId });
  });
  const clearConnection = () => setSettings((current) => saveAiSettings({
    ...current,
    providers: current.providers.map((provider) => ({ ...provider, endpoint: '', model: '', apiKey: '' })),
    accessToken: '',
  }));

  return (
    <div className="ai-assistant-layer" role="presentation">
      <button type="button" className="ai-assistant-backdrop" onClick={onClose} aria-label="关闭 AI 文件助手" />
      <aside className="ai-assistant" aria-label="AI 文件助手">
        <header className="ai-assistant__header">
          <div className="ai-assistant__identity">
            <span className="ai-assistant__mark" aria-hidden="true">✦</span>
            <div>
              <span className="ai-assistant__eyebrow">LATTICE / COMMAND</span>
              <h2>AI 文件助手</h2>
            </div>
          </div>
          <div className="ai-assistant__header-actions">
            <span className={`ai-assistant__status ${hasExternalAi(settings) ? 'is-connected' : ''}`} title={hasExternalAi(settings) ? '当前模型已配置' : '当前模型未配置，使用本地助手'}>
              <span className="ai-assistant__status-dot" />
              {hasExternalAi(settings) ? '已连接' : '本地模式'}
            </span>
            <button type="button" className="icon-btn" onClick={() => setSettingsOpen((value) => !value)} aria-label="AI 连接设置">⚙</button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭 AI 文件助手">×</button>
          </div>
        </header>

        <nav className="ai-assistant__tabs" aria-label="AI 面板视图">
          <button type="button" className={tab === 'chat' ? 'is-active' : ''} onClick={() => setTab('chat')}>对话</button>
          <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={loadHistory}>操作历史 <span>{history.length || ''}</span></button>
        </nav>

        {settingsOpen ? (
          <section className="ai-assistant__settings" aria-label="AI 连接设置">
            <div className="ai-assistant__section-heading">
              <div><span className="ai-assistant__eyebrow">PROVIDER</span><h3>连接与权限</h3></div>
              <div className="ai-assistant__settings-actions">
                <button type="button" className="btn btn--sm" onClick={clearConnection}>清除配置</button>
                <button type="button" className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="关闭连接设置">×</button>
              </div>
            </div>
            <button type="button" className="ai-assistant__settings-manager" onClick={onOpenSettings}>在设置中管理全部模型和 API 接口 <span>打开设置 →</span></button>
            <div className="ai-assistant__model-list-heading">
              <span>模型配置（{settings.providers.length}）</span>
              <button type="button" className="btn btn--sm" onClick={addProvider}>＋ 添加模型</button>
            </div>
            <div className="ai-assistant__model-list">
              {settings.providers.map((provider) => <AiProviderCard
                key={provider.id}
                provider={provider}
                selected={provider.id === settings.activeProviderId}
                onSelect={() => selectProvider(provider.id)}
                onChange={(patch) => updateProvider(provider.id, patch)}
                onRemove={() => removeProvider(provider.id)}
              />)}
            </div>
            <p className="ai-assistant__settings-note">智谱 OpenAI 兼容接口建议填写：<code>https://open.bigmodel.cn/api/paas/v4/chat/completions</code>。模型名称和 API Key 权限必须匹配。</p>
            <label>工作区访问令牌<input type="password" value={settings.accessToken} onChange={(event) => saveConnection({ accessToken: event.target.value })} placeholder="服务端配置 AI_ACCESS_TOKEN 时填写" autoComplete="off" /></label>
            <label>操作角色<select value={settings.role} onChange={(event) => saveConnection({ role: event.target.value })}><option value="viewer">Viewer · 只读</option><option value="editor">Editor · 可确认写入</option><option value="admin">Admin · 全部操作</option></select></label>
            <p className="ai-assistant__settings-note">模型 API key 和工作区令牌只在当前浏览器保存，不会写入操作历史。启用服务端令牌后，角色以服务端配置为准。</p>
          </section>
        ) : null}

        {tab === 'history' ? (
          <div className="ai-assistant__history">
            {!history.length ? <div className="ai-assistant__empty">还没有 AI 操作记录</div> : history.map((entry) => <HistoryEntry key={entry.id} entry={entry} />)}
          </div>
        ) : (
          <>
            <div className="ai-assistant__context-strip">
              <span className="ai-assistant__context-icon" aria-hidden="true">⌁</span>
              <span>{activeNote ? `当前文件：${activeNote.title}` : '当前工作区：全部文件'}</span>
              <span className="ai-assistant__context-count">{noteIndex.length} 个文件</span>
              <label className="ai-assistant__model-picker">模型
                <select value={settings.activeProviderId} onChange={(event) => selectProvider(event.target.value)} aria-label="选择 AI 模型">
                  {settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.model ? ` · ${provider.model}` : ''}</option>)}
                </select>
              </label>
            </div>

            <div className="ai-assistant__messages" aria-live="polite">
              {messages.map((message) => <Message key={message.id} message={message} onSuggestion={send} onOpenNote={onOpenNote} />)}
              {sending ? <div className="ai-message ai-message--assistant"><div className="ai-message__typing"><span /><span /><span /></div><span>正在分析文件上下文</span></div> : null}
            </div>

            {preview ? <OperationPreview preview={preview} onConfirm={executePreview} onCancel={() => setPreview(null)} disabled={sending} /> : null}
            {execution ? <ExecutionSummary result={execution} /> : null}
            {error ? <div className="ai-assistant__error" role="alert">{error}</div> : null}

            <div className="ai-assistant__composer">
              <div className="ai-assistant__quick-actions">
                <button type="button" onClick={() => send('搜索最近修改的项目笔记')}>⌕ 搜索文件</button>
                <button type="button" onClick={() => send('整理当前 Vault 的文件')}>✦ 整理建议</button>
                <button type="button" onClick={() => send('检查当前笔记的 Markdown 问题')}>✓ 检查内容</button>
              </div>
              <form onSubmit={(event) => { event.preventDefault(); send(); }}>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="描述要完成的文件操作…" rows={3} aria-label="输入 AI 文件操作" disabled={sending} />
                <div className="ai-assistant__composer-footer">
                  <span>结构化预览 · 操作需确认</span>
                  <button type="submit" className="ai-assistant__send" disabled={!draft.trim() || sending} aria-label="发送消息">↗</button>
                </div>
              </form>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function AiProviderCard({ provider, selected, onSelect, onChange, onRemove }) {
  return (
    <article className={`ai-provider-card ${selected ? 'is-selected' : ''}`}>
      <div className="ai-provider-card__header">
        <label className="ai-provider-card__radio"><input type="radio" checked={selected} onChange={onSelect} name="active-ai-provider" /><span /></label>
        <input className="ai-provider-card__name" value={provider.name} onChange={(event) => onChange({ name: event.target.value })} aria-label="模型配置名称" placeholder="配置名称" />
        <button type="button" className="ai-provider-card__delete" onClick={onRemove} aria-label={`删除 ${provider.name || '模型配置'}`}>×</button>
      </div>
      <div className="ai-provider-card__fields">
        <label>Endpoint<input value={provider.endpoint} onChange={(event) => onChange({ endpoint: event.target.value })} placeholder="https://api.openai.com/v1/chat/completions" /></label>
        <div className="ai-assistant__form-grid">
          <label>Model<input value={provider.model} onChange={(event) => onChange({ model: event.target.value })} placeholder="gpt-4o-mini" /></label>
          <label>认证<select value={provider.authHeader} onChange={(event) => onChange({ authHeader: event.target.value })}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option></select></label>
        </div>
        <label>API key<input type="password" value={provider.apiKey} onChange={(event) => onChange({ apiKey: event.target.value })} placeholder="仅保存在本机浏览器" autoComplete="off" /></label>
      </div>
    </article>
  );
}

function Message({ message, onSuggestion, onOpenNote }) {
  return (
    <article className={`ai-message ai-message--${message.role}`}>
      {message.role === 'assistant' ? <span className="ai-message__avatar" aria-hidden="true">✦</span> : null}
      <div className="ai-message__body">
        <div className="ai-message__content markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content ?? '') }} />
        {message.meta?.providerError ? <span className="ai-message__meta">外部 AI 不可用，已切换本地助手：{message.meta.providerError}</span> : null}
        {message.references?.length ? <div className="ai-message__references">{message.references.map((reference) => <button type="button" key={reference.id ?? reference.title} onClick={() => reference.id && onOpenNote?.(reference.id)}><span>▤</span><strong>{reference.title}</strong><small>{reference.excerpt ?? reference.path ?? '文件引用'}</small></button>)}</div> : null}
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
      <div className="ai-operation-preview__list">{preview.operations.map((operation) => <div className={`ai-operation ${operation.risk}`} key={operation.id}><span className="ai-operation__icon">{operation.type === 'delete' ? '×' : operation.type === 'read' ? '⌕' : '↗'}</span><div><strong>{operation.summary}</strong><small>{operation.risk === 'destructive' ? '删除操作不可逆' : operation.requiresConfirmation ? '确认后写入 Vault' : '只读操作'}</small></div></div>)}</div>
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
