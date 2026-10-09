import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { mcpApi } from '../api/mcp.js';
import { notesApi } from '../api/resources.js';
import { vaultApi } from '../api/vault.js';
import { resolveAttachmentPath, vaultFiles } from '../api/vault-files.js';
import { buildStaticSite } from '../lib/static-export.js';
import { downloadStaticSite, serializeStaticSiteFiles, writeStaticSiteToDirectory } from '../lib/static-site.js';
import { clearImportedTheme, importThemeFile, loadImportedTheme } from '../lib/theme.js';
import { loadSettings, saveSettings, subscribeSettings } from './settings.js';
import { createAiProvider, getActiveAiProvider, loadAiSettings, saveAiSettings, subscribeAiSettings } from './aiSettings.js';
import { MCP_WRITE_TOOL_NAMES, createMcpServer, loadMcpSettings, readEnvValue, resolveServerArgs, saveMcpSettings, setArgValue, serversToProjectDocument, withVisibleServers, writeEnvValue } from './mcpSettings.js';
import {
  MCP_MARKET_CATALOG,
  MCP_MARKET_CATEGORIES,
  MCP_MARKET_RUNTIME_HINT,
  appendMarketServer,
  createServerFromMarketEntry,
  isMarketEntryInstalled,
} from './mcpMarketplace.js';
import ModelCenter from './ModelCenter.jsx';
import { checkGithubReleases } from '../lib/update.js';
import { APP_VERSION } from '../lib/appVersion.js';

const LATTICE_ICON_URL = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAyNCIgaGVpZ2h0PSIxMDI0IiB2aWV3Qm94PSIwIDAgMTAyNCAxMDI0IiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHg9IjEwNCIgeT0iMTQ3IiB3aWR0aD0iODE1IiBoZWlnaHQ9IjgxNSIgcng9IjE1NSIgZmlsbD0iIzA0MEE0NiIvPjxyZWN0IHg9IjEwNCIgeT0iMTA0IiB3aWR0aD0iODE1IiBoZWlnaHQ9IjgxNSIgcng9IjE1NSIgZmlsbD0iIzE2MjU4NSIvPjxyZWN0IHg9IjEwMCIgeT0iMTQyIiB3aWR0aD0iNjk0IiBoZWlnaHQ9IjY5NCIgcng9IjEyNSIgZmlsbD0iIzFGMkVBMiIvPjxyZWN0IHg9IjEwMCIgeT0iMTAwIiB3aWR0aD0iNjk0IiBoZWlnaHQ9IjY5NCIgcng9IjEyNSIgZmlsbD0iIzNCNTBERiIvPjxyZWN0IHg9Ijk2IiB5PSIxMzgiIHdpZHRoPSI1NzIiIGhlaWdodD0iNTcyIiByeD0iOTYiIGZpbGw9IiM0QzY4RUIiLz48cmVjdCB4PSI5NiIgeT0iOTYiIHdpZHRoPSI1NzIiIGhlaWdodD0iNTcyIiByeD0iOTYiIGZpbGw9IiM3Qjk2RkYiLz48cmVjdCB4PSI5MiIgeT0iMTM0IiB3aWR0aD0iNDUxIiBoZWlnaHQ9IjQ1MSIgcng9IjY2IiBmaWxsPSIjOTBBOUZGIi8+PHJlY3QgeD0iOTIiIHk9IjkyIiB3aWR0aD0iNDUxIiBoZWlnaHQ9IjQ1MSIgcng9IjY2IiBmaWxsPSIjQzZENkZGIi8+PC9zdmc+';
const MAX_BACKGROUND_IMAGE_SIZE = 2 * 1024 * 1024;
const ALLOWED_BACKGROUND_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const DEFAULT_VAULT_PROFILE = Object.freeze({
  version: 1,
  paths: Object.freeze({ inbox: 'Inbox', daily: 'Daily', journal: 'Journal' }),
});
const VAULT_PROFILE_FIELDS = [
  ['inbox', 'Inbox', '新建收集内容的默认目录'],
  ['daily', 'Daily', '按日期创建日记的目录'],
  ['journal', 'Journal', '每日摘要和日志的目录'],
];
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 10 }, (_, index) => `COM${index}`),
  ...Array.from({ length: 10 }, (_, index) => `LPT${index}`),
]);
const GROUPS = [
  { title: 'AI 助手', items: [['models', '模型', 'layout']] },
  { title: '选项', items: [['about', '关于', 'info'], ['appearance', '外观', 'sun'], ['interface', '界面', 'layout'], ['editor', '编辑器', 'edit'], ['shortcuts', '快捷键', 'command']] },
  { title: '知识库', items: [['vault', '知识库位置', 'home'], ['migration', '备份与迁移', 'refresh']] },
  { title: '集成', items: [['mcp', 'MCP Server', 'link']] },
];

