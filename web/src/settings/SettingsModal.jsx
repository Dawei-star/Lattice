import { useEffect, useMemo, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { vaultApi } from '../api/vault.js';
import { clearImportedTheme, importThemeFile, loadImportedTheme } from '../lib/theme.js';

const STORAGE_KEY = 'lattice-settings-v1';
const GROUPS = [
  { title: '选项', items: [['about', '关于', '◎'], ['appearance', '外观', '◌'], ['interface', '界面', '□'], ['editor', '编辑器', '／'], ['files', '文件与链接', '⌁'], ['shortcuts', '快捷键', '⌘']] },
  { title: '知识库', items: [['vault', '知识库位置', '⌂'], ['migration', '数据迁移', '⇄'], ['backup', '备份与恢复', '◫']] },
];

export default function SettingsModal({ open, onClose, theme, onThemeChange }) {
  const [active, setActive] = useState('about');
  const [search, setSearch] = useState('');
  const [fontSize, setFontSize] = useState('14');
  const [contentWidth, setContentWidth] = useState('860');
  const [migration, setMigration] = useState('idle');
  const [vaultPath, setVaultPath] = useState('');
  const [importedTheme, setImportedTheme] = useState(() => loadImportedTheme());

  useEffect(() => {
    if (!open) return;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      const nextFontSize = saved.fontSize ?? '14';
      const nextContentWidth = saved.contentWidth ?? '860';
      setFontSize(nextFontSize);
      setContentWidth(nextContentWidth);
      document.documentElement.style.setProperty('--content-font-size', `${nextFontSize}px`);
      document.documentElement.style.setProperty('--content-max-width', `${nextContentWidth}px`);
    } catch {}
  }, [open]);

  useEffect(() => {
    if (open && window.latticeDesktop?.getVaultInfo) window.latticeDesktop.getVaultInfo().then((info) => setVaultPath(info?.path ?? ''));
  }, [open]);

  const save = (key, value) => {
    try {
      const current = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, [key]: value }));
    } catch {}
  };
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => !q || item[1].toLowerCase().includes(q)) })).filter((group) => group.items.length);
  }, [search]);
  const label = GROUPS.flatMap((group) => group.items).find((item) => item[0] === active)?.[1] ?? '设置';

  const migrate = async () => {
    if (!window.confirm('将当前 SQLite 笔记导出为 Markdown 文件？原数据库不会被删除。')) return;
    setMigration('running');
    try { await vaultApi.migrate(); setMigration('done'); } catch { setMigration('error'); }
  };

  return <Modal open={open} onClose={onClose} title="设置" ariaLabel="设置">
    <div className="settings-workspace">
      <aside className="settings-nav">
        <div className="settings-nav__brand"><span className="settings-nav__mark">L</span><strong>设置</strong></div>
        <label className="settings-search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索设置..." aria-label="搜索设置" /></label>
        <nav aria-label="设置分类">{groups.map((group) => <div className="settings-nav__group" key={group.title}>
          <div className="settings-nav__group-title">{group.title}</div>
          {group.items.map(([id, text, icon]) => <button type="button" key={id} className={'settings-nav__item ' + (active === id ? 'is-active' : '')} onClick={() => setActive(id)}><span className="settings-nav__icon">{icon}</span>{text}</button>)}
        </div>)}</nav>
        <button type="button" className="settings-nav__close" onClick={onClose}>关闭设置</button>
      </aside>
      <main className="settings-content">
        <header className="settings-content__head"><div><span className="settings-content__eyebrow">LATTICE / PREFERENCES</span><h2>{label}</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭设置">×</button></header>
        <div className="settings-content__body">
          {active === 'appearance' ? <ThemeImportPanel theme={importedTheme} onChange={setImportedTheme} /> : null}
          {active === 'about' && <About />}
          {active === 'appearance' && <Section title="外观"><Row title="主题" description="选择工作区使用的颜色主题。"><select value={theme} onChange={(event) => { onThemeChange(event.target.value); save('theme', event.target.value); }}><option value="light">浅色</option><option value="dark">深色</option></select></Row><Row title="界面密度" description="控制导航、列表和工具栏的垂直间距。"><select defaultValue="compact"><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></Row></Section>}
          {active === 'interface' && <Section title="界面"><Row title="界面字号" description="调整设置、列表和工具栏的基础字号。"><select value={fontSize} onChange={(event) => { setFontSize(event.target.value); save('fontSize', event.target.value); }}><option value="13">小</option><option value="14">标准</option><option value="15">大</option></select></Row><Row title="内容最大宽度" description="控制编辑器和 Markdown 预览的阅读宽度。"><select value={contentWidth} onChange={(event) => { setContentWidth(event.target.value); save('contentWidth', event.target.value); }}><option value="720">720px</option><option value="860">860px</option><option value="1040">1040px</option></select></Row></Section>}
          {active === 'editor' && <Section title="编辑器"><Row title="默认编辑模式" description="打开笔记时使用的初始视图。"><select defaultValue="split"><option value="split">分栏</option><option value="edit">编辑</option><option value="preview">预览</option></select></Row><Row title="Tab 缩进" description="按 Tab 插入两个空格。"><Toggle /></Row><Row title="自动保存延迟" description="停止输入后等待多久写入磁盘。"><select defaultValue="900"><option>500 ms</option><option>900 ms</option><option>1500 ms</option></select></Row></Section>}
          {active === 'shortcuts' && <Section title="快捷键"><div className="shortcut-list">{[['快速切换', 'Ctrl / Cmd + K'], ['新建笔记', 'Ctrl / Cmd + N'], ['保存笔记', 'Ctrl / Cmd + S'], ['设置', 'Ctrl / Cmd + ,'], ['编辑 / 预览', 'Ctrl / Cmd + E']].map(([name, key]) => <div className="shortcut-row" key={name}><span>{name}</span><kbd>{key}</kbd></div>)}</div></Section>}
          {(active === 'files' || active === 'vault') && <Section title="知识库位置"><Row title="当前知识库目录" description={vaultPath || '使用应用默认目录。'}>{window.latticeDesktop?.selectVault ? <button type="button" className="btn" onClick={async () => { const result = await window.latticeDesktop.selectVault(); if (!result?.canceled) setVaultPath(result.path); }}>更换目录</button> : <span className="settings-value">本地默认</span>}</Row></Section>}
          {active === 'migration' && <Section title="数据迁移"><Row title="导出为 Markdown" description="原数据库会保留。"><button type="button" className="btn btn--primary" onClick={migrate} disabled={migration === 'running'}>{migration === 'running' ? '迁移中...' : '开始迁移'}</button></Row>{migration === 'done' && <Notice tone="success">迁移完成。</Notice>}{migration === 'error' && <Notice tone="danger">迁移失败，请重试。</Notice>}</Section>}
          {active === 'backup' && <Section title="备份与恢复"><Notice>备份功能将在 Markdown 知识库导入完成后开放。</Notice></Section>}
        </div>
      </main>
    </div>
  </Modal>;
}

