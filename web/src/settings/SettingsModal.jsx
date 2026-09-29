import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { mcpApi } from '../api/mcp.js';
import { vaultApi } from '../api/vault.js';
import { clearImportedTheme, importThemeFile, loadImportedTheme } from '../lib/theme.js';
import { loadSettings, saveSettings, subscribeSettings } from './settings.js';
import { createAiProvider, getActiveAiProvider, loadAiSettings, saveAiSettings, subscribeAiSettings } from './aiSettings.js';
import { createMcpServer, loadMcpSettings, saveMcpSettings } from './mcpSettings.js';
import ModelCenter from './ModelCenter.jsx';
import { checkGithubReleases } from '../lib/update.js';

const APP_VERSION = '0.1.1';
const LATTICE_ICON_URL = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAyNCIgaGVpZ2h0PSIxMDI0IiB2aWV3Qm94PSIwIDAgMTAyNCAxMDI0IiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHg9IjEwNCIgeT0iMTQ3IiB3aWR0aD0iODE1IiBoZWlnaHQ9IjgxNSIgcng9IjE1NSIgZmlsbD0iIzA0MEE0NiIvPjxyZWN0IHg9IjEwNCIgeT0iMTA0IiB3aWR0aD0iODE1IiBoZWlnaHQ9IjgxNSIgcng9IjE1NSIgZmlsbD0iIzE2MjU4NSIvPjxyZWN0IHg9IjEwMCIgeT0iMTQyIiB3aWR0aD0iNjk0IiBoZWlnaHQ9IjY5NCIgcng9IjEyNSIgZmlsbD0iIzFGMkVBMiIvPjxyZWN0IHg9IjEwMCIgeT0iMTAwIiB3aWR0aD0iNjk0IiBoZWlnaHQ9IjY5NCIgcng9IjEyNSIgZmlsbD0iIzNCNTBERiIvPjxyZWN0IHg9Ijk2IiB5PSIxMzgiIHdpZHRoPSI1NzIiIGhlaWdodD0iNTcyIiByeD0iOTYiIGZpbGw9IiM0QzY4RUIiLz48cmVjdCB4PSI5NiIgeT0iOTYiIHdpZHRoPSI1NzIiIGhlaWdodD0iNTcyIiByeD0iOTYiIGZpbGw9IiM3Qjk2RkYiLz48cmVjdCB4PSI5MiIgeT0iMTM0IiB3aWR0aD0iNDUxIiBoZWlnaHQ9IjQ1MSIgcng9IjY2IiBmaWxsPSIjOTBBOUZGIi8+PHJlY3QgeD0iOTIiIHk9IjkyIiB3aWR0aD0iNDUxIiBoZWlnaHQ9IjQ1MSIgcng9IjY2IiBmaWxsPSIjQzZENkZGIi8+PC9zdmc+';
const MAX_BACKGROUND_IMAGE_SIZE = 2 * 1024 * 1024;
const ALLOWED_BACKGROUND_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const GROUPS = [
  { title: 'AI 助手', items: [['models', '模型', 'layout']] },
  { title: '选项', items: [['about', '关于', 'info'], ['appearance', '外观', 'sun'], ['interface', '界面', 'layout'], ['editor', '编辑器', 'edit'], ['shortcuts', '快捷键', 'command']] },
  { title: '知识库', items: [['vault', '知识库位置', 'home'], ['migration', '数据迁移', 'refresh']] },
  { title: '集成', items: [['mcp', 'MCP Server', 'link']] },
];

