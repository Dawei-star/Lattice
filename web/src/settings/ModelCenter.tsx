import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Modal from '../ui/Modal.tsx';
import { aiApi } from '../api/ai.ts';
import { createAiProvider, isMaskedApiKey, loadAiSettings, saveAiSettings, subscribeAiSettings, type AiEmbeddingConfig, type AiProviderConfig, type AiSettings } from './aiSettings.ts';
import { CUSTOM_SERVICE, PROVIDERS, findProviderByService, isLocalOllamaEndpoint, type AiCatalogModelInfo, type AiProviderCatalogEntry } from './aiProviders.ts';
import { countOverriddenPrompts, detectLocalRuntimes, discoverProviderModels, loadModelCatalogEntries, type DiscoveredModel, type LocalRuntimeInfo } from './modelCatalog.ts';
import { isLoopbackEndpoint } from '../lib/ai-output.ts';

/** 连通性 / embedding / 工具能力测试的返回结果（服务端结构与状态字段动态）。 */
interface ConnectivityResult {
  ok?: boolean;
  error?: string;
  dim?: number;
  latencyMs?: number;
  /** W7c 能力实测：端点/模型是否接受工具调用面（undefined = 未实测） */
  nativeTools?: boolean;
}

/** 添加 / 编辑模型弹窗的表单草稿：供应商配置 + 目录元信息来源。 */
type ModelDraft = Omit<AiProviderConfig, 'id' | 'enabled' | 'contextWindowTokens'> & {
  id?: string;
  enabled?: boolean;
  contextWindowTokens?: number | string;
  providerKey: string;
  providerLabel: string;
  providerLogo: string;
  providerKeyUrl: string;
  providerHint: string;
  providerModels: string[];
  hasStoredKey?: boolean;
};

/** 语义索引状态（GET /ai/index/status）。 */
interface IndexStatus {
  pending?: number;
  failed?: number;
  configured?: boolean;
  model?: string;
  indexed?: number;
  totalNotes?: number;
  totalChunks?: number;
  latestError?: { message?: string } | null;
}

/** 检索调试命中的分块。 */
interface RetrievalBlock {
  noteId?: string;
  title?: string;
  anchor?: string;
  wholeNote?: boolean;
  excerpt?: string;
}

/** 检索调试预览结果（POST /ai/retrieval/preview）。 */
interface RetrievalPreviewResult {
  blocks?: RetrievalBlock[];
  semanticError?: string;
}

interface EmbeddingSectionProps {
  settings: AiSettings;
}

interface CustomModelRowProps {
  provider: AiProviderConfig;
  active: boolean;
  modelInfoIndex: Map<string, AiCatalogModelInfo>;
  onUse: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onToggle: () => void;
}

interface ProviderChooserProps {
  entries: AiProviderCatalogEntry[];
  localRuntimes: LocalRuntimeInfo[] | null;
  scanning: boolean;
  onScanLocal: () => void;
  onChoose: (provider: AiProviderCatalogEntry) => void;
  onPickLocalModel: (endpoint: string, modelId: string) => void;
  onClose: () => void;
}

interface ProviderLogoProps {
  logo: string;
  className?: string;
}

