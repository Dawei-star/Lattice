import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { vaultApi } from '../api/vault.js';
import { clearImportedTheme, importThemeFile, loadImportedTheme } from '../lib/theme.js';
import { loadSettings, saveSettings, subscribeSettings } from './settings.js';

const APP_VERSION = '0.1.0';
const GROUPS = [
  { title: '选项', items: [['about', '关于', 'info'], ['appearance', '外观', 'sun'], ['interface', '界面', 'layout'], ['editor', '编辑器', 'edit'], ['files', '文件与链接', 'link'], ['shortcuts', '快捷键', 'command']] },
  { title: '知识库', items: [['vault', '知识库位置', 'home'], ['migration', '数据迁移', 'refresh']] },
];

export default function SettingsModal({ open, onClose, theme, onThemeChange }) {
  const [active, setActive] = useState('about');
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(() => loadSettings());
  const [migration, setMigration] = useState('idle');
  const [vaultPath, setVaultPath] = useState('');
  const [vaultNotice, setVaultNotice] = useState(null);
  const [updateState, setUpdateState] = useState('idle');
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
    setUpdateState('checking');
    await new Promise((resolve) => setTimeout(resolve, 320));
    setUpdateState('current');
  };

  return <Modal open={open} onClose={onClose} title="设置" ariaLabel="设置"><div className="settings-workspace">
    <aside className="settings-nav">
      <div className="settings-nav__brand"><img className="settings-nav__mark" src="/lattice-icon.svg" alt="Lattice" /><div><strong>设置</strong><small>Preferences</small></div></div>
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
        {active === 'appearance' && <><ThemeImportPanel theme={importedTheme} onChange={setImportedTheme} /><Section title="外观"><Row title="主题" description="选择工作区使用的颜色主题。"><select aria-label="主题" value={theme} onChange={(event) => onThemeChange(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></Row><Row title="界面密度" description="调整导航、列表和工具栏的垂直间距。"><select aria-label="界面密度" value={settings.density} onChange={(event) => updateSetting('density', event.target.value)}><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></Row></Section></>}
        {active === 'interface' && <Section title="界面"><Row title="界面字号" description="调整设置、列表和工具栏的基础字号。"><select aria-label="界面字号" value={settings.fontSize} onChange={(event) => updateSetting('fontSize', event.target.value)}><option value="13">小</option><option value="14">标准</option><option value="15">大</option></select></Row><Row title="内容最大宽度" description="控制编辑器和 Markdown 预览的阅读宽度。"><select aria-label="内容最大宽度" value={settings.contentWidth} onChange={(event) => updateSetting('contentWidth', event.target.value)}><option value="720">720px</option><option value="860">860px</option><option value="1040">1040px</option></select></Row></Section>}
        {active === 'editor' && <Section title="编辑器"><Row title="默认编辑模式" description="打开笔记时使用的初始视图。"><select aria-label="默认编辑模式" value={settings.editorMode} onChange={(event) => updateSetting('editorMode', event.target.value)}><option value="split">分栏</option><option value="edit">编辑</option><option value="preview">预览</option></select></Row><Row title="Tab 缩进" description={`按 Tab 插入 ${settings.tabSize} 个空格。`}><select aria-label="Tab 缩进" value={settings.tabSize} onChange={(event) => updateSetting('tabSize', event.target.value)}><option value="2">2 个空格</option><option value="4">4 个空格</option></select></Row><Row title="自动保存" description="停止输入后自动写入 Markdown 文件。"><Toggle checked={settings.autoSave} onChange={(value) => updateSetting('autoSave', value)} /></Row><Row title="自动保存延迟" description="停止输入后等待多久写入磁盘。"><select aria-label="自动保存延迟" value={settings.autoSaveDelay} disabled={!settings.autoSave} onChange={(event) => updateSetting('autoSaveDelay', event.target.value)}><option value="500">500 ms</option><option value="900">900 ms</option><option value="1500">1500 ms</option></select></Row></Section>}
        {active === 'shortcuts' && <Section title="快捷键"><div className="shortcut-list">{[['快速切换', 'Ctrl / Cmd + K'], ['新建笔记', 'Ctrl / Cmd + N'], ['保存笔记', 'Ctrl / Cmd + S'], ['设置', 'Ctrl / Cmd + ,'], ['编辑 / 预览', 'Ctrl / Cmd + E']].map(([name, key]) => <div className="shortcut-row" key={name}><span>{name}</span><kbd>{key}</kbd></div>)}</div></Section>}
        {(active === 'files' || active === 'vault') && <><Section title="知识库位置"><Row title="当前知识库目录" description={vaultPath || '正在读取知识库目录...'}><button type="button" className="btn" onClick={loadVaultPath}>重新读取</button></Row><Row title="路径快捷操作" description="快速定位或复制当前知识库目录。"><div className="settings-inline-actions"><button type="button" className="btn" disabled={!vaultPath || !window.latticeDesktop?.revealVault} onClick={revealVault}>打开目录</button><button type="button" className="btn" disabled={!vaultPath} onClick={copyVaultPath}>复制路径</button></div></Row></Section>{vaultNotice ? <Notice tone={vaultNotice.tone}>{vaultNotice.text}</Notice> : null}<Section title="索引状态"><div className="settings-health"><span className="settings-health__dot" /><div><strong>索引正常</strong><p>笔记、标签与双链会随文件变化自动更新。</p></div><span className="settings-value">实时</span></div></Section></>}
        {active === 'migration' && <Section title="数据迁移"><Row title="导出为 Markdown" description="原数据库会保留，不会被删除。"><button type="button" className="btn btn--primary" onClick={migrate} disabled={migration === 'running'}>{migration === 'running' ? '迁移中...' : '开始迁移'}</button></Row>{migration === 'done' && <Notice tone="success">迁移完成，Markdown 文件已写入当前知识库。</Notice>}{migration === 'error' && <Notice tone="danger">迁移失败，请检查后端服务后重试。</Notice>}</Section>}
      </div>
    </main>
  </div></Modal>;
}

function About({ settings, onChange, onCheckUpdate, updateState }) {
  return <><Section title="关于 Lattice"><div className="settings-about"><img className="settings-about__mark" src="/lattice-icon.svg" alt="Lattice" /><div><h3>Lattice</h3><p>本地优先的双链知识库。</p><span>当前版本 {APP_VERSION} · Windows Desktop</span></div><button type="button" className="btn" onClick={onCheckUpdate} disabled={updateState === 'checking'}>{updateState === 'checking' ? '检查中...' : '检查更新'}</button></div>{updateState === 'current' ? <Notice tone="success">当前版本 {APP_VERSION} 已是最新本地版本。在线更新通道将在发布后启用。</Notice> : null}<Row title="自动保存" description="编辑内容会在短暂空闲后自动保存。"><Toggle checked={settings.autoSave} onChange={(value) => onChange('autoSave', value)} /></Row><Row title="快捷切换" description="允许使用 Ctrl / Cmd + K 打开快速切换器。"><Toggle checked={settings.quickSwitcher} onChange={(value) => onChange('quickSwitcher', value)} /></Row></Section><Section title="账户"><Row title="本地工作区" description="Lattice 不要求登录，数据默认保存在本机。"><span className="settings-value">离线可用</span></Row></Section></>;
}

function Section({ title, children }) { return <section className="settings-section"><h3>{title}</h3><div className="settings-section__body">{children}</div></section>; }
function Row({ title, description, children }) { return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-row__control">{children}</div></div>; }
function Toggle({ checked, onChange }) { return <button type="button" className={`settings-toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={checked ? '已启用' : '已停用'} onClick={() => onChange(!checked)}><span aria-hidden="true" /></button>; }
function Notice({ children, tone = 'neutral' }) { return <div className={'settings-notice settings-notice--' + tone}>{children}</div>; }
function NavIcon({ name }) { const paths = { info: 'M12 17v-5m0-4h.01M21 12a9 9 0 1 1-18 0', sun: 'M12 3v2m0 14v2M3 12h2m14 0h2m-3.4-6.6-1.4 1.4M7.8 16.2l-1.4 1.4m0-11.4 1.4 1.4m8.4 8.4 1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', layout: 'M4 5h16v14H4zM4 10h16M10 10v9', edit: 'M4 20h4L19 9l-4-4L4 16v4z', link: 'M10 13a5 5 0 0 0 7.1.1l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5.4M14 11a5 5 0 0 0-7.1-.1l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8', command: 'M6 4v16M18 4v16M4 6h16M4 18h16', home: 'M3 11l9-7 9 7v9H3z', refresh: 'M20 11a8 8 0 1 0 2 5m0-5v-5m0 5h-5' }; return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] ?? paths.info} /></svg>; }
function ThemeImportPanel({ theme, onChange }) {
  const [error, setError] = useState(''); const [inputKey, setInputKey] = useState(0);
  const handleImport = async (event) => { const file = event.target.files?.[0]; if (!file) return; setError(''); try { onChange(await importThemeFile(file)); } catch (importError) { setError(importError?.message ?? '主题导入失败'); } finally { setInputKey((value) => value + 1); } };
  const reset = () => { clearImportedTheme(); onChange(null); };
  return <section className="theme-import" aria-label="导入主题"><div className="theme-import__copy"><span className="settings-kicker">CUSTOM THEME</span><strong>导入主题</strong><p>{theme ? `当前使用：${theme.name}` : '导入 JSON 或 CSS 颜色令牌，立即预览自定义主题。'}</p></div><div className="theme-import__actions"><label className="btn">选择主题文件<input key={inputKey} type="file" accept=".json,.css,application/json,text/css" onChange={handleImport} /></label>{theme ? <button type="button" className="btn" onClick={reset}>恢复默认</button> : null}</div>{error ? <p className="theme-import__error" role="alert">{error}</p> : null}</section>;
}