export default function SettingsModal({ open, onClose, theme, onThemeChange }) {
  const [active, setActive] = useState('about');
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(() => loadSettings());
  const [migration, setMigration] = useState('idle');
  const [vaultPath, setVaultPath] = useState('');
  const [vaultNotice, setVaultNotice] = useState(null);
  const [updateState, setUpdateState] = useState('idle');
  const updateRequestRef = useRef(0);
  const [importedTheme, setImportedTheme] = useState(() => loadImportedTheme());
  const searchRef = useRef(null);

  useEffect(() => subscribeSettings(setSettings), []);

  useEffect(() => {
    if (!open) return undefined;
    setSettings(loadSettings());
    setSearch('');
    setMigration('idle');
    setVaultNotice(null);
    setUpdateState('idle');
    loadVaultPath();

    const handleSearchShortcut = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, [open]);

  const updateSetting = (key, value) => setSettings(saveSettings({ [key]: value }));
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return GROUPS
      .map((group) => ({ ...group, items: group.items.filter((item) => !query || item[1].toLowerCase().includes(query)) }))
      .filter((group) => group.items.length);
  }, [search]);
  const label = GROUPS.flatMap((group) => group.items).find((item) => item[0] === active)?.[1] ?? '设置';

  useEffect(() => {
    if (!search.trim()) return;
    const firstMatch = groups[0]?.items[0]?.[0];
    if (firstMatch) setActive(firstMatch);
  }, [groups, search]);

  async function loadVaultPath() {
    try {
      const info = await (window.latticeDesktop?.getVaultInfo?.() ?? vaultApi.info());
      setVaultPath(info?.path ?? info?.vaultDir ?? '');
    } catch {
      setVaultPath('');
    }
  }

  const copyVaultPath = async () => {
    if (!vaultPath) return;
    try {
      await navigator.clipboard.writeText(vaultPath);
      setVaultNotice({ tone: 'success', text: '知识库路径已复制。' });
    } catch {
      setVaultNotice({ tone: 'danger', text: '复制失败，请手动选择路径。' });
    }
  };

  const revealVault = async () => {
    const revealed = await window.latticeDesktop?.revealVault?.();
    setVaultNotice(revealed
      ? { tone: 'success', text: '已在资源管理器中打开知识库。' }
      : { tone: 'neutral', text: '打开目录仅在桌面版可用。' });
  };

  const migrate = async () => {
    if (!window.confirm('将当前 SQLite 笔记导出为 Markdown 文件？原数据库不会被删除。')) return;
    setMigration('running');
    try {
      await vaultApi.migrate();
      setMigration('done');
    } catch {
      setMigration('error');
    }
  };

  const checkForUpdates = async () => {
    const requestId = updateRequestRef.current + 1;
    updateRequestRef.current = requestId;
    setUpdateState('checking');
    try {
      const release = await checkGithubReleases({ currentVersion: APP_VERSION });
      if (requestId !== updateRequestRef.current) return;
      setUpdateState({ status: release.isUpdateAvailable ? 'available' : 'current', release });
    } catch (error) {
      if (requestId !== updateRequestRef.current) return;
      setUpdateState({ status: 'error', message: error?.message ?? '无法连接 GitHub，请稍后重试' });
    }
  };

  return <Modal open={open} onClose={onClose} title="设置" ariaLabel="设置"><div className="settings-workspace">
    <aside className="settings-nav">
      <div className="settings-nav__brand"><img className="settings-nav__mark" src={LATTICE_ICON_URL} alt="Lattice" /><div><strong>设置</strong><small>Preferences</small></div></div>
      <label className="settings-search"><span aria-hidden="true">⌕</span><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索设置..." aria-label="搜索设置" /><kbd>⌘ K</kbd></label>
      <nav aria-label="设置分类">
        {groups.map((group) => <div className="settings-nav__group" key={group.title}>
          <div className="settings-nav__group-title">{group.title}</div>
          {group.items.map(([id, text, icon]) => <button type="button" key={id} className={'settings-nav__item ' + (active === id ? 'is-active' : '')} onClick={() => setActive(id)}><span className="settings-nav__icon"><NavIcon name={icon} /></span><span>{text}</span>{active === id ? <span className="settings-nav__chevron">›</span> : null}</button>)}
        </div>)}
        {!groups.length ? <div className="settings-nav__empty">没有匹配的设置</div> : null}
      </nav>
      <div className="settings-nav__footer"><span className="settings-nav__status-dot" />本地工作区<span className="settings-nav__version">v{APP_VERSION}</span></div><button type="button" className="settings-nav__close" onClick={onClose}>关闭设置 <span>Esc</span></button>
    </aside>
    <main className="settings-content"><header className="settings-content__head"><div><span className="settings-content__eyebrow">LATTICE / PREFERENCES</span><h2>{label}</h2><p className="settings-content__intro">调整 Lattice 的工作方式与阅读体验，修改会立即生效。</p></div><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭设置">×</button></header>
      <div className="settings-content__body">
        {active === 'about' && <About settings={settings} onChange={updateSetting} onCheckUpdate={checkForUpdates} updateState={updateState} />}
        {active === 'models' && <ModelCenter />}
        {active === 'appearance' && <><BackgroundImagePanel image={settings.backgroundImage} onChange={(value) => updateSetting('backgroundImage', value)} /><ThemeImportPanel theme={importedTheme} onChange={setImportedTheme} /><Section title="外观"><Row title="主题" description="选择工作区使用的颜色主题。"><select aria-label="主题" value={theme} onChange={(event) => onThemeChange(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></Row><Row title="界面密度" description="调整导航、列表和工具栏的垂直间距。"><select aria-label="界面密度" value={settings.density} onChange={(event) => updateSetting('density', event.target.value)}><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></Row></Section></>}
        {active === 'interface' && <Section title="界面"><Row title="界面字号" description="调整设置、列表和工具栏的基础字号。"><select aria-label="界面字号" value={settings.fontSize} onChange={(event) => updateSetting('fontSize', event.target.value)}><option value="13">小</option><option value="14">标准</option><option value="15">大</option></select></Row><Row title="内容最大宽度" description="控制编辑器和 Markdown 预览的阅读宽度。"><select aria-label="内容最大宽度" value={settings.contentWidth} onChange={(event) => updateSetting('contentWidth', event.target.value)}><option value="720">720px</option><option value="860">860px</option><option value="1040">1040px</option></select></Row></Section>}
        {active === 'editor' && <Section title="编辑器"><Row title="默认编辑模式" description="打开笔记时使用的初始视图。"><select aria-label="默认编辑模式" value={settings.editorMode} onChange={(event) => updateSetting('editorMode', event.target.value)}><option value="split">分栏</option><option value="edit">编辑</option><option value="preview">预览</option></select></Row><Row title="Tab 缩进" description={`按 Tab 插入 ${settings.tabSize} 个空格。`}><select aria-label="Tab 缩进" value={settings.tabSize} onChange={(event) => updateSetting('tabSize', event.target.value)}><option value="2">2 个空格</option><option value="4">4 个空格</option></select></Row><Row title="自动保存" description="停止输入后自动写入 Markdown 文件。"><Toggle checked={settings.autoSave} onChange={(value) => updateSetting('autoSave', value)} /></Row><Row title="自动保存延迟" description="停止输入后等待多久写入磁盘。"><select aria-label="自动保存延迟" value={settings.autoSaveDelay} disabled={!settings.autoSave} onChange={(event) => updateSetting('autoSaveDelay', event.target.value)}><option value="500">500 ms</option><option value="900">900 ms</option><option value="1500">1500 ms</option></select></Row></Section>}
        {active === 'shortcuts' && <Section title="快捷键"><div className="shortcut-list">{[['快速切换', 'Ctrl / Cmd + K'], ['新建笔记', 'Ctrl / Cmd + N'], ['保存笔记', 'Ctrl / Cmd + S'], ['设置', 'Ctrl / Cmd + ,'], ['编辑 / 预览', 'Ctrl / Cmd + E']].map(([name, key]) => <div className="shortcut-row" key={name}><span>{name}</span><kbd>{key}</kbd></div>)}</div></Section>}
        {active === 'vault' && <><Section title="知识库位置"><Row title="当前知识库目录" description={vaultPath || '正在读取知识库目录...'}><button type="button" className="btn" onClick={loadVaultPath}>重新读取</button></Row><Row title="路径快捷操作" description="快速定位或复制当前知识库目录。"><div className="settings-inline-actions"><button type="button" className="btn" disabled={!vaultPath || !window.latticeDesktop?.revealVault} onClick={revealVault}>打开目录</button><button type="button" className="btn" disabled={!vaultPath} onClick={copyVaultPath}>复制路径</button></div></Row></Section>{vaultNotice ? <Notice tone={vaultNotice.tone}>{vaultNotice.text}</Notice> : null}<Section title="索引状态"><div className="settings-health"><span className="settings-health__dot" /><div><strong>索引正常</strong><p>笔记、标签与双链会随文件变化自动更新。</p></div><span className="settings-value">实时</span></div></Section></>}
        {active === 'mcp' && <McpServerSettings />}
        {active === 'migration' && <Section title="数据迁移"><Row title="导出为 Markdown" description="原数据库会保留，不会被删除。"><button type="button" className="btn btn--primary" onClick={migrate} disabled={migration === 'running'}>{migration === 'running' ? '迁移中...' : '开始迁移'}</button></Row>{migration === 'done' && <Notice tone="success">迁移完成，Markdown 文件已写入当前知识库。</Notice>}{migration === 'error' && <Notice tone="danger">迁移失败，请检查后端服务后重试。</Notice>}</Section>}
      </div>
    </main>
  </div></Modal>;
}

function ModelSettings() {
  const [aiSettings, setAiSettings] = useState(() => loadAiSettings());
  const [editingId, setEditingId] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => subscribeAiSettings(setAiSettings), []);

  const activeProvider = getActiveAiProvider(aiSettings);
  const updateProvider = (providerId, patch) => setAiSettings(() => saveAiSettings({
    ...aiSettings,
    providers: aiSettings.providers.map((provider) => provider.id === providerId ? { ...provider, ...patch } : provider),
  }));
  const addProvider = () => {
    const provider = createAiProvider();
    saveAiSettings({ ...aiSettings, providers: [...aiSettings.providers, provider], activeProviderId: provider.id });
    setEditingId(provider.id);
    setNotice('已添加模型配置，请填写接口地址、模型名称和 API Key。');
  };
  const selectProvider = (providerId) => saveAiSettings({ ...aiSettings, activeProviderId: providerId });
  const removeProvider = (provider) => {
    if (aiSettings.providers.length === 1) {
      setNotice('至少保留一个模型配置。你可以清空它的接口信息，或添加其他模型后再删除。');
      return;
    }
    if (!window.confirm(`删除模型配置“${provider.name || '未命名模型'}”？`)) return;
    const providers = aiSettings.providers.filter((item) => item.id !== provider.id);
    saveAiSettings({ ...aiSettings, providers, activeProviderId: aiSettings.activeProviderId === provider.id ? providers[0].id : aiSettings.activeProviderId });
    if (editingId === provider.id) setEditingId(null);
  };

  return <div className="model-settings">
    <section className="model-settings__hero">
      <div><span className="settings-kicker">AI PROVIDERS</span><h3>模型与接口</h3><p>集中管理 OpenAI 兼容接口和模型。聊天时可从顶部直接切换当前模型。</p></div>
      <button type="button" className="btn btn--primary" onClick={addProvider}>＋ 添加模型</button>
    </section>
    <div className="model-settings__summary">
      <div><span>当前使用</span><strong>{activeProvider?.name || '未配置'}</strong><small>{activeProvider?.model || '尚未选择模型'}</small></div>
      <div><span>模型配置</span><strong>{aiSettings.providers.length}</strong><small>保存在本机浏览器</small></div>
      <div><span>连接状态</span><strong className={activeProvider?.endpoint && activeProvider?.apiKey && activeProvider?.model ? 'is-ready' : 'is-muted'}>{activeProvider?.endpoint && activeProvider?.apiKey && activeProvider?.model ? '已配置' : '待完善'}</strong><small>不会把 API Key 写入审计记录</small></div>
    </div>
    <Section title="已添加的模型">
      <div className="model-settings__list">
        {aiSettings.providers.map((provider) => <ModelProviderRow
          key={provider.id}
          provider={provider}
          active={provider.id === aiSettings.activeProviderId}
          editing={provider.id === editingId}
          onSelect={() => selectProvider(provider.id)}
          onEdit={() => setEditingId(editingId === provider.id ? null : provider.id)}
          onChange={(patch) => updateProvider(provider.id, patch)}
          onRemove={() => removeProvider(provider)}
        />)}
      </div>
    </Section>
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    <Section title="配置说明">
      <div className="model-settings__guide"><span>1</span><p><strong>添加模型</strong>：为每个服务商建立独立配置，Endpoint、模型名和 API Key 不会互相覆盖。</p><span>2</span><p><strong>选择当前模型</strong>：点击列表中的“使用”或在聊天面板顶部切换，下一条消息立即生效。</p><span>3</span><p><strong>智谱示例</strong>：Endpoint 使用 <code>https://open.bigmodel.cn/api/paas/v4/chat/completions</code>，模型名以控制台实际开放的名称为准。</p></div>
    </Section>
  </div>;
}