interface CustomModelFormProps {
  draft: ModelDraft;
  editing: boolean;
  error: string;
  onChange: (patch: Partial<ModelDraft>) => void;
  onSwitchProvider: (key: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
  testing?: boolean;
  saving?: boolean;
  testResult?: ConnectivityResult | null;
  onBack: () => void;
  onReset: () => void;
  /** W3：按端点动态拉取真实模型清单（OpenAI 兼容 /models）；失败回退手填 */
  onDiscoverModels?: (endpoint: string, apiKey: string, authHeader: string) => Promise<DiscoveredModel[]>;
}

export default function ModelCenter() {
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [addStep, setAddStep] = useState<'chooser' | 'form' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [formError, setFormError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectivityResult | null>(null);
  const [saving, setSaving] = useState(false);
  // W3：目录数据（桌面 = 内核 JSON + Vault 覆盖；失败回退内置 PROVIDERS）与本机运行时
  const [catalogEntries, setCatalogEntries] = useState<AiProviderCatalogEntry[]>(PROVIDERS);
  const [localRuntimes, setLocalRuntimes] = useState<LocalRuntimeInfo[] | null>(null);
  const [scanningRuntimes, setScanningRuntimes] = useState(false);
  const [overriddenPrompts, setOverriddenPrompts] = useState(0);

  useEffect(() => subscribeAiSettings(setSettings), []);

  useEffect(() => {
    let cancelled = false;
    void loadModelCatalogEntries().then((entries) => {
      if (!cancelled) setCatalogEntries(entries);
    });
    void countOverriddenPrompts().then((count) => {
      if (!cancelled) setOverriddenPrompts(count);
    });
    return () => { cancelled = true; };
  }, []);

  /** 模型 id → 能力详情（徽标：开放权重等），目录加载后即可用 */
  const modelInfoIndex = useMemo(() => {
    const index = new Map<string, AiCatalogModelInfo>();
    for (const entry of catalogEntries) {
      for (const info of entry.modelInfo ?? []) index.set(info.id.toLowerCase(), info);
    }
    return index;
  }, [catalogEntries]);

  const requestOptions = useMemo(() => {
    const accessToken = settings.accessToken?.trim();
    return accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};
  }, [settings.accessToken]);

  const openProviderChooser = () => {
    setFormError('');
    setAddStep('chooser');
  };

  const openProviderForm = (provider: AiProviderCatalogEntry = catalogEntries[0] ?? PROVIDERS[0], prefillModel = '') => {
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
      model: prefillModel,
      name: '',
      apiKey: '',
      authHeader: 'bearer',
      contextWindowTokens: '',
    });
    setAddStep('form');
  };

  const openEdit = (provider: AiProviderConfig) => {
    setEditingId(provider.id);
    setFormError('');
    setTestResult(null);
    const match = findProviderByService(provider.service);
    setDraft({
      ...provider,
      apiKey: '',
      hasStoredKey: Boolean(provider.apiKey),
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
  const switchDraftProvider = (key: string) => {
    setTestResult(null);
    const provider = catalogEntries.find((item) => item.key === key) ?? PROVIDERS[0];
    setDraft((current) => ({
      ...(current as ModelDraft),
      providerKey: provider.key,
      providerLabel: provider.label,
      providerLogo: provider.logo,
      providerKeyUrl: provider.keyUrl ?? '',
      providerHint: provider.hint ?? '',
      providerModels: provider.models ?? [],
      service: provider.key === 'custom' ? CUSTOM_SERVICE : provider.label,
      endpoint: provider.endpoint ?? '',
      model: '',
      apiKey: provider.key === 'ollama' ? '' : (current as ModelDraft).apiKey,
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
  const updateDraft = (patch: Partial<ModelDraft>) => {
    setTestResult(null);
    setDraft((current) => ({ ...(current as ModelDraft), ...patch }));
  };

  const probeProvider = async (provider: { endpoint: string; model: string; apiKey: string; authHeader: string }): Promise<ConnectivityResult> => {
    try {
      const result = await aiApi.test({ provider }, requestOptions);
      const base = (result ?? { ok: false, error: '测试请求没有返回结果' }) as ConnectivityResult;
      if (!base.ok) return base;
      // W7c 能力实测：连通成功后带 tools 的最小请求探一次（协商链第三环）。
      // 上游拒绝工具参数 → nativeTools=false（任务模式置灰）；实测失败不推翻连通结论。
      try {
        const toolsProbe = await aiApi.test({ provider, kind: 'tools' }, requestOptions) as { nativeTools?: boolean } | null;
        base.nativeTools = toolsProbe?.nativeTools === true;
      } catch {
        // 视为未知：UI 不置灰，任务模式失败时由内核按未注册/被拒路径兜底
      }
      return base;
    } catch (requestError) {
      return { ok: false, error: (requestError as Error)?.message ?? '测试请求失败，请确认本地服务已启动' };
    }
  };

  const runConnectivityTest = async () => {
    const endpoint = draft!.endpoint.trim();
    const model = draft!.model.trim();
    const apiKey = draft!.apiKey.trim();
    if (!endpoint || !model || (!apiKey && !isLocalOllamaEndpoint(endpoint))) {
      const result = { ok: false, error: '请先填写完整的 Endpoint、模型 ID 和 API Key 再测试。' };
      setTestResult(result);
      return result;
    }
    setTesting(true);
    try {
      const result = await probeProvider({ endpoint, model, apiKey, authHeader: draft!.authHeader });
      setTestResult(result);
      return result;
    } finally {
      setTesting(false);
    }
  };

  const submitProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (testing || saving) return;
    const next = {
      ...(draft as ModelDraft),
      name: draft!.name.trim() || draft!.model.trim(),
      model: draft!.model.trim(),
      endpoint: draft!.endpoint.trim(),
      apiKey: draft!.apiKey.trim(),
    };
    const existing = editingId ? settings.providers.find((provider) => provider.id === editingId) : null;
    const hasStoredKey = Boolean(existing?.apiKey || draft!.hasStoredKey);
    if (!next.endpoint || !next.model || (!next.apiKey && !hasStoredKey && !isLocalOllamaEndpoint(next.endpoint))) {
      setFormError('请填写完整的 Endpoint、模型 ID 和 API Key。');
      return;
    }
    // 服务端只回显掩码。编辑其它字段时留空表示沿用已保存的密钥。
    if (!next.apiKey && hasStoredKey && existing) {
      saveAiSettings({
        ...settings,
        providers: settings.providers.map((provider) => provider.id === editingId
          ? ({ ...provider, ...next, apiKey: provider.apiKey, verified: true } as AiProviderConfig)
          : provider),
      });
      closeModal();
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
        saveAiSettings({ ...settings, providers: settings.providers.map((provider) => provider.id === editingId
          ? ({ ...provider, ...next, verified: true, ...(result.nativeTools !== undefined ? { nativeTools: result.nativeTools } : {}) } as AiProviderConfig)
          : provider) });
      } else {
        const provider = createAiProvider({ ...next, verified: true, ...(result.nativeTools !== undefined ? { nativeTools: result.nativeTools } : {}) } as unknown as Partial<AiProviderConfig>);
        saveAiSettings({ ...settings, providers: [...settings.providers, provider], activeProviderId: provider.id });
      }
      closeModal();
    } finally {
      setSaving(false);
    }
  };

  const removeProvider = (provider: AiProviderConfig) => {
    if (!window.confirm(`删除模型“${provider.name || provider.model}”？`)) return;
    if (settings.providers.length === 1) {
      saveAiSettings({ ...settings, providers: settings.providers.map((item) => ({ ...item, endpoint: '', model: '', apiKey: '', enabled: false, verified: false })) });
      return;
    }
    const providers = settings.providers.filter((item) => item.id !== provider.id);
    saveAiSettings({ ...settings, providers, activeProviderId: settings.activeProviderId === provider.id ? providers[0].id : settings.activeProviderId });
  };

  const toggleProvider = (provider: AiProviderConfig) => saveAiSettings({
    ...settings,
    providers: settings.providers.map((item) => item.id === provider.id ? { ...item, enabled: item.enabled === false } : item),
  });

  // W3：扫描本机推理运行时（loopback 端口探测，免密钥，数据不出机器）
  const scanLocalRuntimes = async () => {
    if (scanningRuntimes) return;
    setScanningRuntimes(true);
    try {
      setLocalRuntimes(await detectLocalRuntimes());
    } finally {
      setScanningRuntimes(false);
    }
  };

  const formTitle = editingId ? '编辑模型' : draft?.providerKey === 'custom' ? '自定义模型' : '通过服务商添加';

  return <div className="model-center">
    <section className="model-center__intro">
      <div><span className="settings-kicker">MODEL MANAGEMENT</span><h3>模型管理</h3><p>选择服务商并配置 API Key 即可在聊天中使用，浏览器只保留密钥掩码。{overriddenPrompts > 0 ? ` Prompt 模板：${overriddenPrompts} 个已被 .lattice/prompts 自定义覆盖。` : ''}</p></div>
      <button type="button" className="btn btn--primary" onClick={openProviderChooser}>＋ 添加模型</button>
    </section>
    <section className="model-center__table" aria-label="模型列表">
      <div className="model-center__thead"><strong>模型</strong><strong>服务商</strong><strong>操作</strong></div>
      {settings.providers.length
        ? settings.providers.map((provider) => <CustomModelRow key={provider.id} provider={provider} active={provider.id === settings.activeProviderId} modelInfoIndex={modelInfoIndex} onUse={() => saveAiSettings({ ...settings, activeProviderId: provider.id })} onEdit={() => openEdit(provider)} onRemove={() => removeProvider(provider)} onToggle={() => toggleProvider(provider)} />)
        : <div className="model-center__empty"><strong>还没有模型</strong><p>点击右上角“添加模型”，选择服务商并填写 API Key。</p></div>}
    </section>
    {addStep ? <Modal open title={addStep === 'chooser' ? '添加模型' : formTitle} ariaLabel={addStep === 'chooser' ? '添加模型' : formTitle} onClose={closeModal} className="model-center__modal">
      {addStep === 'chooser'
        ? <ProviderChooser
            entries={catalogEntries}
            localRuntimes={localRuntimes}
            scanning={scanningRuntimes}
            onScanLocal={scanLocalRuntimes}
            onChoose={openProviderForm}
            onPickLocalModel={(endpoint, modelId) => {
              const local = catalogEntries.find((entry) => entry.local && entry.endpoint === endpoint)
                ?? catalogEntries.find((entry) => entry.local)
                ?? PROVIDERS.find((entry) => entry.key === 'ollama');
              if (local) openProviderForm(local, modelId);
            }}
            onClose={closeModal}
          />
        : <CustomModelForm key={`${draft!.providerKey}-${editingId ?? 'new'}`} draft={draft as ModelDraft} editing={Boolean(editingId)} error={formError} onChange={updateDraft} onSwitchProvider={switchDraftProvider} onSubmit={submitProvider} onTest={runConnectivityTest} testing={testing} saving={saving} testResult={testResult} onDiscoverModels={discoverProviderModels} onBack={() => { setFormError(''); setTestResult(null); setAddStep('chooser'); }} onReset={() => { setTestResult(null); setDraft((current) => ({ ...(current as ModelDraft), endpoint: '', model: '', name: '', apiKey: '' })); }} />}
    </Modal> : null}
    <SmallModelSection settings={settings} />
    <EmbeddingSection settings={settings} />
    <IndexStatusSection />
    <RetrievalDebugSection />
  </div>;
}

function SmallModelSection({ settings }: { settings: AiSettings }) {
  const configuredProviders = settings.providers.filter((provider) => provider.enabled !== false && provider.endpoint && provider.model && (provider.apiKey || isLocalOllamaEndpoint(provider.endpoint)));
  const selectedProviderId = configuredProviders.some((provider) => provider.id === settings.smallModelProviderId)
    ? settings.smallModelProviderId
    : configuredProviders[0]?.id ?? '';
  const selectedProvider = configuredProviders.find((provider) => provider.id === selectedProviderId);
  const enabled = settings.smallModelEnabled && Boolean(selectedProvider && settings.smallModelName.trim());
  const update = (patch: Partial<AiSettings>) => saveAiSettings({ ...settings, ...patch });

  return <section className="model-center__panel" aria-label="路由与重排模型">
    <header className="model-center__panel-head">
      <h4>路由与重排模型</h4>
      <span className={`model-center__pill ${enabled ? 'model-center__pill--ready' : 'model-center__pill--pending'}`}>{enabled ? '已启用' : '未启用'}</span>
      <div className="model-center__panel-actions">
        <button type="button" className={`model-center__switch ${enabled ? 'is-on' : ''}`} onClick={() => update({ smallModelEnabled: !settings.smallModelEnabled, smallModelProviderId: selectedProviderId })} role="switch" aria-checked={enabled} aria-label={enabled ? '停用路由与重排模型' : '启用路由与重排模型'} disabled={!selectedProvider || !settings.smallModelName.trim()}><span /></button>
      </div>
    </header>
    <div className="model-center__small-model-body">
      <div className="model-center__small-model-fields">
        <label>复用服务商<select value={selectedProviderId} onChange={(event) => update({ smallModelProviderId: event.target.value })} disabled={!configuredProviders.length}><option value="">请先配置远程模型</option>{configuredProviders.map((provider) => <option value={provider.id} key={provider.id}>{provider.name || provider.service} · {provider.model}</option>)}</select></label>
        <label>小模型 ID<input value={settings.smallModelName} onChange={(event) => update({ smallModelName: event.target.value })} placeholder={selectedProvider?.model || '例如 gpt-4o-mini'} maxLength={120} /></label>
      </div>
      <p className="model-center__small-model-hint">可使用同一服务商的轻量模型做意图判断和检索重排。意图判断会发送当前问题；重排只发送候选标题、短摘要和已有分数，不发送整篇笔记。未启用或调用失败时自动回退本地规则。</p>
    </div>
  </section>;
}

/**
 * 语义索引（Embedding）配置：启用后自动对全库笔记分块并向量化，
 * 解锁语义搜索、相关笔记推荐与带引用的知识库问答。
 * 隐私边界：启用云端 embedding 意味着笔记分块内容会发往该服务商，界面明确提示。
 */
function EmbeddingSection({ settings }: EmbeddingSectionProps) {
  const embedding = settings.embedding ?? { endpoint: '', model: '', apiKey: '', authHeader: 'bearer', enabled: false };
  const hasStoredKey = Boolean(embedding.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(() => (isMaskedApiKey(embedding.apiKey) ? '' : embedding.apiKey));
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectivityResult | null>(null);

  useEffect(() => {
    // 脱敏后的 settings 事件不应覆盖用户正在输入的页面内草稿。
    if (!isMaskedApiKey(embedding.apiKey)) setKeyDraft(embedding.apiKey ?? '');
  }, [embedding.apiKey]);

  const update = (patch: Partial<AiEmbeddingConfig>) => {
    setResult(null);
    saveAiSettings({ ...settings, embedding: { ...embedding, ...patch } });
  };

  const runTest = async () => {
    const apiKey = keyDraft.trim();
    if (!embedding.endpoint?.trim() || !embedding.model?.trim() || (!apiKey && !isLocalOllamaEndpoint(embedding.endpoint))) {
      setResult({ ok: false, error: '请输入新的 API Key 后再测试；已保存的密钥可直接保留使用。' });
      return;
    }
    setTesting(true);
    try {
      const response: any = await aiApi.test({
        kind: 'embedding',
        provider: {
          endpoint: embedding.endpoint,
          model: embedding.model,
          apiKey,
          authHeader: embedding.authHeader,
        },
      }, {});
      setResult(response?.data ?? response ?? { ok: false, error: '测试请求没有返回结果' });
    } catch (requestError) {
      setResult({ ok: false, error: (requestError as Error)?.message ?? '测试请求失败' });
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
        {!isLocalOllamaEndpoint(embedding.endpoint) ? <label>API Key<span className="model-center__key-wrap"><input type={showKey ? 'text' : 'password'} value={keyDraft} placeholder={hasStoredKey ? '已配置，留空保持不变' : ''} onChange={(event) => { setKeyDraft(event.target.value); update({ apiKey: event.target.value }); }} autoComplete="off" /><button type="button" className="model-center__eye" onClick={() => setShowKey((visible) => !visible)}>{showKey ? '隐藏' : '显示'}</button></span></label> : null}
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
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [reindexError, setReindexError] = useState('');

  const refresh = async () => {
    try {
      const response: any = await aiApi.indexStatus();
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
      setReindexError((error as Error)?.message ?? '重建索引入队失败，请稍后重试');
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
    {status?.failed && status?.latestError ? (
      <p className="model-center__index-summary" role="status">最近失败原因：{status.latestError.message}</p>
    ) : null}
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
  const [result, setResult] = useState<RetrievalPreviewResult | null>(null);
  const [error, setError] = useState('');

  const runPreview = async () => {
    const query = term.trim();
    if (!query || busy) return;
    setBusy(true);
    setError('');
    try {
      const response: any = await aiApi.retrievalPreview(query);
      setResult(response?.data ?? response ?? null);
    } catch (requestError) {
      setResult(null);
      setError((requestError as Error)?.message ?? '检索失败');
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

function ProviderLogo({ logo, className = '' }: ProviderLogoProps) {
  return <span className={`provider-logo ${className}`.trim()} aria-hidden="true"><img src={logo} alt="" loading="lazy" /></span>;
}

function PencilIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>;
}

function CustomModelRow({ provider, active, modelInfoIndex, onUse, onEdit, onRemove, onToggle }: CustomModelRowProps) {
  const match = findProviderByService(provider.service);
  const ready = Boolean(provider.endpoint && (provider.apiKey || isLocalOllamaEndpoint(provider.endpoint)) && provider.model);
  const isLocal = isLoopbackEndpoint(provider.endpoint);
  const openWeights = modelInfoIndex.get(provider.model.trim().toLowerCase())?.openWeights === true;
  return <div
    className={`model-center__row ${provider.enabled === false ? 'is-disabled' : ''} ${active ? 'is-active' : ''}`}
    onClick={onUse}
    title={active ? '当前使用的模型' : '点击设为当前使用'}
  >
    <div className="model-center__model-cell"><ProviderLogo logo={match.logo} /><div className="model-center__name"><span className="model-center__name-title"><strong>{provider.name || provider.model || '未命名模型'}</strong>{active ? <span className="model-center__pill model-center__pill--active">使用中</span> : null}{isLocal ? <span className="model-center__pill model-center__pill--local" title="本机推理端点，数据不出机器">本机</span> : null}{openWeights ? <span className="model-center__pill model-center__pill--open" title="开放权重模型（GitHub/HuggingFace 可得）">开放权重</span> : null}</span><small>{provider.model || '未填写模型 ID'}</small></div></div>
    <span className="model-center__service"><span className="model-center__service-name">{provider.service || CUSTOM_SERVICE}</span><span className={`model-center__pill ${ready ? 'model-center__pill--ready' : 'model-center__pill--pending'}`}>{ready ? '已配置' : '待完善'}</span></span>
    <div className="model-center__actions" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="model-center__icon" onClick={onEdit} aria-label={`编辑 ${provider.name || '模型'}`} title="编辑"><PencilIcon /></button>
      <button type="button" className="model-center__icon model-center__icon--danger" onClick={onRemove} aria-label={`删除 ${provider.name || '模型'}`} title="删除"><TrashIcon /></button>
      <button type="button" className={`model-center__switch ${provider.enabled === false ? '' : 'is-on'}`} onClick={onToggle} role="switch" aria-checked={provider.enabled !== false} aria-label={provider.enabled === false ? '启用模型' : '停用模型'}><span /></button>
    </div>
  </div>;
}

function ProviderChooser({ entries, localRuntimes, scanning, onScanLocal, onChoose, onPickLocalModel, onClose }: ProviderChooserProps) {
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const matches = (provider: AiProviderCatalogEntry) => !keyword || `${provider.label} ${provider.description}`.toLowerCase().includes(keyword);
  const custom = entries[0];
  const providers = entries.slice(1).filter(matches);
  const customVisible = matches(custom);

  return <div className="model-center__chooser">
    <header><h3>添加模型</h3><button type="button" className="model-center__close" onClick={onClose} aria-label="关闭">×</button></header>
    <label className="model-center__search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务商..." aria-label="搜索服务商" /></label>
    <section className="model-center__local-scan" aria-label="本机运行时">
      <div className="model-center__local-scan-head">
        <span>本机运行时 · 数据不出机器</span>
        <button type="button" className="btn btn--sm" onClick={onScanLocal} disabled={scanning}>{scanning ? '扫描中…' : '扫描本机'}</button>
      </div>
      {localRuntimes === null
        ? <small className="model-center__local-hint">已安装 Ollama / LM Studio 等本地推理？点击「扫描本机」自动发现已下载的模型，一键导入。</small>
        : localRuntimes.length === 0
          ? <small className="model-center__local-hint">未发现本机运行时。可先安装 Ollama 并拉取模型，或从下方选择云端服务商。</small>
          : localRuntimes.map((runtime) => <div className="model-center__local-runtime" key={runtime.endpoint}>
              <strong>{runtime.kind} · {runtime.endpoint}</strong>
              <div className="model-center__local-models">
                {runtime.models.map((model) => <button type="button" key={model.id} onClick={() => onPickLocalModel(runtime.endpoint, model.id)} title={model.label ?? model.id}>{model.id}</button>)}
              </div>
            </div>)}
    </section>
    {customVisible ? <button type="button" className="model-center__provider model-center__provider--wide" onClick={() => onChoose(custom)}><ProviderLogo logo={custom.logo} className="provider-logo--card" /><span><strong>{custom.label}</strong><small>{custom.description}</small></span><b>›</b></button> : null}
    {providers.length
      ? <div className="model-center__provider-grid">{providers.map((provider) => <button type="button" className="model-center__provider" key={provider.key} onClick={() => onChoose(provider)}><ProviderLogo logo={provider.logo} className="provider-logo--card" /><span><strong>{provider.label}{provider.local ? <em className="model-center__local-mark">本机</em> : null}</strong><small>{provider.description}</small></span><b>›</b></button>)}</div>
      : <p className="model-center__no-match">没有匹配的服务商，试试“自定义模型”。</p>}
  </div>;
}

function EyeIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
}

function EyeOffIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.7 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3M6.5 6.5A16.9 16.9 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.5-1.7" /><path d="m3 3 18 18" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>;
}

function CustomModelForm({ draft, editing, error, onChange, onSwitchProvider, onSubmit, onTest, testing = false, saving = false, testResult = null, onDiscoverModels, onBack, onReset }: CustomModelFormProps) {
  const suggestionsId = 'model-center__model-suggestions';
  const isCustom = draft.providerKey === 'custom';
  const knownModels = draft.providerModels ?? [];
  const [showKey, setShowKey] = useState(false);
  const [useCustomModel, setUseCustomModel] = useState(editing && Boolean(draft.model) && !knownModels.includes(draft.model));
  // W3：按端点动态拉取真实模型清单；失败回退手填，不阻塞保存
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const modelOptions = [...new Set([...knownModels, ...discovered])];

  useEffect(() => {
    setDiscovered([]);
    setDiscoverError('');
  }, [draft.endpoint, draft.providerKey]);

  const runDiscover = async () => {
    if (!onDiscoverModels || discovering) return;
    setDiscovering(true);
    setDiscoverError('');
    try {
      const models = await onDiscoverModels(draft.endpoint.trim(), draft.apiKey.trim(), draft.authHeader);
      setDiscovered(models.map((item) => item.id).filter(Boolean));
      if (!models.length) setDiscoverError('服务未返回模型清单，请手填模型 ID。');
    } catch (requestError) {
      setDiscovered([]);
      // Tauri 命令失败拒绝的是原始字符串（没有 .message），两种形态都要取到原因
      const reason = typeof requestError === 'string' ? requestError : (requestError as Error)?.message;
      if (!draft.apiKey.trim() && !isLocalOllamaEndpoint(draft.endpoint)) {
        setDiscoverError(`获取模型列表失败：请先在下方填写 API 密钥再拉取（上游原因：${reason || '未提供'}）。`);
      } else {
        setDiscoverError(`获取模型列表失败：${reason || '请手填模型 ID。'}`);
      }
    } finally {
      setDiscovering(false);
    }
  };

  const discoverAction = draft.endpoint.trim() && onDiscoverModels
    ? <button type="button" className="model-center__key-link" onClick={runDiscover} disabled={discovering}>{discovering ? '获取中…' : '获取模型列表'}</button>
    : null;
  const discoverHint = discoverError ? <small className="model-center__label-hint">{discoverError}</small> : null;

  const endpointInput = <input value={draft.endpoint} onChange={(event) => onChange({ endpoint: event.target.value })} placeholder="例如 https://api.openai.com/v1" />;

  const modelField = isCustom
    ? <label><span className="model-center__label-row"><span><em>*</em> 模型 ID</span>{discoverAction}</span><input value={draft.model} onChange={(event) => onChange({ model: event.target.value })} placeholder="输入模型 ID" list={suggestionsId} /><datalist id={suggestionsId}>{modelOptions.map((model) => <option value={model} key={model} />)}</datalist>{discoverHint}</label>
    : <label><span className="model-center__label-row"><span><em>*</em> 模型</span>{useCustomModel && modelOptions.length ? <button type="button" className="model-center__key-link" onClick={() => setUseCustomModel(false)}>从列表选择</button> : null}{discoverAction}</span>
        {modelOptions.length && !useCustomModel
          ? <select value={draft.model} onChange={(event) => event.target.value === '__custom__' ? (setUseCustomModel(true), onChange({ model: '' })) : onChange({ model: event.target.value })}><option value="" disabled>选择模型</option>{modelOptions.map((model) => <option value={model} key={model}>{model}</option>)}<option value="__custom__">自定义模型 ID…</option></select>
          : <input value={draft.model} onChange={(event) => onChange({ model: event.target.value })} placeholder="输入模型 ID" />}{discoverHint}</label>;

  const nameField = <label>模型展示名称<span className="model-center__label-hint">在模型列表中展示的名称，未设置时默认显示 Model ID。</span><input value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="请输入模型展示名称" maxLength={64} /></label>;

  const keyField = isLocalOllamaEndpoint(draft.endpoint) ? null : <label><span className="model-center__label-row"><span><em>*</em> API 密钥</span>{draft.providerKeyUrl ? <a className="model-center__key-link" href={draft.providerKeyUrl} target="_blank" rel="noreferrer">获取 API 密钥</a> : null}</span><span className="model-center__key-wrap"><input type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => onChange({ apiKey: event.target.value })} placeholder={draft.hasStoredKey ? '已配置，留空保持不变' : '请输入 API Key'} autoComplete="off" /><button type="button" className="model-center__eye" onClick={() => setShowKey((visible) => !visible)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} title={showKey ? '隐藏' : '显示'}>{showKey ? <EyeOffIcon /> : <EyeIcon />}</button></span></label>;

  return <form className="model-center__form" onSubmit={onSubmit}>
    <header><button type="button" className="model-center__back" onClick={onBack} aria-label="返回">‹</button><h3>{editing ? '编辑模型' : isCustom ? '自定义模型' : '通过服务商添加'}</h3><button type="button" className="model-center__close" onClick={onBack} aria-label="关闭">×</button></header>
    {isCustom ? <label><em>*</em> API 格式<select value="openai-chat" onChange={() => {}}><option value="openai-chat">OpenAI Chat Completions 格式</option></select></label> : <label><em>*</em> 服务商<select value={draft.providerKey} onChange={(event) => onSwitchProvider(event.target.value)}>{PROVIDERS.map((provider) => <option value={provider.key} key={provider.key}>{provider.label}</option>)}</select></label>}
    {isCustom ? <label><em>*</em> 自定义请求地址<span className="model-center__label-hint">填写兼容 OpenAI API 的服务端地址，/chat/completions 会根据地址自动补全。</span>{endpointInput}</label> : null}
    {modelField}
    {keyField}
    <details><summary>高级配置 <span>›</span></summary>{!isCustom ? nameField : null}{!isCustom ? <label>请求地址 (OpenAI 兼容)<span className="model-center__label-hint">{draft.providerHint || '服务商默认地址已自动填入，可按需修改。'}</span>{endpointInput}</label> : null}<label>认证方式<select value={draft.authHeader} onChange={(event) => onChange({ authHeader: event.target.value as AiProviderConfig['authHeader'] })}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option></select></label><label>温度 temperature (0–2)<span className="model-center__label-hint">越高回答越发散，越低越稳定；留空使用系统默认 0.2。</span><input type="number" min="0" max="2" step="0.1" value={draft.temperature ?? ''} onChange={(event) => onChange({ temperature: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="0.2" /></label><label>最大输出 tokens<span className="model-center__label-hint">限制单次回复长度，控制成本与时长；留空不限制。</span><input type="number" min="1" step="1" value={draft.maxTokens ?? ''} onChange={(event) => onChange({ maxTokens: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="不限制" /></label><label>上下文窗口 tokens<span className="model-center__label-hint">填写模型官方上下文上限；留空使用 128k，最大支持 1M。</span><input type="number" min="8000" max="1000000" step="1000" value={draft.contextWindowTokens ?? ''} onChange={(event) => onChange({ contextWindowTokens: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="128000" /></label><label>输入价格 USD / 1k tokens<span className="model-center__label-hint">用于本地成本估算；留空则只记录 token，不估算金额。</span><input type="number" min="0" step="0.000001" value={draft.promptCostPer1kUsd ?? ''} onChange={(event) => onChange({ promptCostPer1kUsd: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="留空" /></label><label>输出价格 USD / 1k tokens<span className="model-center__label-hint">按模型官方价格填写，单位为美元。</span><input type="number" min="0" step="0.000001" value={draft.completionCostPer1kUsd ?? ''} onChange={(event) => onChange({ completionCostPer1kUsd: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="留空" /></label></details>
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