export default function SettingsModal({ open, initialSection = 'about', onClose, theme, onThemeChange, onVaultProfileSaved, onConfirmFileOperation }) {
  const [active, setActive] = useState(initialSection);
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(() => loadSettings());
  const [migration, setMigration] = useState('idle');
  const [backup, setBackup] = useState('idle');
  const [backupResult, setBackupResult] = useState(null);
  const [staticExport, setStaticExport] = useState('idle');
  const [staticExportResult, setStaticExportResult] = useState(null);
  const [vaultPath, setVaultPath] = useState('');
  const [vaultNotice, setVaultNotice] = useState(null);
  const [vaultProfile, setVaultProfile] = useState(DEFAULT_VAULT_PROFILE);
  const [vaultProfileStatus, setVaultProfileStatus] = useState('default');
  const [vaultProfileWarning, setVaultProfileWarning] = useState(null);
  const [vaultProfileSaveState, setVaultProfileSaveState] = useState('idle');
  const [vaultProfileErrors, setVaultProfileErrors] = useState({});
  const [vaultProfileError, setVaultProfileError] = useState('');
  const [updateState, setUpdateState] = useState('idle');
  const updateRequestRef = useRef(0);
  const [importedTheme, setImportedTheme] = useState(() => loadImportedTheme());
  const searchRef = useRef(null);

  useEffect(() => subscribeSettings(setSettings), []);

  useEffect(() => {
    if (!open) return undefined;
    setActive(initialSection);
    setSettings(loadSettings());
    setSearch('');
    setMigration('idle');
    setBackup('idle');
    setBackupResult(null);
    setStaticExport('idle');
    setStaticExportResult(null);
    setVaultNotice(null);
    setVaultProfile(DEFAULT_VAULT_PROFILE);
    setVaultProfileStatus('default');
    setVaultProfileWarning(null);
    setVaultProfileSaveState('idle');
    setVaultProfileErrors({});
    setVaultProfileError('');
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
  }, [initialSection, open]);

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
    let desktopInfo;
    try {
      desktopInfo = await window.latticeDesktop?.getVaultInfo?.();
    } catch {
      desktopInfo = null;
    }
    try {
      const info = desktopInfo?.profile ? desktopInfo : await vaultApi.info();
      setVaultPath(info?.path ?? info?.vaultDir ?? desktopInfo?.path ?? '');
      if (info?.profile) {
        setVaultProfile(normalizeVaultProfile(info.profile));
        setVaultProfileStatus(info.profileStatus ?? 'loaded');
        setVaultProfileWarning(info.profileWarning ?? null);
      }
    } catch {
      setVaultPath(desktopInfo?.path ?? '');
    }
  }

  const updateVaultProfilePath = (key, value) => {
    setVaultProfile((current) => ({ ...current, paths: { ...current.paths, [key]: value } }));
    setVaultProfileErrors((current) => ({ ...current, [key]: undefined }));
    setVaultProfileError('');
    setVaultProfileSaveState('idle');
  };

  const saveVaultProfile = async () => {
    const validation = validateVaultProfilePaths(vaultProfile.paths);
    if (Object.keys(validation.errors).length) {
      setVaultProfileErrors(validation.errors);
      setVaultProfileSaveState('error');
      setVaultProfileError('请先修正目录路径后再保存。');
      return;
    }

    setVaultProfileSaveState('saving');
    setVaultProfileErrors({});
    setVaultProfileError('');
    try {
      const confirmation = await onConfirmFileOperation?.({
        vaultDir: vaultPath,
        type: 'update',
        path: '.lattice/profile.json',
        contentSummary: '更新知识库目录配置 profile.json',
        impact: '修改 1 个知识库配置文件，影响 Inbox、Daily、Journal 默认路径',
      });
      if (!confirmation?.confirmed) {
        setVaultProfileSaveState('idle');
        return;
      }
      const info = await vaultApi.updateProfile({ version: 1, paths: validation.paths, ...confirmation });
      setVaultProfile(normalizeVaultProfile(info?.profile ?? { version: 1, paths: validation.paths }));
      setVaultProfileStatus(info?.profileStatus ?? 'loaded');
      setVaultProfileWarning(info?.profileWarning ?? null);
      setVaultProfileSaveState('saved');
      await onVaultProfileSaved?.();
    } catch (error) {
      const fieldErrors = error?.fieldErrors ?? {};
      setVaultProfileErrors(Object.fromEntries(VAULT_PROFILE_FIELDS.map(([key]) => [
        key,
        fieldErrors[`paths.${key}`] ?? fieldErrors[key],
      ]).filter(([, message]) => message)));
      setVaultProfileError(error?.message ?? '保存 Vault profile 失败，请稍后重试。');
      setVaultProfileSaveState('error');
    }
  };

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
    const confirmation = await onConfirmFileOperation?.({
      type: 'create',
      path: 'migrate/',
      contentSummary: '将旧版 SQLite 笔记导出为 Markdown 文件',
      impact: '可能新增或覆盖多篇 Markdown 笔记；原数据库保留',
    });
    if (!confirmation?.confirmed) return;
    setMigration('running');
    try {
      await vaultApi.migrate(confirmation);
      setMigration('done');
    } catch {
      setMigration('error');
    }
  };

  const backupVault = async () => {
    if (!window.latticeDesktop?.backupVault) {
      setBackup('unavailable');
      return;
    }
    const confirmation = await onConfirmFileOperation?.({
      type: 'copy',
      path: 'Vault',
      targetPath: 'backup/',
      contentSummary: '复制 Markdown、Canvas、附件、模板和历史快照（不含 AI API Key）',
      impact: '批量复制整个知识库的可备份内容',
    });
    if (!confirmation?.confirmed) return;
    setBackup('running');
    setBackupResult(null);
    try {
      const result = await window.latticeDesktop.backupVault(confirmation);
      if (result?.canceled) {
        setBackup('idle');
        return;
      }
      setBackupResult(result);
      setBackup('done');
    } catch {
      setBackup('error');
    }
  };

  const exportStaticSite = async () => {
    if (staticExport === 'running') return;
    const confirmation = await onConfirmFileOperation?.({
      type: 'create',
      path: 'static-export/',
      contentSummary: '导出当前可读取的 Markdown 与引用图片为静态站点',
      impact: '批量生成静态站点文件，不包含 AI API Key',
    });
    if (!confirmation?.confirmed) return;

    setStaticExport('running');
    setStaticExportResult(null);
    try {
      const index = await notesApi.index();
      const notes = await mapWithConcurrency(index ?? [], 6, async (entry) => {
        const detail = await notesApi.get(entry.id);
        const localContent = vaultFiles.isAvailable() && detail.filePath
          ? await vaultFiles.readMarkdown(detail.filePath)
          : null;
        return { ...detail, ...entry, content: localContent ?? detail.content ?? '' };
      });
      const site = await buildStaticSite({
        notes,
        resolveAssetUrl: (note, reference) => {
          const attachmentPath = resolveAttachmentPath(note.filePath, reference);
          return attachmentPath ? vaultFiles.attachmentUrl(attachmentPath) : null;
        },
      });

      let mode = 'directory';
      if (window.latticeDesktop?.exportStaticSite) {
        const result = await window.latticeDesktop.exportStaticSite(serializeStaticSiteFiles(site.files), confirmation);
        if (result?.canceled) {
          setStaticExport('idle');
          return;
        }
        setStaticExportResult({ ...site, exportPath: result.exportPath });
      } else if (typeof window.showDirectoryPicker === 'function') {
        const directory = await window.showDirectoryPicker({ mode: 'readwrite' });
        await writeStaticSiteToDirectory(directory, site.files);
        setStaticExportResult(site);
      } else {
        mode = 'downloads';
        await downloadStaticSite(site.files);
        setStaticExportResult(site);
      }
      setStaticExport(mode === 'downloads' ? 'downloaded' : 'done');
    } catch (error) {
      if (error?.name === 'AbortError') {
        setStaticExport('idle');
        return;
      }
      setStaticExport('error');
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
        {active === 'vault' && <><Section title="知识库位置"><div className="settings-vault"><div className="settings-vault__info"><strong>当前知识库目录</strong><code className="settings-vault__path" title={vaultPath ? '点击可全选路径' : undefined}>{vaultPath || '正在读取知识库目录...'}</code><p>笔记以 Markdown 文件保存在该目录，可直接被其他工具读取。</p></div><div className="settings-vault__actions"><button type="button" className="btn" onClick={loadVaultPath}>重新读取</button><button type="button" className="btn" disabled={!vaultPath || !window.latticeDesktop?.revealVault} onClick={revealVault}>打开目录</button><button type="button" className="btn btn--primary" disabled={!vaultPath} onClick={copyVaultPath}>复制路径</button></div></div></Section>{vaultNotice ? <Notice tone={vaultNotice.tone}>{vaultNotice.text}</Notice> : null}<Section title="附件显示"><Row title="显示附件" description="在文件列表和快速切换中显示图片、视频、PDF、Word 文档等非笔记文件，包括知识库任意文件夹中的这类文件。关闭时它们不会出现在 Lattice 中。"><Toggle checked={settings.showAttachments} onChange={(value) => updateSetting('showAttachments', value)} /></Row></Section><Section title="索引状态"><div className="settings-health"><span className="settings-health__dot" aria-hidden="true" /><div className="settings-health__copy"><strong>索引正常</strong><p>笔记、标签与双链会随文件变化自动更新。</p></div><span className="settings-health__badge">实时</span></div></Section></>}
        {active === 'vault' && <VaultProfilePanel profile={vaultProfile} status={vaultProfileStatus} warning={vaultProfileWarning} saveState={vaultProfileSaveState} errors={vaultProfileErrors} error={vaultProfileError} onChange={updateVaultProfilePath} onSave={saveVaultProfile} onReload={loadVaultPath} />}
        {active === 'mcp' && <McpServerSettings />}
        {active === 'migration' && <>
          <Section title="静态发布">
            <Row title="导出静态站点" description="生成 index.html、可导航的笔记页面和 assets 资源目录，可直接部署到静态托管服务。">
              <button type="button" className="btn btn--primary" onClick={exportStaticSite} disabled={staticExport === 'running'}>{staticExport === 'running' ? '导出中...' : '导出静态站点'}</button>
            </Row>
          </Section>
          {staticExport === 'done' && staticExportResult ? <Notice tone="success">静态站点已导出：{staticExportResult.noteCount} 篇笔记，{staticExportResult.assetCount} 个资源，共 {formatBytes(staticExportResult.byteCount)}。{staticExportResult.exportPath ? <><br /><code>{staticExportResult.exportPath}</code></> : null}</Notice> : null}
          {staticExport === 'downloaded' && staticExportResult ? <Notice tone="neutral">静态站点已开始下载，共 {staticExportResult.files.length} 个文件。当前浏览器不支持保持目录层级，建议使用 Chrome / Edge 的目录写入或 Windows 桌面版。</Notice> : null}
          {staticExport === 'unavailable' && <Notice tone="neutral">当前浏览器不支持目录写入，请使用 Chrome / Edge 或 Windows 桌面版导出。</Notice>}
          {staticExport === 'error' && <Notice tone="danger">静态站点导出失败，请确认知识库服务仍在运行、目标目录可写且磁盘空间充足。</Notice>}
          <Section title="数据安全">
            <Row title="备份知识库" description="复制 Markdown、Canvas、附件、模板和历史快照到一个新的备份目录。AI API Key 不会写入备份。">
              <button type="button" className="btn btn--primary" onClick={backupVault} disabled={backup === 'running'}>{backup === 'running' ? '备份中...' : '备份到文件夹'}</button>
            </Row>
          </Section>
          {backup === 'done' && backupResult ? <Notice tone="success">备份完成：已复制 {backupResult.fileCount ?? 0} 个文件，共 {formatBytes(backupResult.byteCount)}。位置：<code>{backupResult.backupPath}</code></Notice> : null}
          {backup === 'error' && <Notice tone="danger">备份失败，请确认目标磁盘可写且空间充足。</Notice>}
          {backup === 'unavailable' && <Notice tone="neutral">浏览器开发版不能直接复制本地文件，请在 Windows 桌面版中执行备份。</Notice>}
          <Section title="旧版迁移">
            <Row title="从 SQLite 导出为 Markdown" description="仅用于旧版数据库迁移，原数据库会保留，不会被删除。"><button type="button" className="btn" onClick={migrate} disabled={migration === 'running'}>{migration === 'running' ? '迁移中...' : '开始迁移'}</button></Row>
            {migration === 'done' && <Notice tone="success">迁移完成，Markdown 文件已写入当前知识库。</Notice>}
            {migration === 'error' && <Notice tone="danger">迁移失败，请检查后端服务后重试。</Notice>}
          </Section>
        </>}
      </div>
    </main>
  </div></Modal>;
}

function normalizeVaultProfile(value) {
  const paths = value?.paths ?? {};
  return {
    version: 1,
    paths: Object.fromEntries(VAULT_PROFILE_FIELDS.map(([key]) => [
      key,
      typeof paths[key] === 'string' && paths[key].trim()
        ? paths[key].trim().replaceAll('\\', '/')
        : DEFAULT_VAULT_PROFILE.paths[key],
    ])),
  };
}

function validateVaultProfilePaths(paths) {
  const errors = {};
  const normalizedPaths = {};
  for (const [key, label] of VAULT_PROFILE_FIELDS) {
    const value = String(paths?.[key] ?? '').trim();
    const normalized = value.replaceAll('\\', '/');
    const parts = normalized.split('/');
    const reserved = parts.some((part) => WINDOWS_RESERVED_DEVICE_NAMES.has(part.split('.')[0].toUpperCase()));
    if (!value) errors[key] = `${label} 目录不能为空。`;
    else if (normalized.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) errors[key] = '必须填写 Vault 内的相对路径。';
    else if (parts.some((part) => !part || part === '.' || part === '..')) errors[key] = '不能包含 .、.. 或空目录段。';
    else if (parts.some((part) => part.startsWith('.') || part === '_templates')) errors[key] = '不能使用隐藏目录或 _templates。';
    else if (parts.some((part) => /[<>:"|?*\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part)) || reserved) errors[key] = '目录名包含不支持的字符。';
    else normalizedPaths[key] = normalized;
  }
  return { errors, paths: normalizedPaths };
}

const DEFAULT_MCP_TOOLS = [
  { name: 'list_notes', description: '列出知识库中的笔记' },
  { name: 'search_notes', description: '全文搜索笔记' },
  { name: 'read_note', description: '按 ID、标题或路径读取笔记内容' },
  { name: 'get_note_links', description: '查看笔记的出链与反向链接' },
  { name: 'list_tags', description: '列出全部标签及使用次数' },
  { name: 'search_by_tag', description: '按标签筛选笔记' },
  { name: 'get_vault_statistics', description: '获取知识库概况与最近更新' },
  { name: 'create_note', description: '创建一篇新笔记' },
  { name: 'update_note', description: '更新笔记正文（支持追加 / 前插 / 替换）' },
  { name: 'list_note_history', description: '列出笔记的历史版本' },
  { name: 'restore_note_version', description: '把笔记恢复到指定历史版本' },
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
  const [marketSearch, setMarketSearch] = useState('');
  const [marketCategory, setMarketCategory] = useState('全部');
  const [expandedMarketKey, setExpandedMarketKey] = useState('');
  const [loadError, setLoadError] = useState(false);
  const editorRef = useRef(null);

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
      LATTICE_MCP_ALLOW_WRITES: serverInfo?.writesEnabled ? 'true' : 'false',
      // 桌面版的 command 是 lattice.exe 本身：不加这个开关，外部客户端拉起 exe
      // 会打开一个新应用窗口而不是跑 MCP Server（开发态 node 运行时不带此标志）
      ...(serverInfo?.electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
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
      setLoadError(false);
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
      setInfo(null);
      setLoadError(true);
      if (!silent) setNotice({ tone: 'danger', text: '无法读取 MCP 配置，请确认后端服务已启动。' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInfo({ silent: true });
  }, []);

  // 打开 / 切换编辑器时把它带进视野（页面很长，否则点了「配置」像没反应）
  useEffect(() => {
    if (editingId && editorRef.current) editorRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [editingId]);

  // 反馈提示自动收起：它是吸附在面板底部的一条信息，长时间压着内容没有意义
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  const toggleServer = (serverId) => {
    // 走 withVisibleServers：info 还没返回时列表展示的是回退出来的内置 Server，
    // 直接 map 空数组会让「开关点了没反应」
    updateSettings((current) => ({
      ...current,
      servers: withVisibleServers(current.servers, managedServers, (servers) => servers
        .map((server) => server.id === serverId ? { ...server, enabled: !server.enabled } : server)),
    }));
  };

  const removeServer = (server) => {
    if (server.builtin) return;
    if (!window.confirm(`从本机配置中移除 MCP Server「${server.name}」？`)) return;
    updateSettings((current) => ({
      ...current,
      servers: withVisibleServers(current.servers, managedServers, (servers) => servers
        .filter((item) => item.id !== server.id)),
    }));
    if (editingId === server.id) closeEditor();
    setNotice({ tone: 'success', text: `已移除 ${server.name}。` });
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
    // 密钥或必需参数还没补齐时强制停用：避免把一份连不上 / 路径是占位符的配置导出给客户端
    const missingEnv = (draft.requiresEnv ?? []).filter((item) => !String(env[item.name] ?? '').trim());
    const missingArgs = (draft.requiresArgs ?? []).filter((item) => !String(server.argValues?.[item.token] ?? '').trim());
    if (missingEnv.length || missingArgs.length) server.enabled = false;
    updateSettings((current) => ({
      ...current,
      servers: withVisibleServers(current.servers, managedServers, (servers) => editingId === 'new'
        ? [...servers, server]
        : servers.map((item) => item.id === editingId ? server : item)),
    }));
    const missingLabels = [...missingArgs.map((item) => item.label), ...missingEnv.map((item) => item.name)];
    setNotice(missingLabels.length
      ? { tone: 'warning', text: `已保存 ${name}，但还缺 ${missingLabels.join('、')}，因此保持停用。` }
      : { tone: 'success', text: 'MCP Server 配置已保存。' });
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

  const copyToClipboard = async (text, successText) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ tone: 'success', text: successText });
    } catch {
      setNotice({ tone: 'danger', text: '复制失败，请手动选择内容。' });
    }
  };

  const copyConfig = () => copyToClipboard(configText, '已复制当前启用的 MCP 配置。');

  const copyWritesEnv = () => copyToClipboard(
    `"${info?.writesEnvVar ?? 'LATTICE_MCP_ALLOW_WRITES'}": "true"`,
    '已复制写入开关片段：粘贴到导出配置里 Lattice Server 的 env 中即可。',
  );

  const installFromMarket = (entry) => {
    const existing = managedServers.find((server) => isMarketEntryInstalled([server], entry));
    if (existing) {
      openEditor(existing);
      setNotice({ tone: 'warning', text: `${entry.name} 已在列表中，已为你打开配置。` });
      return;
    }
    const server = createServerFromMarketEntry(entry, { vaultDir: info?.vaultDir, dbFile: info?.dbFile });
    // settings.servers 为空时列表展示的是回退出来的内置 Lattice Server（尚未落盘），
    // 以“当前可见列表”为基线追加，避免内置条目在下一次保存后消失。
    updateSettings((current) => ({
      ...current,
      servers: appendMarketServer(current.servers, managedServers, server),
    }));
    const missing = [
      ...(server.requiresArgs ?? []).filter((item) => !server.argValues?.[item.token]).map((item) => item.label),
      ...(server.requiresEnv ?? []).map((item) => item.name),
    ];
    if (missing.length) {
      openEditor(server);
      setNotice({ tone: 'warning', text: `${entry.name} 还需要补齐：${missing.join('、')}。填好保存后即可启用。` });
    } else {
      setNotice({ tone: 'success', text: `已添加 ${entry.name}，导出配置即可在 MCP 客户端中使用。` });
    }
  };

  const marketQuery = marketSearch.trim().toLowerCase();
  const marketEntries = MCP_MARKET_CATALOG.filter((entry) => marketCategory === '全部' || entry.category === marketCategory)
    .filter((entry) => !marketQuery || [entry.name, entry.tagline, entry.description, entry.category, entry.key].some((value) => String(value ?? '').toLowerCase().includes(marketQuery)))
    .sort((a, b) => Number(b.featured === true) - Number(a.featured === true));
  const marketInstalledCount = MCP_MARKET_CATALOG.filter((entry) => isMarketEntryInstalled(managedServers, entry)).length;

  const writesEnabled = info?.writesEnabled === true;
  const writesEnvVar = info?.writesEnvVar ?? 'LATTICE_MCP_ALLOW_WRITES';
  // 工具清单以服务端返回为准（逐条带 write / enabled）；还没读到配置时退回内置清单，
  // 并把写入工具标成「未启用」——宁可少说，也不能把不可用的能力说成可用。
  const toolRows = (toolList.length ? toolList : DEFAULT_MCP_TOOLS).map((tool) => {
    const write = tool.write ?? MCP_WRITE_TOOL_NAMES.includes(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      write,
      enabled: tool.enabled ?? (write ? writesEnabled : true),
    };
  });
  const readTools = toolRows.filter((tool) => !tool.write);
  const writeTools = toolRows.filter((tool) => tool.write);
  const enabledToolCount = toolRows.filter((tool) => tool.enabled).length;

  return <div className="mcp-settings mcp-manager">
    <section className="mcp-manager__hero">
      <div><span className="settings-kicker">MCP INTEGRATION</span><h3>MCP 服务器</h3><p>管理当前工作区中可供外部 Agent 使用的 MCP Server。</p></div>
      <div className="mcp-manager__stats"><strong>{managedServers.length}</strong><span>已配置</span><strong>{enabledCount}</strong><span>已启用</span></div>
    </section>
    <div className="mcp-manager__toolbar">
      <div className="mcp-manager__scope"><span className="mcp-manager__scope-tag">用户级配置</span><span>保存在本机浏览器</span></div>
      <label className="mcp-manager__search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 MCP Server..." aria-label="搜索 MCP Server" /></label>
      <div className="mcp-manager__actions"><button type="button" className="icon-btn" onClick={() => loadInfo()} aria-label="刷新 MCP Server" title="刷新"><NavIcon name="refresh" /></button><label className="btn"><span>导入</span><input key={fileInputKey} type="file" accept=".json,application/json" onChange={importConfig} /></label><button type="button" className="btn btn--primary" onClick={openCreator}>+ 新建</button></div>
    </div>
    <section className="mcp-manager__block">
      <div className="mcp-manager__panel mcp-manager__project">
        <div className="mcp-manager__server-icon">MCP</div><div><strong>启用项目级 MCP</strong><p>从知识库根目录的 .lattice/mcp.json 加载 MCP Server，随本库走、可与用户级配置同名覆盖（用户级优先）。</p></div><McpToggle checked={settings.projectEnabled} onChange={(value) => updateSettings((current) => ({ ...current, projectEnabled: value }))} label="启用项目级 MCP" />
      </div>
      {settings.projectEnabled ? <ProjectMcpSection onNotify={setNotice} onConfirmFileOperation={onConfirmFileOperation} vaultDir={vaultPath} /> : null}
    </section>
    <section className="mcp-manager__block">
      <div className="mcp-manager__section-head"><div><h4>已配置的 MCP Servers</h4><p>可启用、编辑或移除；导出的配置在页面底部。</p></div><span className="settings-value">{enabledCount} / {managedServers.length} 已启用</span></div>
      <div className="mcp-manager__panel mcp-manager__list">
        {serverList.length ? serverList.map((server) => {
          // 只在真的还缺东西时标记，配齐后不该继续挂着提示（密钥与必需参数一起算）
          const missingKeys = (server.requiresEnv ?? [])
            .filter((item) => !String(server.env?.[item.name] ?? '').trim());
          const missingArgs = (server.requiresArgs ?? [])
            .filter((item) => !String(server.argValues?.[item.token] ?? '').trim());
          const missingCount = missingKeys.length + missingArgs.length;
          // 来自市场的 Server 直接沿用它在市场里的品牌 logo，列表与市场对得上号
          const marketEntry = MCP_MARKET_CATALOG.find((entry) => isMarketEntryInstalled([server], entry));
          const iconPath = marketEntry?.logo ?? '';
          return <article className={'mcp-server-row ' + (server.enabled ? 'is-enabled' : 'is-disabled')} key={server.id}>
            <McpIconBox logo={iconPath} fallback={server.builtin ? 'L' : 'MCP'} /><div className="mcp-server-row__identity"><div><strong>{server.name}</strong>{server.builtin ? <span className="mcp-server-row__verified">✓</span> : null}{missingCount ? <span className="mcp-server-row__needs-key">缺 {missingCount} 项待填</span> : null}</div><p>{server.description || server.transport.toUpperCase() + ' MCP Server'}</p><code>{server.transport === 'sse' ? server.url : server.command + (server.args[0] ? ' · ' + server.args[0] : '')}</code></div><div className="mcp-server-row__actions"><span className="mcp-server-row__state">{server.enabled ? '已启用' : '已停用'}</span><div className="mcp-server-row__buttons"><button type="button" className="icon-btn" onClick={() => openEditor(server)} aria-label={'配置 ' + server.name} title="配置"><NavIcon name="edit" /></button>{server.builtin ? <span className="mcp-server-row__slot" aria-hidden="true" /> : <button type="button" className="icon-btn icon-btn--danger mcp-server-row__remove" onClick={() => removeServer(server)} aria-label={'移除 ' + server.name} title="移除"><NavIcon name="trash" /></button>}</div><McpToggle checked={server.enabled} onChange={() => toggleServer(server.id)} label={(server.enabled ? '停用 ' : '启用 ') + server.name} /></div>
          </article>;
        }) : <div className="mcp-manager__empty"><strong>没有匹配的 MCP Server</strong><span>尝试修改搜索关键词，或新建一个 Server。</span></div>}
      </div>
    </section>
    {/* 编辑器紧跟「已配置的 MCP Servers」——放在插件市场之后会让点「配置」的人
        以为没反应（编辑器其实在下面一千多像素处） */}
    <div className="mcp-editor-slot" ref={editorRef}>
      {editingId ? <McpServerEditor draft={draft} envText={envText} error={editorError} info={info} onChange={setDraft} onEnvChange={setEnvText} onSave={saveDraft} onClose={closeEditor} /> : null}
    </div>
    <section className="mcp-manager__block" data-testid="mcp-market">
      <div className="mcp-manager__section-head"><div><h4>MCP 插件市场</h4><p>精选适配知识库场景的 MCP Server：文件、联网、记忆与开发辅助，一键写入本机配置。</p></div><span className="settings-value">{MCP_MARKET_CATALOG.length} 款 · 已添加 {marketInstalledCount}</span></div>
      <div className="mcp-manager__panel mcp-market">
        <div className="mcp-market__filters">
          <div className="mcp-market__chips" role="group" aria-label="MCP 市场分类">
            {['全部', ...MCP_MARKET_CATEGORIES].map((category) => <button key={category} type="button" className={'mcp-market__chip' + (marketCategory === category ? ' is-active' : '')} onClick={() => setMarketCategory(category)}>{category}</button>)}
          </div>
          <label className="mcp-manager__search mcp-market__search"><span aria-hidden="true">⌕</span><input value={marketSearch} onChange={(event) => setMarketSearch(event.target.value)} placeholder="搜索市场..." aria-label="搜索 MCP 市场" /></label>
        </div>
        <div className="mcp-market__grid">
          {marketEntries.map((entry) => {
            const installed = isMarketEntryInstalled(managedServers, entry);
            const expanded = expandedMarketKey === entry.key;
            return <article key={entry.key} className={'mcp-market__card' + (installed ? ' is-installed' : '') + (expanded ? ' is-expanded' : '')}>
              <header className="mcp-market__card-head">
                <McpIconBox logo={entry.logo} className="mcp-market__icon" fallback={entry.name.slice(0, 2)} />
                <div className="mcp-market__card-title"><strong>{entry.name}</strong>{entry.featured ? <span className="mcp-market__featured">推荐</span> : null}<span className="mcp-market__runtime">{entry.runtime === 'python' ? 'Python' : 'Node'}</span></div>
              </header>
              <p className="mcp-market__card-desc">{entry.tagline}</p>
              <div className="mcp-market__card-tools">{(entry.tools ?? []).slice(0, 4).map((tool) => <code key={tool.name} title={tool.description}>{tool.name}</code>)}{(entry.tools?.length ?? 0) > 4 ? <span className="mcp-market__more">+{entry.tools.length - 4}</span> : null}</div>
              {expanded ? <div className="mcp-market__detail">
                <p className="mcp-market__detail-text">{entry.description}</p>
                <ul className="mcp-market__detail-list">
                  {(entry.tools ?? []).map((tool) => <li key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></li>)}
                </ul>
                {(entry.requiresEnv ?? []).length ? <ul className="mcp-market__detail-list mcp-market__detail-list--env">
                  {entry.requiresEnv.map((item) => <li key={item.name}><code>{item.name}</code><span>{item.hint}</span></li>)}
                </ul> : null}
                <a className="mcp-market__docs" href={entry.docs} target="_blank" rel="noreferrer">查看官方文档 ↗</a>
              </div> : null}
              <footer className="mcp-market__card-foot">
                <span className="mcp-market__category">{entry.category}{(entry.requiresEnv ?? []).length ? ' · 需密钥' : ''}</span>
                <div className="mcp-market__card-actions">
                  <button type="button" className="btn btn--sm btn--ghost" aria-expanded={expanded} aria-label={(expanded ? '收起 ' : '查看 ') + entry.name + ' 详情'} onClick={() => setExpandedMarketKey(expanded ? '' : entry.key)}>{expanded ? '收起' : '详情'}</button>
                  <button type="button" className={'btn btn--sm' + (installed ? '' : ' btn--primary')} aria-label={(installed ? '配置 ' : '添加 ') + entry.name} onClick={() => installFromMarket(entry)}>{installed ? '配置' : '添加'}</button>
                </div>
              </footer>
            </article>;
          })}
          {!marketEntries.length ? <div className="mcp-manager__empty mcp-market__empty"><strong>没有匹配的 MCP Server</strong><span>换个关键词或分类试试。</span></div> : null}
        </div>
        <p className="mcp-market__hint">{MCP_MARKET_RUNTIME_HINT.node}；{MCP_MARKET_RUNTIME_HINT.python}。带「需密钥」标记的条目添加后会打开配置，请先补齐环境变量再启用。市场条目会随版本更新，也可以直接「导入」任意 MCP 配置 JSON。</p>
      </div>
    </section>
    <section className="mcp-manager__block" data-testid="mcp-tools">
      <div className="mcp-manager__section-head"><div><h4>当前 Server 工具</h4><p>Lattice MCP Server 暴露以下知识库操作；写入工具默认不注册。</p></div><span className="settings-value">{loading ? '读取中...' : info ? `stdio · ${enabledToolCount} / ${toolRows.length} 可用` : '未读取'}</span></div>
      {loadError ? <Notice tone="danger"><span className="settings-notice__row"><span>读取不到 MCP 配置，工具清单可能不是最新的。</span><button type="button" className="btn btn--sm" onClick={() => loadInfo()}>重试</button></span></Notice> : null}
      <div className="mcp-manager__panel mcp-tools">
        <div className="mcp-tools__group">
          <div className="mcp-tools__group-head"><strong>读取工具</strong><span>{readTools.length} 个 · 默认可用</span></div>
          {readTools.map((tool) => <div className={'mcp-tools__row' + (tool.enabled ? '' : ' is-off')} key={tool.name}><code>{tool.name}</code><span className="mcp-tools__desc">{tool.description}</span><span className="mcp-tools__state">{tool.enabled ? '可用' : '未启用'}</span></div>)}
        </div>
        <div className="mcp-tools__group">
          <div className="mcp-tools__group-head"><strong>写入工具</strong><span>{writeTools.length} 个 · {writesEnabled ? '已开启' : `需 ${writesEnvVar}=true`}</span></div>
          {writeTools.map((tool) => <div className={'mcp-tools__row' + (tool.enabled ? '' : ' is-off')} key={tool.name}><code>{tool.name}</code><span className="mcp-tools__desc">{tool.description}</span><span className="mcp-tools__state">{tool.enabled ? '可用' : '未启用'}</span></div>)}
        </div>
      </div>
      <Notice tone={writesEnabled ? 'warning' : 'success'}>
        {writesEnabled
          ? '写入工具已开启：外部 Agent 可以修改 Vault，请确认每次写入。'
          : <span className="settings-notice__row"><span>默认只读：写入工具未注册。导出配置后如需写入，在 Lattice Server 的 env 中加入 <code>{writesEnvVar}: "true"</code>。</span><button type="button" className="btn btn--sm" onClick={copyWritesEnv}>复制片段</button></span>}
      </Notice>
    </section>
    <section className="mcp-manager__block">
      <div className="mcp-manager__section-head"><div><h4>导出配置</h4><p>复制当前启用的 Server，粘贴到 Claude Desktop 或其他 MCP 客户端。</p></div><button type="button" className="btn btn--primary" onClick={copyConfig}>复制 JSON</button></div>
      <div className="mcp-manager__panel mcp-settings__config"><pre aria-label="MCP 配置"><code>{configText}</code></pre></div>
    </section>
    <Notice>浏览器不能直接拉起任意 stdio 进程；列表中的开关管理本机配置，真正连接由 Claude Desktop 等 MCP 客户端完成。</Notice>
    {/* 操作反馈吸附在面板底部：页面很长，无论在哪一段操作都能看到结果 */}
    {notice ? <div className="mcp-notice-dock"><Notice tone={notice.tone}>{notice.text}</Notice></div> : null}
  </div>;
}

const PRESET_LABELS = { vaultDir: '知识库目录', dbFile: '数据库路径' };

/**
 * 项目级 MCP Server 区块（<Vault>/.lattice/mcp.json）。
 * 列表展示 + 逐项启停 + 原始 JSON 编辑；与用户级编辑器刻意分开——
 * 项目配置是随知识库走的文件，保持「手改文件即可生效」的简单语义。
 */
function ProjectMcpSection({ onNotify, onConfirmFileOperation, vaultDir }) {
  const [info, setInfo] = useState(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = (data) => {
    setInfo(data);
    setText(JSON.stringify(serversToProjectDocument(data?.servers ?? []), null, 2));
  };

  const load = async ({ silent = true } = {}) => {
    try {
      apply(await mcpApi.project());
      setError('');
      if (!silent) onNotify({ tone: 'success', text: '项目级 MCP 配置已刷新。' });
    } catch {
      setInfo(null);
      if (!silent) onNotify({ tone: 'danger', text: '读取项目级 MCP 配置失败，请确认后端服务已启动。' });
    }
  };

  useEffect(() => {
    load({ silent: true });
  }, []);

  const save = async (document, successText) => {
    setBusy(true);
    try {
      const confirmation = await onConfirmFileOperation?.({
        vaultDir,
        type: 'update',
        path: '.lattice/mcp.json',
        contentSummary: '更新项目级 MCP Server 配置 JSON',
        impact: '覆盖 1 个项目配置文件，影响后续外部工具连接与 AI 工具清单',
      });
      if (!confirmation?.confirmed) return false;
      const data = await mcpApi.saveProject({ ...document, ...confirmation });
      apply(data);
      setError('');
      onNotify({ tone: 'success', text: `${successText}${data?.warning ? ` ${data.warning}` : ''}` });
      return true;
    } catch (requestError) {
      setError(requestError?.message ?? '保存失败');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleServer = (server) => {
    void save(
      serversToProjectDocument((info?.servers ?? []).map((item) => item.key === server.key ? { ...item, enabled: !item.enabled } : item)),
      `已${server.enabled === false ? '启用' : '停用'}项目级 Server「${server.name}」。`,
    );
  };

  const saveText = () => {
    let document;
    try {
      document = JSON.parse(text || '{}');
    } catch (parseError) {
      setError(`JSON 解析失败：${parseError.message}`);
      return;
    }
    void save(document, '项目级 MCP 配置已保存。').then((saved) => {
      if (saved) setEditing(false);
    });
  };

  const servers = info?.servers ?? [];
  const statusText = !info
    ? '未读取'
    : info.status === 'default'
      ? '文件尚不存在（保存后自动创建）'
      : info.status === 'invalid'
        ? '配置有误'
        : `${servers.length} 个 Server，启用 ${servers.filter((item) => item.enabled).length} 个`;

  return <div className="mcp-manager__panel mcp-project" data-testid="mcp-project">
    <div className="mcp-manager__section-head">
      <div><h4>项目级 MCP Servers</h4><p><code>{info?.path ?? '<知识库>/.lattice/mcp.json'}</code></p></div>
      <div className="mcp-manager__actions">
        <button type="button" className="icon-btn" onClick={() => load({ silent: false })} aria-label="刷新项目级 MCP 配置" title="刷新"><NavIcon name="refresh" /></button>
        <button type="button" className="btn btn--sm" onClick={() => setEditing((value) => !value)}>{editing ? '收起' : '编辑 JSON'}</button>
      </div>
    </div>
    {info?.status === 'invalid' && info.warning ? <Notice tone="danger">{info.warning}</Notice> : null}
    {servers.length ? servers.map((server) => (
      <article className={'mcp-server-row ' + (server.enabled ? 'is-enabled' : 'is-disabled')} key={server.key}>
        <McpIconBox fallback="P" /><div className="mcp-server-row__identity"><div><strong>{server.name}</strong><span className="mcp-server-row__verified">项目级</span></div><p>{server.description || server.transport.toUpperCase() + ' MCP Server'}</p><code>{server.transport === 'sse' ? server.url : server.command + (server.args[0] ? ' · ' + server.args[0] : '')}</code></div><div className="mcp-server-row__actions"><span className="mcp-server-row__state">{server.enabled ? '已启用' : '已停用'}</span><McpToggle checked={server.enabled} onChange={() => toggleServer(server)} disabled={busy} label={(server.enabled ? '停用 ' : '启用 ') + server.name} /></div>
      </article>
    )) : <div className="mcp-manager__empty"><strong>还没有项目级 Server</strong><span>点「编辑 JSON」添加，或直接修改 .lattice/mcp.json 文件。格式与导出配置一致。</span></div>}
    <p className="mcp-market__hint">{statusText}；聊天时项目级与用户级配置合并使用，同名 Server 以用户级为准。</p>
    {editing ? <div className="mcp-editor__form">
      <label>配置 JSON<span className="mcp-editor__hint">{"{\"mcpServers\": { \"<key>\": { command, args, env } }}"}</span><textarea value={text} onChange={(event) => setText(event.target.value)} rows="10" spellCheck="false" /></label>
      {error ? <p className="mcp-editor__error" role="alert">{error}</p> : null}
      <div className="mcp-editor__actions"><button type="button" className="btn" onClick={() => setEditing(false)}>取消</button><button type="button" className="btn btn--primary" disabled={busy} onClick={saveText}>保存到 .lattice/mcp.json</button></div>
    </div> : null}
  </div>;
}

function McpServerEditor({ draft, envText, error, info, onChange, onEnvChange, onSave, onClose }) {
  if (!draft) return null;
  const requiredEnv = Array.isArray(draft.requiresEnv) ? draft.requiresEnv : [];
  const requiredArgs = Array.isArray(draft.requiresArgs) ? draft.requiresArgs : [];
  const argValues = draft.argValues && typeof draft.argValues === 'object' ? draft.argValues : {};
  const envIsObject = (() => {
    try {
      const parsed = JSON.parse(envText || '{}');
      return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  })();
  const allArgsFilled = (values) => requiredArgs.every((item) => String(values[item.token] ?? '').trim());
  const allEnvFilled = (text) => requiredEnv.every((item) => String(readEnvValue(text, item.name)).trim());
  // 市场条目默认停用往往只是因为还缺必填项：补齐最后一项时自动勾上启用，少一步操作
  const fillArg = (token, value) => {
    const nextValues = setArgValue(argValues, token, value);
    const next = { ...draft, argValues: nextValues };
    if (draft.enabled === false && allArgsFilled(nextValues) && allEnvFilled(envText)) next.enabled = true;
    onChange(next);
  };
  const fillEnv = (name, value) => {
    const nextText = writeEnvValue(envText, name, value);
    onEnvChange(nextText);
    if (draft.enabled === false && allArgsFilled(argValues) && allEnvFilled(nextText)) onChange({ ...draft, enabled: true });
  };
  return <section className="mcp-manager__block mcp-editor" data-testid="mcp-editor">
    <div className="mcp-manager__section-head"><div><h4>{draft.builtin ? '配置 Lattice MCP Server' : '配置 MCP Server'}</h4><p>保存后会写入当前浏览器的本地设置。</p></div><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭 MCP 配置">×</button></div>
    <div className="mcp-manager__panel mcp-editor__form">
      <div className="mcp-editor__grid"><label>显示名称<input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label><label>传输方式<select value={draft.transport} onChange={(event) => onChange({ ...draft, transport: event.target.value })}><option value="stdio">stdio</option><option value="sse">SSE</option></select></label></div>
      {draft.transport !== 'sse' ? <p className="mcp-editor__hint">安全提示：stdio 模式由 Lattice 在本机拉起指定命令，等同于授权其执行本机代码——只添加你信任的来源。</p> : null}
      {draft.transport === 'sse' ? <label>Server URL<input value={draft.url || ''} onChange={(event) => onChange({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label> : <><label>启动命令<input value={draft.command} onChange={(event) => onChange({ ...draft, command: event.target.value })} placeholder="node" /></label><label>启动参数<span className="mcp-editor__hint">每行一个参数{requiredArgs.length ? '；{占位符} 由下方参数填充' : ''}</span><textarea value={draft.argsText} onChange={(event) => onChange({ ...draft, argsText: event.target.value })} rows="3" placeholder="D:\\path\\to\\server.mjs" /></label></>}
      {requiredArgs.length ? <div className="mcp-editor__env mcp-editor__args">
        <div className="mcp-editor__env-head"><strong>需要的参数</strong><span>留空的条目保存后会保持停用，不会被导出。</span></div>
        {requiredArgs.map((item) => <label className="mcp-editor__env-field" key={item.token}>
          <code>{item.label}</code>
          <span className="mcp-editor__arg-row">
            <input
              value={argValues[item.token] ?? ''}
              onChange={(event) => fillArg(item.token, event.target.value)}
              placeholder="填写绝对路径"
              aria-label={item.label}
              autoComplete="off"
              spellCheck="false"
            />
            {item.preset && info?.[item.preset]
              ? <button type="button" className="btn btn--sm btn--ghost" onClick={() => fillArg(item.token, info[item.preset])}>填入{PRESET_LABELS[item.preset] ?? '默认值'}</button>
              : null}
          </span>
          {item.hint ? <small>{item.hint}</small> : null}
        </label>)}
      </div> : null}
      {requiredEnv.length ? <div className="mcp-editor__env">
        <div className="mcp-editor__env-head"><strong>需要的密钥</strong><span>留空的条目保存后会保持停用，不会被导出。</span></div>
        {requiredEnv.map((item) => <label className="mcp-editor__env-field" key={item.name}>
          <code>{item.name}</code>
          <input
            value={readEnvValue(envText, item.name)}
            onChange={(event) => fillEnv(item.name, event.target.value)}
            placeholder={item.hint || '粘贴密钥'}
            aria-label={item.name}
            autoComplete="off"
            spellCheck="false"
          />
          {item.hint ? <small>{item.hint}</small> : null}
        </label>)}
        {envIsObject ? null : <p className="mcp-editor__error" role="alert">下方的环境变量 JSON 目前不是合法对象，请先修复它。</p>}
      </div> : null}
      <label className="mcp-editor__enable"><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} /><span>启用这个 Server</span>{requiredEnv.length || requiredArgs.length ? <small>必填项未补齐时会自动保持停用</small> : null}</label>
      <label>环境变量 JSON<span className="mcp-editor__hint">{requiredEnv.length ? '与上方密钥同步；其余变量在此添加' : '可留空'}</span><textarea value={envText} onChange={(event) => onEnvChange(event.target.value)} rows="4" spellCheck="false" placeholder={'{\n  "API_KEY": "..."\n}'} /></label>
      {error ? <p className="mcp-editor__error" role="alert">{error}</p> : null}
      <div className="mcp-editor__actions"><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn btn--primary" onClick={onSave}>保存配置</button></div>
    </div>
  </section>;
}

/**
 * 市场条目 / 已配置 Server 的品牌 logo 位。
 * 有 logo 时用浅色底托住彩色品牌标识（与模型中心的 provider-logo 同一套做法），
 * 图片缺失或加载失败则回退到文字缩写。
 */
function McpIconBox({ logo, className = '', fallback }) {
  const [broken, setBroken] = useState(false);
  const showLogo = Boolean(logo) && !broken;
  return <span className={`mcp-manager__server-icon mcp-logo-tile ${className}`.trim()} aria-hidden="true">
    {showLogo
      ? <img className="mcp-logo" src={logo} alt="" loading="lazy" onError={() => setBroken(true)} />
      : fallback}
  </span>;
}

function McpToggle({ checked, onChange, label, disabled = false }) {
  return <button type="button" className={'mcp-toggle ' + (checked ? 'is-on' : '')} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

function toMcpConfig(server) {
  // 导出时才把 args 模板里的 {token} 换成用户填的值：没填的保持占位符，
  // 而不是退化成客户端看不懂的相对路径
  const args = resolveServerArgs(server.args, server.argValues);
  return server.transport === 'sse'
    ? { url: server.url, headers: server.env }
    : { command: server.command, args, env: server.env };
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
  return <><Section title="关于 Lattice"><div className="settings-about"><img className="settings-about__mark" src={LATTICE_ICON_URL} alt="Lattice" /><div><h3>Lattice</h3><p>本地优先的双链知识库。</p><span>当前版本 {APP_VERSION} · Windows Desktop</span></div><button type="button" className="btn" onClick={onCheckUpdate} disabled={isChecking}>{isChecking ? '检查中...' : '检查更新'}</button></div><UpdateResult status={status} release={release} message={updateState?.message} /><Row title="官方网站" description="查阅使用文档、更新说明与常见问题。"><a className="settings-update__link" href="https://dawei-star.github.io/Lattice/website/lattice-docs.html" target="_blank" rel="noreferrer">打开文档站点</a></Row><Row title="自动保存" description="编辑内容会在短暂空闲后自动保存。"><Toggle checked={settings.autoSave} onChange={(value) => onChange('autoSave', value)} /></Row><Row title="快捷切换" description="允许使用 Ctrl / Cmd + K 打开快速切换器。"><Toggle checked={settings.quickSwitcher} onChange={(value) => onChange('quickSwitcher', value)} /></Row></Section><Section title="账户"><Row title="本地工作区" description="Lattice 不要求登录，数据默认保存在本机。"><span className="settings-value">离线可用</span></Row></Section></>;
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

function VaultProfilePanel({ profile, status, warning, saveState, errors, error, onChange, onSave, onReload }) {
  const statusLabel = { default: '使用默认值', loaded: '已加载', invalid: '已回退默认值' }[status] ?? '未读取';
  const statusTone = status === 'invalid' ? 'is-warning' : status === 'loaded' ? 'is-success' : '';
  return <>
    <Section title="系统目录">
      <div className="settings-profile">
        <div className="settings-profile__intro">
          <div>
            <strong>Vault profile</strong>
            <p>为收集箱、日记和日志指定 Vault 内的相对目录。修改后只影响新建内容，不会移动已有文件。</p>
          </div>
          <span className={`settings-profile__status ${statusTone}`}>{statusLabel}</span>
        </div>
        <div className="settings-profile__fields">
          {VAULT_PROFILE_FIELDS.map(([key, label, description]) => <label className="settings-profile__field" key={key}>
            <span>{label}</span>
            <input
              value={profile.paths[key] ?? ''}
              onChange={(event) => onChange(key, event.target.value)}
              aria-label={`${label} 目录`}
              aria-invalid={Boolean(errors[key])}
              autoComplete="off"
              spellCheck="false"
            />
            <small>{description}，例如 `Work/{label}`</small>
            {errors[key] ? <em>{errors[key]}</em> : null}
          </label>)}
        </div>
        <div className="settings-profile__footer">
          <span>仅允许 Vault 内的相对路径，隐藏目录和 `_templates` 不可用。</span>
          <div className="settings-profile__actions">
            <button type="button" className="btn" onClick={onReload} disabled={saveState === 'saving'}>重新读取</button>
            <button type="button" className="btn btn--primary" onClick={onSave} disabled={saveState === 'saving'}>{saveState === 'saving' ? '保存中...' : '保存目录设置'}</button>
          </div>
        </div>
      </div>
    </Section>
    {warning ? <Notice tone="danger">profile 文件无效，当前使用默认值：{warning}</Notice> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {saveState === 'saved' ? <Notice tone="success">Vault profile 已保存。新建内容会使用新目录，已有文件保持原位置。</Notice> : null}
  </>;
}

function Section({ title, children }) { return <section className="settings-section"><h3>{title}</h3><div className="settings-section__body">{children}</div></section>; }
function Row({ title, description, children }) { return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-row__control">{children}</div></div>; }
function Toggle({ checked, onChange }) { return <button type="button" className={`settings-toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={checked ? '已启用' : '已停用'} onClick={() => onChange(!checked)}><span aria-hidden="true" /></button>; }
function Notice({ children, tone = 'neutral' }) { return <div className={'settings-notice settings-notice--' + tone}>{children}</div>; }
async function mapWithConcurrency(items, concurrency, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return result;
}
function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function NavIcon({ name }) { const paths = { info: 'M12 17v-5m0-4h.01M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0', sun: 'M12 3v2m0 14v2M3 12h2m14 0h2m-3.4-6.6-1.4 1.4M7.8 16.2l-1.4 1.4m0-11.4 1.4 1.4m8.4 8.4 1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', layout: 'M4 5h16v14H4zM4 10h16M10 10v9', edit: 'M4 20h4L19 9l-4-4L4 16v4z', link: 'M10 13a5 5 0 0 0 7.1.1l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5.4M14 11a5 5 0 0 0-7.1-.1l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8', command: 'M6 4v16M18 4v16M4 6h16M4 18h16', home: 'M3 11l9-7 9 7v9H3z', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6', refresh: 'M20 11a8 8 0 1 0 2 5m0-5v-5m0 5h-5' }; return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] ?? paths.info} /></svg>; }
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
