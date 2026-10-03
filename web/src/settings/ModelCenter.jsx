import { useEffect, useMemo, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { aiApi } from '../api/ai.js';
import { createAiProvider, loadAiSettings, saveAiSettings, subscribeAiSettings } from './aiSettings.js';
import { CUSTOM_SERVICE, PROVIDERS, findProviderByService } from './aiProviders.js';
export default function ModelCenter() {
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [addStep, setAddStep] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [formError, setFormError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => subscribeAiSettings(setSettings), []);

  const requestOptions = useMemo(() => {
    const accessToken = settings.accessToken?.trim();
    return accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};
  }, [settings.accessToken]);

  const openProviderChooser = () => {
    setFormError('');
    setAddStep('chooser');
  };

  const openProviderForm = (provider = PROVIDERS[0]) => {
    setEditingId(null);
    setFormError('');
    setTestResult(null);
    setDraft({
      providerKey: provider.key,
      providerLabel: provider.label,
      providerLogo: provider.logo,
      providerKeyUrl: provider.keyUrl ?? '',
      providerHint: provider.hint ?? '',
      providerModels: provider.models ?? [],
      service: provider.key === 'custom' ? CUSTOM_SERVICE : provider.label,
      endpoint: provider.endpoint ?? '',
      model: '',
      name: '',
      apiKey: '',
      authHeader: 'bearer',
    });
    setAddStep('form');
  };

  const openEdit = (provider) => {
    setEditingId(provider.id);
    setFormError('');
    setTestResult(null);
    const match = findProviderByService(provider.service);
    setDraft({
      ...provider,
      providerKey: match.key,
      providerLabel: match.label,
      providerLogo: match.logo,
      providerKeyUrl: match.keyUrl ?? '',
      providerHint: match.hint ?? '',
      providerModels: match.models ?? [],
    });
    setAddStep('form');
  };

  // 表单内直接切换服务商：保留已输入的密钥，重置接口地址与模型选择。
  const switchDraftProvider = (key) => {
    setTestResult(null);
    const provider = PROVIDERS.find((item) => item.key === key) ?? PROVIDERS[0];
    setDraft((current) => ({
      ...current,
      providerKey: provider.key,
      providerLabel: provider.label,
      providerLogo: provider.logo,
      providerKeyUrl: provider.keyUrl ?? '',
      providerHint: provider.hint ?? '',
      providerModels: provider.models ?? [],
      service: provider.key === 'custom' ? CUSTOM_SERVICE : provider.label,
      endpoint: provider.endpoint ?? '',
      model: '',
    }));
  };

  const closeModal = () => {
    setAddStep(null);
    setEditingId(null);
    setDraft(null);
    setFormError('');
    setTestResult(null);
  };

  // 表单字段一旦变化，之前的连通性测试结果就不再代表当前配置，立即清掉
  const updateDraft = (patch) => {
    setTestResult(null);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const probeProvider = async (provider) => {
    try {
      const result = await aiApi.test({ provider }, requestOptions);
      return result ?? { ok: false, error: '测试请求没有返回结果' };
    } catch (requestError) {
      return { ok: false, error: requestError?.message ?? '测试请求失败，请确认本地服务已启动' };
    }
  };

  const runConnectivityTest = async () => {
    const endpoint = draft.endpoint.trim();
    const model = draft.model.trim();
    const apiKey = draft.apiKey.trim();
    if (!endpoint || !model || !apiKey) {
      const result = { ok: false, error: '请先填写完整的 Endpoint、模型 ID 和 API Key 再测试。' };
      setTestResult(result);
      return result;
    }
    setTesting(true);
    try {
      const result = await probeProvider({ endpoint, model, apiKey, authHeader: draft.authHeader });
      setTestResult(result);
      return result;
    } finally {
      setTesting(false);
    }
  };

  const submitProvider = async (event) => {
    event.preventDefault();
    if (testing || saving) return;
    const next = {
      ...draft,
      name: draft.name.trim() || draft.model.trim(),
      model: draft.model.trim(),
      endpoint: draft.endpoint.trim(),
      apiKey: draft.apiKey.trim(),
    };
    if (!next.endpoint || !next.model || !next.apiKey) {
      setFormError('请填写完整的 Endpoint、模型 ID 和 API Key。');
      return;
    }
    // 保存前强制连通性测试：Key 或模型 ID 不匹配时直接拦截，避免无效配置进入列表
    setSaving(true);
    setFormError('');
    try {
      const result = await probeProvider({ endpoint: next.endpoint, model: next.model, apiKey: next.apiKey, authHeader: next.authHeader });
      setTestResult(result);
      if (!result.ok) {
        setFormError(`连通性测试未通过，已取消保存：${result.error ?? '未知错误'}`);
        return;
      }
      if (editingId) {
        saveAiSettings({ ...settings, providers: settings.providers.map((provider) => provider.id === editingId ? { ...provider, ...next, verified: true } : provider) });
      } else {
        const provider = createAiProvider({ ...next, verified: true });
        saveAiSettings({ ...settings, providers: [...settings.providers, provider], activeProviderId: provider.id });
      }
      closeModal();
    } finally {
      setSaving(false);
    }
  };

  const removeProvider = (provider) => {
    if (!window.confirm(`删除模型“${provider.name || provider.model}”？`)) return;
    if (settings.providers.length === 1) {
      saveAiSettings({ ...settings, providers: settings.providers.map((item) => ({ ...item, endpoint: '', model: '', apiKey: '', enabled: false, verified: false })) });
      return;
    }
    const providers = settings.providers.filter((item) => item.id !== provider.id);
    saveAiSettings({ ...settings, providers, activeProviderId: settings.activeProviderId === provider.id ? providers[0].id : settings.activeProviderId });
  };

  const toggleProvider = (provider) => saveAiSettings({
    ...settings,
    providers: settings.providers.map((item) => item.id === provider.id ? { ...item, enabled: item.enabled === false } : item),
  });

  const formTitle = editingId ? '编辑模型' : draft?.providerKey === 'custom' ? '自定义模型' : '通过服务商添加';

  return <div className="model-center">
    <section className="model-center__intro">
      <div><span className="settings-kicker">MODEL MANAGEMENT</span><h3>模型管理</h3><p>选择服务商并配置 API Key 即可在聊天中使用，密钥只保存在本机。</p></div>
      <button type="button" className="btn btn--primary" onClick={openProviderChooser}>＋ 添加模型</button>
    </section>
    <section className="model-center__table" aria-label="模型列表">
      <div className="model-center__thead"><strong>模型</strong><strong>服务商</strong><strong>操作</strong></div>
      {settings.providers.length
        ? settings.providers.map((provider) => <CustomModelRow key={provider.id} provider={provider} active={provider.id === settings.activeProviderId} onUse={() => saveAiSettings({ ...settings, activeProviderId: provider.id })} onEdit={() => openEdit(provider)} onRemove={() => removeProvider(provider)} onToggle={() => toggleProvider(provider)} />)
        : <div className="model-center__empty"><strong>还没有模型</strong><p>点击右上角“添加模型”，选择服务商并填写 API Key。</p></div>}
    </section>
    {addStep ? <Modal open title={addStep === 'chooser' ? '添加模型' : formTitle} ariaLabel={addStep === 'chooser' ? '添加模型' : formTitle} onClose={closeModal} className="model-center__modal">
      {addStep === 'chooser'
        ? <ProviderChooser onChoose={openProviderForm} onClose={closeModal} />
        : <CustomModelForm key={`${draft.providerKey}-${editingId ?? 'new'}`} draft={draft} editing={Boolean(editingId)} error={formError} onChange={updateDraft} onSwitchProvider={switchDraftProvider} onSubmit={submitProvider} onTest={runConnectivityTest} testing={testing} saving={saving} testResult={testResult} onBack={() => { setFormError(''); setTestResult(null); setAddStep('chooser'); }} onReset={() => { setTestResult(null); setDraft((current) => ({ ...current, endpoint: '', model: '', name: '', apiKey: '' })); }} />}
    </Modal> : null}
    <EmbeddingSection settings={settings} />
    <IndexStatusSection />
    <RetrievalDebugSection />
  </div>;
}

/**
 * 语义索引（Embedding）配置：启用后自动对全库笔记分块并向量化，
 * 解锁语义搜索、相关笔记推荐与带引用的知识库问答。
 * 隐私边界：启用云端 embedding 意味着笔记分块内容会发往该服务商，界面明确提示。
 */
function EmbeddingSection({ settings }) {
  const embedding = settings.embedding ?? { endpoint: '', model: '', apiKey: '', authHeader: 'bearer', enabled: false };
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const update = (patch) => {
    setResult(null);
    saveAiSettings({ ...settings, embedding: { ...embedding, ...patch } });
  };

  const runTest = async () => {
    if (!embedding.endpoint?.trim() || !embedding.model?.trim() || !embedding.apiKey?.trim()) {
      setResult({ ok: false, error: '请先填写完整的 Endpoint、模型 ID 和 API Key。' });
      return;
    }
    setTesting(true);
    try {
      const response = await aiApi.test({
        kind: 'embedding',
        provider: {
          endpoint: embedding.endpoint,
          model: embedding.model,
          apiKey: embedding.apiKey,
          authHeader: embedding.authHeader,
        },
      }, {});
      setResult(response?.data ?? response ?? { ok: false, error: '测试请求没有返回结果' });
    } catch (requestError) {
      setResult({ ok: false, error: requestError?.message ?? '测试请求失败' });
    } finally {
      setTesting(false);
    }
  };

  return <section className="model-center__panel" aria-label="语义索引配置">
    <header className="model-center__panel-head">
      <h4>语义索引（Embedding）</h4>
      <span className={`model-center__pill ${embedding.enabled ? 'model-center__pill--ready' : 'model-center__pill--pending'}`}>{embedding.enabled ? '已启用' : '未启用'}</span>
      <div className="model-center__panel-actions">
        <button type="button" className="btn btn--sm" onClick={runTest} disabled={testing}>{testing ? '测试中…' : '测试连接'}</button>
        <button type="button" className={`model-center__switch ${embedding.enabled ? 'is-on' : ''}`} onClick={() => update({ enabled: !embedding.enabled })} role="switch" aria-checked={embedding.enabled} aria-label={embedding.enabled ? '停用语义索引' : '启用语义索引'}><span /></button>
      </div>
    </header>
    <div className="model-center__embedding-body">
      <div className="model-center__embedding-fields">
        <label>Endpoint<input value={embedding.endpoint} onChange={(event) => update({ endpoint: event.target.value })} placeholder="https://api.siliconflow.cn/v1/embeddings" /></label>
        <label>模型 ID<input value={embedding.model} onChange={(event) => update({ model: event.target.value })} placeholder="BAAI/bge-m3" /></label>
        <label>API Key<span className="model-center__key-wrap"><input type={showKey ? 'text' : 'password'} value={embedding.apiKey} onChange={(event) => update({ apiKey: event.target.value })} autoComplete="off" /><button type="button" className="model-center__eye" onClick={() => setShowKey((visible) => !visible)}>{showKey ? '隐藏' : '显示'}</button></span></label>
      </div>
      <div className="model-center__embedding-side">
        <p className="model-center__embedding-hint">启用后笔记会按标题分块并计算向量，用于语义搜索、相关笔记推荐与知识库问答。云端 embedding 会把笔记分块内容发往该服务商；不开启则仅使用关键词检索。</p>
        {result ? <p className={`model-center__test-result ${result.ok ? 'is-ok' : 'is-failed'}`} role="status">{result.ok ? `✓ 测试通过${result.dim ? ` · 向量维度 ${result.dim}` : ''} · ${result.latencyMs ?? '?'}ms` : `✗ ${result.error ?? '测试失败'}`}</p> : null}
      </div>
    </div>
  </section>;
}

/** 索引状态与重建入口：增量索引在后台自动进行，这里提供可见性与手动兜底 */
function IndexStatusSection() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reindexError, setReindexError] = useState('');

  const refresh = async () => {
    try {
      const response = await aiApi.indexStatus();
      setStatus(response?.data ?? response ?? null);
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, []);

  const runReindex = async () => {
    setBusy(true);
    setReindexError('');
    try {
      await aiApi.reindex();
      // 入队成功后延迟刷新状态
      setTimeout(refresh, 1_500);
    } catch (error) {
      setReindexError(error?.message ?? '重建索引入队失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const healthy = status && !status.pending && !status.failed;

  return <section className="model-center__panel" aria-label="语义索引状态">
    <header className="model-center__panel-head">
      <h4>语义索引状态</h4>
      <span className={`model-center__pill ${healthy ? 'model-center__pill--ready' : 'model-center__pill--pending'}`}>
        {status?.pending ? '索引中' : status?.failed ? '有失败' : '就绪'}
      </span>
      <div className="model-center__panel-actions">
        <button type="button" className="btn btn--sm" onClick={refresh}>刷新</button>
        <button type="button" className="btn btn--sm" onClick={runReindex} disabled={busy}>{busy ? '入队中…' : '重建索引'}</button>
      </div>
    </header>
    <p className="model-center__index-summary">
      {status
        ? (status.configured
          ? `模型 ${status.model} · 已索引 ${status.indexed}/${status.totalNotes} 篇 · 共 ${status.totalChunks} 个分块${status.pending ? ` · 待处理 ${status.pending}` : ''}${status.failed ? ` · 失败 ${status.failed}` : ''}`
          : '未配置 embedding 模型，语义功能未启用')
        : '索引状态加载中…'}
    </p>
    {reindexError ? <p className="model-center__index-summary" role="alert">{reindexError}</p> : null}
  </section>;
}

/**
 * 检索调试视图（FastGPT 式「看命中」）：输入一句话，直接看到关键词路 /
 * 语义路各自命中了哪些分块、融合后入选了哪些 —— 知识库问答质量的第一排查工具。
 */
function RetrievalDebugSection() {
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const runPreview = async () => {
    const query = term.trim();
    if (!query || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await aiApi.retrievalPreview(query);
      setResult(response?.data ?? response ?? null);
    } catch (requestError) {
      setResult(null);
      setError(requestError?.message ?? '检索失败');
    } finally {
      setBusy(false);
    }
  };

  return <section className="model-center__panel" aria-label="检索调试">
    <header className="model-center__panel-head">
      <h4>检索调试</h4>
      <form className="model-center__panel-actions" onSubmit={(event) => { event.preventDefault(); runPreview(); }}>
        <input
          className="model-center__debug-input"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="输入一句话，看知识库会命中什么…"
          aria-label="检索测试语句"
          maxLength={200}
        />
        <button type="submit" className="btn btn--sm" disabled={busy || !term.trim()}>{busy ? '检索中…' : '测试检索'}</button>
      </form>
    </header>
    <div className="model-center__debug-body">
      {error ? <p className="model-center__form-error" role="alert">{error}</p> : null}
      {!error && !result ? <p className="model-center__index-summary">用于排查「知识库问答为什么没引用某篇笔记」：测试语句会同时跑关键词与语义两路检索，列出最终注入模型的分块。</p> : null}
      {result ? (
        <div className="model-center__debug-results">
          {result.blocks?.length
            ? result.blocks.map((block, index) => (
              <div className="model-center__debug-hit" key={`${block.noteId}-${index}`}>
                <span className="model-center__debug-order">[{index + 1}]</span>
                <div>
                  <strong>{block.title}</strong>
                  {block.anchor ? <small> ＞ {block.anchor}</small> : null}
                  {block.wholeNote ? <small>（整文注入）</small> : null}
                  <p>{String(block.excerpt ?? '').slice(0, 120)}…</p>
                </div>
              </div>
            ))
            : <p className="model-center__index-summary">没有命中任何分块。若已配置 embedding，请确认索引状态是「已索引」；关键词路至少需要 2 个字的词。</p>}
          {result.semanticError ? <p className="model-center__index-summary">语义路不可用：{result.semanticError}（本次仅使用关键词检索）</p> : null}
        </div>
      ) : null}
    </div>
  </section>;
}

function ProviderLogo({ logo, className = '' }) {
  return <span className={`provider-logo ${className}`.trim()} aria-hidden="true"><img src={logo} alt="" loading="lazy" /></span>;
}

function PencilIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>;
}

function CustomModelRow({ provider, active, onUse, onEdit, onRemove, onToggle }) {
  const match = findProviderByService(provider.service);
  const ready = Boolean(provider.endpoint && provider.apiKey && provider.model);
  return <div
    className={`model-center__row ${provider.enabled === false ? 'is-disabled' : ''} ${active ? 'is-active' : ''}`}
    onClick={onUse}
    title={active ? '当前使用的模型' : '点击设为当前使用'}
  >
    <div className="model-center__model-cell"><ProviderLogo logo={match.logo} /><div className="model-center__name"><span className="model-center__name-title"><strong>{provider.name || provider.model || '未命名模型'}</strong>{active ? <span className="model-center__pill model-center__pill--active">使用中</span> : null}</span><small>{provider.model || '未填写模型 ID'}</small></div></div>
    <span className="model-center__service"><span className="model-center__service-name">{provider.service || CUSTOM_SERVICE}</span><span className={`model-center__pill ${ready ? 'model-center__pill--ready' : 'model-center__pill--pending'}`}>{ready ? '已配置' : '待完善'}</span></span>
    <div className="model-center__actions" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="model-center__icon" onClick={onEdit} aria-label={`编辑 ${provider.name || '模型'}`} title="编辑"><PencilIcon /></button>
      <button type="button" className="model-center__icon model-center__icon--danger" onClick={onRemove} aria-label={`删除 ${provider.name || '模型'}`} title="删除"><TrashIcon /></button>
      <button type="button" className={`model-center__switch ${provider.enabled === false ? '' : 'is-on'}`} onClick={onToggle} role="switch" aria-checked={provider.enabled !== false} aria-label={provider.enabled === false ? '启用模型' : '停用模型'}><span /></button>
    </div>
  </div>;
}

function ProviderChooser({ onChoose, onClose }) {
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const matches = (provider) => !keyword || `${provider.label} ${provider.description}`.toLowerCase().includes(keyword);
  const custom = PROVIDERS[0];
  const providers = PROVIDERS.slice(1).filter(matches);
  const customVisible = matches(custom);

  return <div className="model-center__chooser">
    <header><h3>添加模型</h3><button type="button" className="model-center__close" onClick={onClose} aria-label="关闭">×</button></header>
    <label className="model-center__search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务商..." aria-label="搜索服务商" /></label>
    {customVisible ? <button type="button" className="model-center__provider model-center__provider--wide" onClick={() => onChoose(custom)}><ProviderLogo logo={custom.logo} className="provider-logo--card" /><span><strong>{custom.label}</strong><small>{custom.description}</small></span><b>›</b></button> : null}
    {providers.length
      ? <div className="model-center__provider-grid">{providers.map((provider) => <button type="button" className="model-center__provider" key={provider.key} onClick={() => onChoose(provider)}><ProviderLogo logo={provider.logo} className="provider-logo--card" /><span><strong>{provider.label}</strong><small>{provider.description}</small></span><b>›</b></button>)}</div>
      : <p className="model-center__no-match">没有匹配的服务商，试试“自定义模型”。</p>}
  </div>;
}

function EyeIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
}

function EyeOffIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.7 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3M6.5 6.5A16.9 16.9 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.5-1.7" /><path d="m3 3 18 18" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>;
}