function About() { return <><Section title="关于 Lattice"><div className="settings-about"><div className="settings-about__mark">L</div><div><h3>Lattice</h3><p>本地优先的双链知识库。</p><span>当前版本 0.1.0 · Windows Desktop</span></div><button type="button" className="btn">检查更新</button></div><Row title="自动保存" description="编辑内容会在短暂空闲后自动保存。"><Toggle /></Row><Row title="快捷切换" description="使用 Ctrl / Cmd + K 快速打开笔记。"><Toggle /></Row></Section><Section title="账户"><Row title="本地工作区" description="Lattice 不要求登录，数据默认保存在本机。"><span className="settings-value">离线可用</span></Row></Section></>; }
function Section({ title, children }) { return <section className="settings-section"><h3>{title}</h3><div className="settings-section__body">{children}</div></section>; }
function Row({ title, description, children }) { return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-row__control">{children}</div></div>; }
function Toggle() {
  const [enabled, setEnabled] = useState(true);
  return (
    <button
      type="button"
      className={`settings-toggle ${enabled ? 'is-on' : ''}`}
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? '已启用' : '已停用'}
      onClick={() => setEnabled((current) => !current)}
    >
      <span aria-hidden="true" />
    </button>
  );
}
function Notice({ children, tone = 'neutral' }) { return <div className={'settings-notice settings-notice--' + tone}>{children}</div>; }

function ThemeImportPanel({ theme, onChange }) {
  const [error, setError] = useState('');
  const [inputKey, setInputKey] = useState(0);

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const next = await importThemeFile(file);
      onChange(next);
    } catch (importError) {
      setError(importError?.message ?? '主题导入失败');
    } finally {
      setInputKey((value) => value + 1);
    }
  };

  const reset = () => {
    clearImportedTheme();
    onChange(null);
  };

  return (
    <section className="theme-import" aria-label="导入主题">
      <div className="theme-import__copy">
        <strong>导入主题</strong>
        <p>{theme ? `当前使用：${theme.name}` : '导入 JSON 或 CSS 颜色令牌，立即预览玻璃蓝等主题。'}</p>
      </div>
      <div className="theme-import__actions">
        <label className="btn">
          选择主题文件
          <input key={inputKey} type="file" accept=".json,.css,application/json,text/css" onChange={handleImport} />
        </label>
        {theme ? <button type="button" className="btn" onClick={reset}>恢复默认</button> : null}
      </div>
      {error ? <p className="theme-import__error" role="alert">{error}</p> : null}
    </section>
  );
}