function ModelProviderRow({ provider, active, editing, onSelect, onEdit, onChange, onRemove }) {
  const ready = Boolean(provider.endpoint && provider.apiKey && provider.model);
  return <article className={`model-provider-row ${active ? 'is-active' : ''} ${editing ? 'is-editing' : ''}`}>
    <div className="model-provider-row__summary">
      <button type="button" className="model-provider-row__radio" onClick={onSelect} aria-label={`使用 ${provider.name || '模型配置'}`}><span /></button>
      <div className="model-provider-row__identity"><strong>{provider.name || '未命名模型'}</strong><span>{provider.model || '未填写模型名称'} · {provider.authHeader === 'x-api-key' ? 'x-api-key' : 'Bearer'}</span></div>
      <span className={`model-provider-row__status ${ready ? 'is-ready' : ''}`}>{ready ? '已配置' : '待完善'}</span>
      {active ? <span className="model-provider-row__active">当前使用</span> : <button type="button" className="btn btn--sm" onClick={onSelect}>使用</button>}
      <button type="button" className="btn btn--sm" onClick={onEdit}>{editing ? '收起' : '编辑'}</button>
      <button type="button" className="model-provider-row__delete" onClick={onRemove} aria-label={`删除 ${provider.name || '模型配置'}`}>×</button>
    </div>
    {editing ? <div className="model-provider-row__editor">
      <label>配置名称<input value={provider.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="例如：智谱 GLM" /></label>
      <label>Endpoint<input value={provider.endpoint} onChange={(event) => onChange({ endpoint: event.target.value })} placeholder="https://api.openai.com/v1/chat/completions" /></label>
      <div className="model-settings__form-grid"><label>模型名称<input value={provider.model} onChange={(event) => onChange({ model: event.target.value })} placeholder="例如：glm-5.3-flash" /></label><label>认证方式<select value={provider.authHeader} onChange={(event) => onChange({ authHeader: event.target.value })}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option></select></label></div>
      <label>API Key<input type="password" value={provider.apiKey} onChange={(event) => onChange({ apiKey: event.target.value })} placeholder="仅保存在本机浏览器" autoComplete="off" /></label>
      <p>API Key 仅用于当前模型请求，界面和操作历史不会显示完整 Key。</p>
    </div> : null}
  </article>;
}

const DEFAULT_MCP_TOOLS = [
  { name: 'list_notes', description: '列出知识库中的笔记' },
  { name: 'search_notes', description: '全文搜索笔记' },
  { name: 'read_note', description: '读取笔记的完整 Markdown 内容' },
  { name: 'create_note', description: '创建一篇新笔记' },
  { name: 'update_note', description: '更新笔记正文' },
];

function McpServerSettings() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(() => loadMcpSettings());
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [envText, setEnvText] = useState('{}');
  const [editorError, setEditorError] = useState('');
  const [notice, setNotice] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  const updateSettings = (updater) => {
    setSettings((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      return saveMcpSettings(next);
    });
  };

  const createLatticeServer = (serverInfo = info) => ({
    id: 'lattice-local',
    key: 'lattice',
    name: 'Lattice',
    description: '当前知识库的 MCP Server',
    command: serverInfo?.command || 'node',
    args: [serverInfo?.serverPath || 'D:\\path\\to\\lattice\\scripts\\mcp-server\\server.mjs'],
    env: {
      DB_FILE: serverInfo?.dbFile || 'D:\\path\\to\\data\\lattice.db',
      VAULT_DIR: serverInfo?.vaultDir || 'D:\\path\\to\\data\\vault',
    },
    transport: 'stdio',
    enabled: true,
    builtin: true,
    tools: serverInfo?.tools?.length ? serverInfo.tools : DEFAULT_MCP_TOOLS,
  });

  const loadInfo = async ({ silent = false } = {}) => {
    setLoading(true);
    try {
      const nextInfo = await mcpApi.info();
      setInfo(nextInfo);
      updateSettings((current) => {
        const lattice = createLatticeServer(nextInfo);
        const existing = current.servers.find((server) => server.id === lattice.id);
        const servers = existing
          ? current.servers.map((server) => server.id === lattice.id ? { ...lattice, enabled: server.enabled } : server)
          : [lattice, ...current.servers];
        return { ...current, servers };
      });
      if (!silent) setNotice({ tone: 'success', text: 'MCP Server 配置已刷新。' });
    } catch {
      setNotice({ tone: 'danger', text: '无法读取 MCP 配置，请确认后端服务已启动。' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInfo({ silent: true });
  }, []);

  const toggleServer = (serverId) => {
    updateSettings((current) => ({
      ...current,
      servers: current.servers.map((server) => server.id === serverId ? { ...server, enabled: !server.enabled } : server),
    }));
  };

  const openEditor = (server) => {
    setEditingId(server.id);
    setDraft({ ...server, argsText: server.args.join('\n') });
    setEnvText(JSON.stringify(server.env, null, 2));
    setEditorError('');
  };

  const openCreator = () => {
    const server = createMcpServer();
    setEditingId('new');
    setDraft({ ...server, argsText: '' });
    setEnvText('{}');
    setEditorError('');
  };

  const closeEditor = () => {
    setEditingId(null);
    setDraft(null);
    setEditorError('');
  };

  const saveDraft = () => {
    const name = draft?.name?.trim();
    const command = draft?.command?.trim();
    if (!name || !command) {
      setEditorError('请填写 Server 名称和启动命令。');
      return;
    }
    let env;
    try {
      env = JSON.parse(envText || '{}');
      if (!env || Array.isArray(env) || typeof env !== 'object') throw new Error('env');
      if (Object.entries(env).some(([key, value]) => !key || typeof value !== 'string')) throw new Error('env');
    } catch {
      setEditorError('环境变量必须是 JSON 对象，值需要使用字符串。');
      return;
    }
    const server = {
      ...draft,
      name,
      command,
      args: String(draft.argsText || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      env,
      url: String(draft.url || '').trim(),
      argsText: undefined,
    };
    delete server.argsText;
    updateSettings((current) => ({
      ...current,
      servers: editingId === 'new'
        ? [...current.servers, server]
        : current.servers.map((item) => item.id === editingId ? server : item),
    }));
    setNotice({ tone: 'success', text: 'MCP Server 配置已保存。' });
    closeEditor();
  };

  const importConfig = async (event) => {
    const file = event.target.files?.[0];
    setFileInputKey((value) => value + 1);
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const source = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : parsed;
      const imported = Object.entries(source ?? {}).filter(([, value]) => value && typeof value === 'object').map(([key, value]) => createMcpServer({
        id: 'mcp-import-' + safeMcpKey(key),
        key,
        name: key,
        description: '从配置文件导入',
        command: value.command || 'node',
        args: Array.isArray(value.args) ? value.args : [],
        env: value.env || {},
        url: value.url || '',
        transport: value.url ? 'sse' : 'stdio',
        enabled: true,
      }));
      if (!imported.length) throw new Error('empty');
      updateSettings((current) => ({ ...current, servers: mergeMcpServers(current.servers, imported) }));
      setNotice({ tone: 'success', text: '已导入 ' + imported.length + ' 个 MCP Server。' });
    } catch {
      setNotice({ tone: 'danger', text: '导入失败，请选择有效的 MCP 配置 JSON。' });
    }
  };

  const managedServers = settings.servers.length ? settings.servers : [createLatticeServer(info)];
  const serverList = managedServers.filter((server) => {
    const query = search.trim().toLowerCase();
    return !query || [server.name, server.description, server.command, server.key].some((value) => String(value || '').toLowerCase().includes(query));
  });
  const enabledCount = managedServers.filter((server) => server.enabled).length;
  const toolList = managedServers.find((server) => server.id === 'lattice-local')?.tools
    ?? info?.tools
    ?? DEFAULT_MCP_TOOLS;
  const configText = useMemo(() => JSON.stringify({
    mcpServers: Object.fromEntries(managedServers.filter((server) => server.enabled).map((server) => [server.key, toMcpConfig(server)])),
  }, null, 2), [managedServers]);

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(configText);
      setNotice({ tone: 'success', text: '已复制当前启用的 MCP 配置。' });
    } catch {
      setNotice({ tone: 'danger', text: '复制失败，请手动选择配置内容。' });
    }
  };

  return <div className="mcp-settings mcp-manager">
    <section className="mcp-manager__hero">
      <div><span className="settings-kicker">MCP INTEGRATION</span><h3>MCP 服务器</h3><p>管理当前工作区中可供外部 Agent 使用的 MCP Server。</p></div>
      <div className="mcp-manager__stats"><strong>{managedServers.length}</strong><span>已配置</span><strong>{enabledCount}</strong><span>已启用</span></div>
    </section>
    <div className="mcp-manager__toolbar">
      <div className="mcp-manager__scope"><button type="button" className="is-active">用户</button><span>MCP {managedServers.length}</span></div>
      <label className="mcp-manager__search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 MCP Server..." aria-label="搜索 MCP Server" /></label>
      <div className="mcp-manager__actions"><button type="button" className="icon-btn" onClick={loadInfo} aria-label="刷新 MCP Server" title="刷新"><NavIcon name="refresh" /></button><label className="btn"><span>导入</span><input key={fileInputKey} type="file" accept=".json,application/json" onChange={importConfig} /></label><button type="button" className="btn btn--primary" onClick={openCreator}>+ 新建</button></div>
    </div>
    <section className="mcp-manager__block">
      <div className="mcp-manager__panel mcp-manager__project">
        <div className="mcp-manager__server-icon">MCP</div><div><strong>启用项目级 MCP</strong><p>允许从当前项目根目录的配置中加载 MCP Server。</p></div><McpToggle checked={settings.projectEnabled} onChange={(value) => updateSettings((current) => ({ ...current, projectEnabled: value }))} label="启用项目级 MCP" />
      </div>
    </section>
    <section className="mcp-manager__block">
      <div className="mcp-manager__section-head"><div><h4>已配置的 MCP Servers</h4><p>管理已添加的 MCP Server，可启用、编辑或导出配置。</p></div><button type="button" className="btn btn--sm" onClick={copyConfig}>复制启用配置</button></div>
      <div className="mcp-manager__panel mcp-manager__list">
        {serverList.length ? serverList.map((server) => <article className={'mcp-server-row ' + (server.enabled ? 'is-enabled' : 'is-disabled')} key={server.id}>
          <div className="mcp-manager__server-icon">{server.builtin ? 'L' : 'MCP'}</div><div className="mcp-server-row__identity"><div><strong>{server.name}</strong>{server.builtin ? <span className="mcp-server-row__verified">✓</span> : null}</div><p>{server.description || server.transport.toUpperCase() + ' MCP Server'}</p><code>{server.transport === 'sse' ? server.url : server.command + (server.args[0] ? ' · ' + server.args[0] : '')}</code></div><span className="mcp-server-row__state">{server.enabled ? '已启用' : '已停用'}</span><button type="button" className="icon-btn" onClick={() => openEditor(server)} aria-label={'配置 ' + server.name} title="配置"><NavIcon name="edit" /></button><McpToggle checked={server.enabled} onChange={() => toggleServer(server.id)} label={(server.enabled ? '停用 ' : '启用 ') + server.name} />
        </article>) : <div className="mcp-manager__empty"><strong>没有匹配的 MCP Server</strong><span>尝试修改搜索关键词，或新建一个 Server。</span></div>}
      </div>
    </section>
    {editingId ? <McpServerEditor draft={draft} envText={envText} error={editorError} onChange={setDraft} onEnvChange={setEnvText} onSave={saveDraft} onClose={closeEditor} /> : null}
    {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
    <section className="mcp-manager__block">
      <div className="mcp-manager__section-head"><div><h4>当前 Server 工具</h4><p>Lattice MCP Server 暴露以下知识库操作。</p></div><span className="settings-value">{loading ? '读取中...' : info ? 'stdio · 配置可用' : '未读取'}</span></div>
      <div className="mcp-manager__panel mcp-settings__tools">{toolList.map((tool) => <div className="mcp-settings__tool" key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></div>)}</div>
    </section>
    <section className="mcp-manager__block">
      <div className="mcp-manager__section-head"><div><h4>导出配置</h4><p>复制当前启用的 Server，粘贴到 Claude Desktop 或其他 MCP 客户端。</p></div><button type="button" className="btn btn--primary" onClick={copyConfig}>复制 JSON</button></div>
      <div className="mcp-manager__panel mcp-settings__config"><pre aria-label="MCP 配置"><code>{configText}</code></pre></div>
    </section>
    <Notice>浏览器不能直接拉起任意 stdio 进程；列表中的开关管理本机配置，真正连接由 Claude Desktop 等 MCP 客户端完成。</Notice>
  </div>;
}

function McpServerEditor({ draft, envText, error, onChange, onEnvChange, onSave, onClose }) {
  if (!draft) return null;
  return <section className="mcp-manager__block mcp-editor">
    <div className="mcp-manager__section-head"><div><h4>{draft.builtin ? '配置 Lattice MCP Server' : '配置 MCP Server'}</h4><p>保存后会写入当前浏览器的本地设置。</p></div><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭 MCP 配置">×</button></div>
    <div className="mcp-manager__panel mcp-editor__form">
      <div className="mcp-editor__grid"><label>显示名称<input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label><label>传输方式<select value={draft.transport} onChange={(event) => onChange({ ...draft, transport: event.target.value })}><option value="stdio">stdio</option><option value="sse">SSE</option></select></label></div>
      {draft.transport === 'sse' ? <label>Server URL<input value={draft.url || ''} onChange={(event) => onChange({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label> : <><label>启动命令<input value={draft.command} onChange={(event) => onChange({ ...draft, command: event.target.value })} placeholder="node" /></label><label>启动参数<span className="mcp-editor__hint">每行一个参数</span><textarea value={draft.argsText} onChange={(event) => onChange({ ...draft, argsText: event.target.value })} rows="3" placeholder="D:\\path\\to\\server.mjs" /></label></>}
      <label>环境变量 JSON<textarea value={envText} onChange={(event) => onEnvChange(event.target.value)} rows="4" spellCheck="false" placeholder={'{\n  "API_KEY": "..."\n}'} /></label>
      {error ? <p className="mcp-editor__error" role="alert">{error}</p> : null}
      <div className="mcp-editor__actions"><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn btn--primary" onClick={onSave}>保存配置</button></div>
    </div>
  </section>;
}

function McpToggle({ checked, onChange, label }) {
  return <button type="button" className={'mcp-toggle ' + (checked ? 'is-on' : '')} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>;
}

function toMcpConfig(server) {
  return server.transport === 'sse'
    ? { url: server.url, headers: server.env }
    : { command: server.command, args: server.args, env: server.env };
}

function safeMcpKey(value) {
  return String(value || 'server').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function mergeMcpServers(existing, imported) {
  const importedKeys = new Set(imported.map((server) => server.key));
  return [...existing.filter((server) => !importedKeys.has(server.key)), ...imported];
}

function About({ settings, onChange, onCheckUpdate, updateState }) {
  const isChecking = updateState === 'checking';
  const status = updateState?.status;
  const release = updateState?.release;
  return <><Section title="关于 Lattice"><div className="settings-about"><img className="settings-about__mark" src={LATTICE_ICON_URL} alt="Lattice" /><div><h3>Lattice</h3><p>本地优先的双链知识库。</p><span>当前版本 {APP_VERSION} · Windows Desktop</span></div><button type="button" className="btn" onClick={onCheckUpdate} disabled={isChecking}>{isChecking ? '检查中...' : '检查更新'}</button></div><UpdateResult status={status} release={release} message={updateState?.message} /></Section><Row title="自动保存" description="编辑内容会在短暂空闲后自动保存。"><Toggle checked={settings.autoSave} onChange={(value) => onChange('autoSave', value)} /></Row><Row title="快捷切换" description="允许使用 Ctrl / Cmd + K 打开快速切换器。"><Toggle checked={settings.quickSwitcher} onChange={(value) => onChange('quickSwitcher', value)} /></Row><Section title="账户"><Row title="本地工作区" description="Lattice 不要求登录，数据默认保存在本机。"><span className="settings-value">离线可用</span></Row></Section></>;
}

function UpdateResult({ status, release, message }) {
  if (status === 'error') return <Notice tone="danger">GitHub 更新检查失败：{message}</Notice>;
  if (!release || !['current', 'available'].includes(status)) return null;

  const releaseLink = <a className="settings-update__link" href={release.htmlUrl} target="_blank" rel="noreferrer">查看 GitHub 发布页</a>;
  if (status === 'available') {
    return <Notice tone="success"><div className="settings-update"><div><strong>发现新版本 {release.name}</strong><p>当前版本 {APP_VERSION}，可从 GitHub 下载 Windows 安装包。</p></div><div className="settings-update__actions">{release.installer ? <a className="btn btn--primary" href={release.downloadUrl} target="_blank" rel="noreferrer">下载 Windows 安装包</a> : null}{releaseLink}</div></div></Notice>;
  }

  return <Notice tone="success"><div className="settings-update"><div><strong>当前版本 {APP_VERSION} 已是最新</strong><p>已从 GitHub Releases 检查到 {release.name}。</p></div><div className="settings-update__actions">{releaseLink}</div></div></Notice>;
}

function Section({ title, children }) { return <section className="settings-section"><h3>{title}</h3><div className="settings-section__body">{children}</div></section>; }
function Row({ title, description, children }) { return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-row__control">{children}</div></div>; }
function Toggle({ checked, onChange }) { return <button type="button" className={`settings-toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={checked ? '已启用' : '已停用'} onClick={() => onChange(!checked)}><span aria-hidden="true" /></button>; }
function Notice({ children, tone = 'neutral' }) { return <div className={'settings-notice settings-notice--' + tone}>{children}</div>; }
function NavIcon({ name }) { const paths = { info: 'M12 17v-5m0-4h.01M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0', sun: 'M12 3v2m0 14v2M3 12h2m14 0h2m-3.4-6.6-1.4 1.4M7.8 16.2l-1.4 1.4m0-11.4 1.4 1.4m8.4 8.4 1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', layout: 'M4 5h16v14H4zM4 10h16M10 10v9', edit: 'M4 20h4L19 9l-4-4L4 16v4z', link: 'M10 13a5 5 0 0 0 7.1.1l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5.4M14 11a5 5 0 0 0-7.1-.1l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8', command: 'M6 4v16M18 4v16M4 6h16M4 18h16', home: 'M3 11l9-7 9 7v9H3z', refresh: 'M20 11a8 8 0 1 0 2 5m0-5v-5m0 5h-5' }; return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] ?? paths.info} /></svg>; }
function ThemeImportPanel({ theme, onChange }) {
  const [error, setError] = useState(''); const [inputKey, setInputKey] = useState(0);
  const handleImport = async (event) => { const file = event.target.files?.[0]; if (!file) return; setError(''); try { onChange(await importThemeFile(file)); } catch (importError) { setError(importError?.message ?? '主题导入失败'); } finally { setInputKey((value) => value + 1); } };
  const reset = () => { clearImportedTheme(); onChange(null); };
  return <section className="theme-import" aria-label="导入主题"><div className="theme-import__copy"><span className="settings-kicker">CUSTOM THEME</span><strong>导入主题</strong><p>{theme ? `当前使用：${theme.name}` : '导入 JSON 或 CSS 颜色令牌，立即预览自定义主题。'}</p></div><div className="theme-import__actions"><label className="btn">选择主题文件<input key={inputKey} type="file" accept=".json,.css,application/json,text/css" onChange={handleImport} /></label>{theme ? <button type="button" className="btn" onClick={reset}>恢复默认</button> : null}</div>{error ? <p className="theme-import__error" role="alert">{error}</p> : null}</section>;
}

function BackgroundImagePanel({ image, onChange }) {
  const [error, setError] = useState('');
  const [inputKey, setInputKey] = useState(0);

  const handleSelect = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setInputKey((value) => value + 1);
    setError('');

    if (!ALLOWED_BACKGROUND_TYPES.has(file.type)) {
      setError('请选择 PNG、JPG、WebP、GIF 或 AVIF 图片。');
      return;
    }
    if (file.size > MAX_BACKGROUND_IMAGE_SIZE) {
      setError('图片不能超过 2 MB，请先压缩后再试。');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onChange(reader.result);
      else setError('图片读取失败，请换一张图片重试。');
    };
    reader.onerror = () => setError('图片读取失败，请换一张图片重试。');
    reader.readAsDataURL(file);
  };

  const reset = () => {
    setError('');
    setInputKey((value) => value + 1);
    onChange('');
  };

  return <section className="background-image-panel" aria-label="背景图片设置">
    <div className="background-image-panel__preview">
      {image ? <img src={image} alt="当前背景图片预览" /> : <div className="background-image-panel__empty"><span aria-hidden="true">▧</span><strong>未设置背景</strong><small>使用默认工作区背景</small></div>}
      <span className="background-image-panel__badge">{image ? '已应用' : '默认背景'}</span>
    </div>
    <div className="background-image-panel__content">
      <div>
        <span className="settings-kicker">WORKSPACE BACKDROP</span>
        <strong>背景图片</strong>
        <p>{image ? '图片已应用到工作区，设置会自动保存在本机。' : '为工作区添加一张图片，让画布和笔记拥有更明确的空间感。'}</p>
      </div>
      <div className="background-image-panel__actions">
        <label className="btn btn--primary">选择图片<input key={inputKey} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onChange={handleSelect} /></label>
        {image ? <button type="button" className="btn" onClick={reset}>恢复默认</button> : null}
      </div>
      <small className="background-image-panel__hint">支持 PNG、JPG、WebP、GIF、AVIF，最大 2 MB</small>
      {error ? <p className="background-image-panel__error" role="alert">{error}</p> : null}
    </div>
  </section>;
}