function CustomModelForm({ draft, editing, error, onChange, onSwitchProvider, onSubmit, onTest, testing = false, saving = false, testResult = null, onBack, onReset }) {
  const suggestionsId = 'model-center__model-suggestions';
  const isCustom = draft.providerKey === 'custom';
  const knownModels = draft.providerModels ?? [];
  const [showKey, setShowKey] = useState(false);
  const [useCustomModel, setUseCustomModel] = useState(editing && Boolean(draft.model) && !knownModels.includes(draft.model));

  const endpointInput = <input value={draft.endpoint} onChange={(event) => onChange({ endpoint: event.target.value })} placeholder="例如 https://api.openai.com/v1" />;

  const modelField = isCustom
    ? <label><em>*</em> 模型 ID<input value={draft.model} onChange={(event) => onChange({ model: event.target.value })} placeholder="输入模型 ID" list={suggestionsId} /><datalist id={suggestionsId}>{knownModels.map((model) => <option value={model} key={model} />)}</datalist></label>
    : <label><span className="model-center__label-row"><span><em>*</em> 模型</span>{useCustomModel && knownModels.length ? <button type="button" className="model-center__key-link" onClick={() => setUseCustomModel(false)}>从列表选择</button> : null}</span>
        {knownModels.length && !useCustomModel
          ? <select value={draft.model} onChange={(event) => event.target.value === '__custom__' ? (setUseCustomModel(true), onChange({ model: '' })) : onChange({ model: event.target.value })}><option value="" disabled>选择模型</option>{knownModels.map((model) => <option value={model} key={model}>{model}</option>)}<option value="__custom__">自定义模型 ID…</option></select>
          : <input value={draft.model} onChange={(event) => onChange({ model: event.target.value })} placeholder="输入模型 ID" />}</label>;

  const nameField = <label>模型展示名称<span className="model-center__label-hint">在模型列表中展示的名称，未设置时默认显示 Model ID。</span><input value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="请输入模型展示名称" maxLength={64} /></label>;

  const keyField = <label><span className="model-center__label-row"><span><em>*</em> API 密钥</span>{draft.providerKeyUrl ? <a className="model-center__key-link" href={draft.providerKeyUrl} target="_blank" rel="noreferrer">获取 API 密钥</a> : null}</span><span className="model-center__key-wrap"><input type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => onChange({ apiKey: event.target.value })} placeholder="请输入 API Key" autoComplete="off" /><button type="button" className="model-center__eye" onClick={() => setShowKey((visible) => !visible)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} title={showKey ? '隐藏' : '显示'}>{showKey ? <EyeOffIcon /> : <EyeIcon />}</button></span></label>;

  return <form className="model-center__form" onSubmit={onSubmit}>
    <header><button type="button" className="model-center__back" onClick={onBack} aria-label="返回">‹</button><h3>{editing ? '编辑模型' : isCustom ? '自定义模型' : '通过服务商添加'}</h3><button type="button" className="model-center__close" onClick={onBack} aria-label="关闭">×</button></header>
    {isCustom ? <label><em>*</em> API 格式<select value="openai-chat" onChange={() => {}}><option value="openai-chat">OpenAI Chat Completions 格式</option></select></label> : <label><em>*</em> 服务商<select value={draft.providerKey} onChange={(event) => onSwitchProvider(event.target.value)}>{PROVIDERS.map((provider) => <option value={provider.key} key={provider.key}>{provider.label}</option>)}</select></label>}
    {isCustom ? <label><em>*</em> 自定义请求地址<span className="model-center__label-hint">填写兼容 OpenAI API 的服务端地址，/chat/completions 会根据地址自动补全。</span>{endpointInput}</label> : null}
    {modelField}
    {keyField}
    <details><summary>高级配置 <span>›</span></summary>{!isCustom ? nameField : null}{!isCustom ? <label>请求地址 (OpenAI 兼容)<span className="model-center__label-hint">{draft.providerHint || '服务商默认地址已自动填入，可按需修改。'}</span>{endpointInput}</label> : null}<label>认证方式<select value={draft.authHeader} onChange={(event) => onChange({ authHeader: event.target.value })}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option></select></label></details>
    {testResult ? <p className={`model-center__test-result ${testResult.ok ? 'is-ok' : 'is-failed'}`} role="status">{testResult.ok ? `✓ 连通性测试通过 · ${testResult.latencyMs ?? '?'}ms · ${draft.model}` : `✗ ${testResult.error ?? '连通性测试失败'}`}</p> : null}
    {error ? <p className="model-center__form-error" role="alert">{error}</p> : null}
    <footer>
      <span>ⓘ 连通性测试会发起一次真实请求，可能消耗少量模型 Token；保存前会自动测试一次。</span>
      <button type="button" className="btn" onClick={onTest} disabled={testing || saving}>{testing ? '测试中…' : testResult ? '重新测试' : '测试连接'}</button>
      <button type="button" className="btn" onClick={onReset} disabled={testing || saving}>重置</button>
      <button type="submit" className="btn btn--primary" disabled={testing || saving}>{saving ? '测试并保存…' : editing ? '保存模型' : '添加模型'}</button>
    </footer>
  </form>;
}
