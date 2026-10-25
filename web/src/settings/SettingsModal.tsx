import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { ExternalLink, KeyRound, PlugZap, ShieldCheck } from 'lucide-react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import Modal from '../ui/Modal.tsx';
import { mcpApi, type McpInfo } from '../api/mcp.ts';
import { notesApi, type NoteDetail } from '../api/resources.ts';
import { memoryApi, type MemoryRecord } from '../api/memory.ts';
import { vaultApi, type VaultProfile } from '../api/vault.ts';
import { resolveAttachmentPath, vaultFiles, type LatticeDesktopBridge, type LatticeDesktopVaultInfo } from '../api/vault-files.ts';
import { buildStaticSite, type StaticSiteResult } from '../lib/static-export.ts';
import { downloadStaticSite, serializeStaticSiteFiles, writeStaticSiteToDirectory } from '../lib/static-site.ts';
import { clearImportedTheme, importThemeFile, loadImportedTheme, type ImportedTheme } from '../lib/theme.ts';
import { loadSettings, saveSettings, subscribeSettings, type LatticeSettings, type SettingsPatch } from './settings.ts';
import { createAiProvider, getActiveAiProvider, loadAiSettings, saveAiSettings, subscribeAiSettings } from './aiSettings.ts';
import { MCP_WRITE_TOOL_NAMES, loadMcpSettings, saveMcpSettings, withVisibleServers, type McpServerConfig, type McpSettings, type McpToolInfo } from './mcpSettings.ts';
import {
  MCP_MARKET_CATALOG,
  MCP_MARKET_CATEGORIES,
  appendMarketServer,
  createServerFromMarketEntry,
  isMarketEntryInstalled,
  type McpMarketEntry,
} from './mcpMarketplace.ts';
import ModelCenter from './ModelCenter.tsx';
import { clearAiRunMetrics, readAiRunMetrics, summarizeAiRunMetrics, type AiMetricSummary } from '../ai/run-metrics-store.ts';
import { checkGithubReleases, type GithubReleaseInfo } from '../lib/update.ts';
import { APP_VERSION } from '../lib/appVersion.ts';
import type { FileConfirmationResult, FileOperationInput } from '../hooks/useFileConfirmation.tsx';

type NoticeTone = 'neutral' | 'success' | 'danger' | 'warning';

interface NoticeMessage {
  tone: NoticeTone;
  text: string;
}

interface SettingsModalProps {
  open: boolean;
  initialSection?: string;
  onClose: () => void;
  theme: string;
  onThemeChange: (theme: string) => void;
  onVaultProfileSaved?: () => void;
  onConfirmFileOperation?: (operation: FileOperationInput) => Promise<FileConfirmationResult>;
}

type UpdateSetting = (key: keyof LatticeSettings, value: LatticeSettings[keyof LatticeSettings]) => void;

type UpdateState =
  | 'idle'
  | 'checking'
  | { status: 'available' | 'current' | 'error'; release?: GithubReleaseInfo; message?: string };

interface VaultProfileState {
  version: number;
  paths: Record<string, string>;
}

type VaultProfileErrors = Record<string, string | undefined>;

interface VaultInfoView {
  path?: string;
  vaultDir?: string;
  profile?: VaultProfile;
  profileStatus?: string;
  profileWarning?: string;
}

interface BackupVaultResult {
  canceled?: boolean;
  fileCount?: number;
  byteCount?: number;
  backupPath?: string;
}

interface ExportStaticSiteResult {
  canceled?: boolean;
  exportPath?: string;
}

type LatticeDesktop = LatticeDesktopBridge & {
  revealVault?: () => Promise<unknown>;
  backupVault?: (confirmation: FileConfirmationResult) => Promise<BackupVaultResult>;
  exportStaticSite?: (files: ReturnType<typeof serializeStaticSiteFiles>, confirmation: FileConfirmationResult) => Promise<ExportStaticSiteResult>;
};

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};

type StaticExportState = StaticSiteResult & { exportPath?: string };

interface McpToolRow {
  name: string;
  description?: string;
  write?: boolean;
  enabled?: boolean;
}

type McpInfoView = McpInfo & {
  command?: string;
  serverPath?: string;
  dbFile?: string;
  vaultDir?: string;
  writesEnabled?: boolean;
  writesEnvVar?: string;
  electronRuntime?: boolean;
  notionCalendarServerPath?: string;
  tools?: McpToolInfo[];
};

interface McpToolsCenterProps {
  vaultPath: string;
}

interface McpIconBoxProps {
  logo?: string;
  className?: string;
  fallback?: ReactNode;
}

interface McpToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

interface AboutProps {
  settings: LatticeSettings;
  onChange: UpdateSetting;
  onCheckUpdate: () => void;
  updateState: UpdateState;
}

interface UpdateResultProps {
  status?: string;
  release?: GithubReleaseInfo;
  message?: string;
}

interface VaultProfilePanelProps {
  profile: VaultProfileState;
  status: string;
  warning: string | null;
  saveState: string;
  errors: VaultProfileErrors;
  error: string;
  onChange: (key: string, value: string) => void;
  onSave: () => void;
  onReload: () => void;
}

interface SectionProps {
  title?: ReactNode;
  children?: ReactNode;
}

interface RowProps {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

interface NoticeProps {
  children?: ReactNode;
  tone?: NoticeTone;
}

interface NavIconProps {
  name: string;
}

interface ThemeImportPanelProps {
  theme: ImportedTheme | null;
  onChange: (theme: ImportedTheme | null) => void;
}

interface BackgroundImagePanelProps {
  image: string;
  onChange: (image: string) => void;
}

const LATTICE_ICON_URL = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAyNCIgaGVpZ2h0PSIxMDI0IiB2aWV3Qm94PSIwIDAgMTAyNCAxMDI0IiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHg9IjEwNCIgeT0iMTQ3IiB3aWR0aD0iODE1IiBoZWlnaHQ9IjgxNSIgcng9IjE1NSIgZmlsbD0iIzA0MEE0NiIvPjxyZWN0IHg9IjEwNCIgeT0iMTA0IiB3aWR0aD0iODE1IiBoZWlnaHQ9IjgxNSIgcng9IjE1NSIgZmlsbD0iIzE2MjU4NSIvPjxyZWN0IHg9IjEwMCIgeT0iMTQyIiB3aWR0aD0iNjk0IiBoZWlnaHQ9IjY5NCIgcng9IjEyNSIgZmlsbD0iIzFGMkVBMiIvPjxyZWN0IHg9IjEwMCIgeT0iMTAwIiB3aWR0aD0iNjk0IiBoZWlnaHQ9IjY5NCIgcng9IjEyNSIgZmlsbD0iIzNCNTBERiIvPjxyZWN0IHg9Ijk2IiB5PSIxMzgiIHdpZHRoPSI1NzIiIGhlaWdodD0iNTcyIiByeD0iOTYiIGZpbGw9IiM0QzY4RUIiLz48cmVjdCB4PSI5NiIgeT0iOTYiIHdpZHRoPSI1NzIiIGhlaWdodD0iNTcyIiByeD0iOTYiIGZpbGw9IiM3Qjk2RkYiLz48cmVjdCB4PSI5MiIgeT0iMTM0IiB3aWR0aD0iNDUxIiBoZWlnaHQ9IjQ1MSIgcng9IjY2IiBmaWxsPSIjOTBBOUZGIi8+PHJlY3QgeD0iOTIiIHk9IjkyIiB3aWR0aD0iNDUxIiBoZWlnaHQ9IjQ1MSIgcng9IjY2IiBmaWxsPSIjQzZENkZGIi8+PC9zdmc+';
const MAX_BACKGROUND_IMAGE_SIZE = 2 * 1024 * 1024;
const ALLOWED_BACKGROUND_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const DEFAULT_VAULT_PROFILE: VaultProfileState = Object.freeze({
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
  { title: 'AI 助手', items: [['models', '模型', 'layout'], ['memory', '记忆', 'brain'], ['metrics', '运行统计', 'chart']] },
  { title: '选项', items: [['about', '关于', 'info'], ['appearance', '外观', 'sun'], ['interface', '界面', 'layout'], ['editor', '编辑器', 'edit'], ['shortcuts', '快捷键', 'command']] },
  { title: '知识库', items: [['vault', '知识库位置', 'home'], ['migration', '备份与迁移', 'refresh']] },
];

export default function SettingsModal({ open, initialSection = 'about', onClose, theme, onThemeChange, onVaultProfileSaved, onConfirmFileOperation }: SettingsModalProps) {
  const [active, setActive] = useState(initialSection === 'mcp' ? 'about' : initialSection);
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(() => loadSettings());
  const [migration, setMigration] = useState('idle');
  const [migrationPath, setMigrationPath] = useState('');
  const [backup, setBackup] = useState('idle');
  const [backupResult, setBackupResult] = useState<BackupVaultResult | null>(null);
  const [staticExport, setStaticExport] = useState('idle');
  const [staticExportResult, setStaticExportResult] = useState<StaticExportState | null>(null);
  const [vaultPath, setVaultPath] = useState('');
  const [vaultNotice, setVaultNotice] = useState<NoticeMessage | null>(null);
  const [vaultProfile, setVaultProfile] = useState(DEFAULT_VAULT_PROFILE);
  const [vaultProfileStatus, setVaultProfileStatus] = useState('default');
  const [vaultProfileWarning, setVaultProfileWarning] = useState<string | null>(null);
  const [vaultProfileSaveState, setVaultProfileSaveState] = useState('idle');
  const [vaultProfileErrors, setVaultProfileErrors] = useState<VaultProfileErrors>({});
  const [vaultProfileError, setVaultProfileError] = useState('');
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const updateRequestRef = useRef(0);
  const [importedTheme, setImportedTheme] = useState(() => loadImportedTheme());
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => subscribeSettings(setSettings), []);

  useEffect(() => {
    if (!open) return undefined;
    setActive(initialSection === 'mcp' ? 'about' : initialSection);
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

    const handleSearchShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, [initialSection, open]);

  const updateSetting: UpdateSetting = (key, value) => setSettings(saveSettings({ [key]: value } as SettingsPatch));
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
    let desktopInfo: LatticeDesktopVaultInfo | null | undefined;
    try {
      desktopInfo = await window.latticeDesktop?.getVaultInfo?.();
    } catch {
      desktopInfo = null;
    }
    try {
      const info = (desktopInfo?.profile ? desktopInfo : await vaultApi.info()) as VaultInfoView;
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

  const updateVaultProfilePath = (key: string, value: string) => {
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
      const info = (await vaultApi.updateProfile({ version: 1, paths: validation.paths, ...confirmation })) as VaultInfoView;
      setVaultProfile(normalizeVaultProfile(info?.profile ?? { version: 1, paths: validation.paths }));
      setVaultProfileStatus(info?.profileStatus ?? 'loaded');
      setVaultProfileWarning(info?.profileWarning ?? null);
      setVaultProfileSaveState('saved');
      await onVaultProfileSaved?.();
    } catch (error) {
      const failure = error as { fieldErrors?: Record<string, string>; message?: string };
      const fieldErrors = failure?.fieldErrors ?? {};
      setVaultProfileErrors(Object.fromEntries(VAULT_PROFILE_FIELDS.map(([key]) => [
        key,
        fieldErrors[`paths.${key}`] ?? fieldErrors[key],
      ]).filter(([, message]) => message)));
      setVaultProfileError(failure?.message ?? '保存 Vault profile 失败，请稍后重试。');
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
    const revealed = await (window.latticeDesktop as LatticeDesktop)?.revealVault?.();
    setVaultNotice(revealed
      ? { tone: 'success', text: '已在资源管理器中打开知识库。' }
      : { tone: 'neutral', text: '打开目录仅在桌面版可用。' });
  };

  const migrate = async () => {
    const selected = await openFileDialog({
      directory: false,
      multiple: false,
      title: '选择旧版 SQLite 数据库',
      filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    if (typeof selected !== 'string' || !selected) return;
    setMigrationPath(selected);
    const confirmation = await onConfirmFileOperation?.({
      type: 'create',
      path: selected,
      fullPath: selected,
      contentSummary: '将旧版 SQLite 笔记导出为 Markdown 文件',
      impact: '读取外部旧 SQLite 并新增 Markdown；原数据库保留，不读取当前 .lattice/lattice.db',
    });
    if (!confirmation?.confirmed) return;
    if (!window.confirm('SQLite 迁移将新增 Markdown 文件，原数据库会保留。确认继续执行？')) return;
    setMigration('running');
    try {
      await vaultApi.migrate({ sqlitePath: selected, ...confirmation, secondConfirmed: true });
      setMigration('done');
    } catch {
      setMigration('error');
    }
  };

  const backupVault = async () => {
    if (!(window.latticeDesktop as LatticeDesktop)?.backupVault) {
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
      const result = await (window.latticeDesktop as LatticeDesktop).backupVault!(confirmation);
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
        const detail = await notesApi.get(entry.id) as NoteDetail & { filePath?: string };
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
      if ((window.latticeDesktop as LatticeDesktop)?.exportStaticSite) {
        const result = await (window.latticeDesktop as LatticeDesktop).exportStaticSite!(serializeStaticSiteFiles(site.files), confirmation);
        if (result?.canceled) {
          setStaticExport('idle');
          return;
        }
        setStaticExportResult({ ...site, exportPath: result.exportPath });
      } else if (typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function') {
        const directory = await (window as WindowWithDirectoryPicker).showDirectoryPicker!({ mode: 'readwrite' });
        await writeStaticSiteToDirectory(directory, site.files);
        setStaticExportResult(site);
      } else {
        mode = 'downloads';
        await downloadStaticSite(site.files);
        setStaticExportResult(site);
      }
      setStaticExport(mode === 'downloads' ? 'downloaded' : 'done');
    } catch (error) {
      const failure = error as { name?: string };
      if (failure?.name === 'AbortError') {
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
      const failure = error as { message?: string };
      setUpdateState({ status: 'error', message: failure?.message ?? '无法连接 GitHub，请稍后重试' });
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
        {active === 'memory' && <MemoryPanel />}
        {active === 'metrics' && <AiMetricsPanel />}
        {active === 'appearance' && <><BackgroundImagePanel image={settings.backgroundImage} onChange={(value) => updateSetting('backgroundImage', value)} /><ThemeImportPanel theme={importedTheme} onChange={setImportedTheme} /><Section title="外观"><Row title="主题" description="选择工作区使用的颜色主题。"><select aria-label="主题" value={theme} onChange={(event) => onThemeChange(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></Row><Row title="界面密度" description="调整导航、列表和工具栏的垂直间距。"><select aria-label="界面密度" value={settings.density} onChange={(event) => updateSetting('density', event.target.value)}><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></Row></Section></>}
        {active === 'interface' && <Section title="界面"><Row title="界面字号" description="调整设置、列表和工具栏的基础字号。"><select aria-label="界面字号" value={settings.fontSize} onChange={(event) => updateSetting('fontSize', event.target.value)}><option value="13">小</option><option value="14">标准</option><option value="15">大</option></select></Row><Row title="内容最大宽度" description="控制编辑器和 Markdown 预览的阅读宽度。"><select aria-label="内容最大宽度" value={settings.contentWidth} onChange={(event) => updateSetting('contentWidth', event.target.value)}><option value="720">720px</option><option value="860">860px</option><option value="1040">1040px</option></select></Row></Section>}
        {active === 'editor' && <Section title="编辑器"><Row title="编辑引擎" description="BlockSuite 是 Markdown 真源的运行时投影，可随时切回旧版编辑器。"><select aria-label="编辑引擎" value={settings.editorEngine} onChange={(event) => updateSetting('editorEngine', event.target.value)}><option value="legacy">Legacy Markdown</option><option value="blocksuite">BlockSuite</option></select></Row><Row title="默认编辑模式" description="打开笔记时使用的初始视图。"><select aria-label="默认编辑模式" value={settings.editorMode} onChange={(event) => updateSetting('editorMode', event.target.value)}><option value="split">分栏</option><option value="edit">编辑</option><option value="preview">预览</option></select></Row><Row title="Tab 缩进" description={`按 Tab 插入 ${settings.tabSize} 个空格。`}><select aria-label="Tab 缩进" value={settings.tabSize} onChange={(event) => updateSetting('tabSize', event.target.value)}><option value="2">2 个空格</option><option value="4">4 个空格</option></select></Row><Row title="自动保存" description="停止输入后自动写入 Markdown 文件。"><Toggle checked={settings.autoSave} onChange={(value) => updateSetting('autoSave', value)} /></Row><Row title="自动保存延迟" description="停止输入后等待多久写入磁盘。"><select aria-label="自动保存延迟" value={settings.autoSaveDelay} disabled={!settings.autoSave} onChange={(event) => updateSetting('autoSaveDelay', event.target.value)}><option value="500">500 ms</option><option value="900">900 ms</option><option value="1500">1500 ms</option></select></Row></Section>}
        {active === 'shortcuts' && <Section title="快捷键"><div className="shortcut-list">{[['快速切换', 'Ctrl / Cmd + K'], ['新建笔记', 'Ctrl / Cmd + N'], ['保存笔记', 'Ctrl / Cmd + S'], ['设置', 'Ctrl / Cmd + ,'], ['编辑 / 预览', 'Ctrl / Cmd + E']].map(([name, key]) => <div className="shortcut-row" key={name}><span>{name}</span><kbd>{key}</kbd></div>)}</div></Section>}
        {active === 'vault' && <><Section title="知识库位置"><div className="settings-vault"><div className="settings-vault__info"><strong>当前知识库目录</strong><code className="settings-vault__path" title={vaultPath ? '点击可全选路径' : undefined}>{vaultPath || '正在读取知识库目录...'}</code><p>笔记以 Markdown 文件保存在该目录，可直接被其他工具读取。</p></div><div className="settings-vault__actions"><button type="button" className="btn" onClick={loadVaultPath}>重新读取</button><button type="button" className="btn" disabled={!vaultPath || !(window.latticeDesktop as LatticeDesktop)?.revealVault} onClick={revealVault}>打开目录</button><button type="button" className="btn btn--primary" disabled={!vaultPath} onClick={copyVaultPath}>复制路径</button></div></div></Section>{vaultNotice ? <Notice tone={vaultNotice.tone}>{vaultNotice.text}</Notice> : null}<Section title="附件显示"><Row title="显示附件" description="在文件列表和快速切换中显示图片、视频、PDF、Word 文档等非笔记文件，包括知识库任意文件夹中的这类文件。关闭时它们不会出现在 Lattice 中。"><Toggle checked={settings.showAttachments} onChange={(value) => updateSetting('showAttachments', value)} /></Row></Section><Section title="索引状态"><div className="settings-health"><span className="settings-health__dot" aria-hidden="true" /><div className="settings-health__copy"><strong>索引正常</strong><p>笔记、标签与双链会随文件变化自动更新。</p></div><span className="settings-health__badge">实时</span></div></Section></>}
        {active === 'vault' && <VaultProfilePanel profile={vaultProfile} status={vaultProfileStatus} warning={vaultProfileWarning} saveState={vaultProfileSaveState} errors={vaultProfileErrors} error={vaultProfileError} onChange={updateVaultProfilePath} onSave={saveVaultProfile} onReload={loadVaultPath} />}
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
            <Row title="从 SQLite 导出为 Markdown" description={migrationPath ? '已选择旧版 SQLite 数据库。' : '仅用于旧版数据库迁移，原数据库会保留，不会被删除。'}><button type="button" className="btn" onClick={migrate} disabled={migration === 'running'}>{migration === 'running' ? '迁移中...' : '选择数据库并迁移'}</button></Row>
            {migration === 'done' && <Notice tone="success">迁移完成，Markdown 文件已写入当前知识库。</Notice>}
            {migration === 'error' && <Notice tone="danger">迁移失败，请检查后端服务后重试。</Notice>}
          </Section>
        </>}
      </div>
    </main>
  </div></Modal>;
}

function normalizeVaultProfile(value: VaultProfile | null | undefined): VaultProfileState {
  const paths = value?.paths ?? {};
  return {
    version: 1,
    paths: Object.fromEntries(VAULT_PROFILE_FIELDS.map(([key]) => [
      key,
      typeof paths[key] === 'string' && (paths[key] as string).trim()
        ? (paths[key] as string).trim().replaceAll('\\', '/')
        : (DEFAULT_VAULT_PROFILE.paths as Record<string, string>)[key],
    ])),
  };
}

function validateVaultProfilePaths(paths: Record<string, string>) {
  const errors: Record<string, string> = {};
  const normalizedPaths: Record<string, string> = {};
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

const DEFAULT_MCP_TOOLS: McpToolRow[] = [
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

export function McpToolsCenter({ vaultPath }: McpToolsCenterProps) {
  const [info, setInfo] = useState<McpInfoView | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(() => loadMcpSettings());
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const [marketSearch, setMarketSearch] = useState('');
  const [marketCategory, setMarketCategory] = useState('全部');
  const [expandedMarketKey, setExpandedMarketKey] = useState('');
  const [authorizingServerId, setAuthorizingServerId] = useState<string | null>(null);
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState(false);

  const updateSettings = (updater: McpSettings | ((current: McpSettings) => McpSettings)) => {
    setSettings((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      return saveMcpSettings(next);
    });
  };

  const createLatticeServer = (serverInfo: McpInfoView | null | undefined = info) => ({
    id: 'lattice-local',
    key: 'lattice',
    name: 'Lattice',
    description: 'Lattice 内置知识库工具',
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
  }) as unknown as McpServerConfig;

  const loadInfo = async ({ silent = false }: { silent?: boolean } = {}) => {
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
      if (!silent) setNotice({ tone: 'success', text: '工具状态已刷新。' });
    } catch {
      // 桌面端当前没有独立的 mcp_info IPC 命令。工具配置仍保存在本机，
      // 因此使用安全的本地回退信息，避免把“没有 HTTP 后端”误显示成连接器损坏。
      setInfo({ vaultDir: vaultPath, writesEnabled: false, tools: DEFAULT_MCP_TOOLS });
      setLoadError(false);
      if (!silent) setNotice({ tone: 'neutral', text: '已使用本地工具目录；连接器配置仍保存在本机。' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInfo({ silent: true });
  }, []);

  // 反馈提示自动收起：它是吸附在面板底部的一条信息，长时间压着内容没有意义
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  const toggleServer = (serverId: string) => {
    // 走 withVisibleServers：info 还没返回时列表展示的是回退出来的内置 Server，
    // 直接 map 空数组会让「开关点了没反应」
    updateSettings((current) => ({
      ...current,
      servers: withVisibleServers(current.servers, managedServers, (servers) => servers
        .map((server) => server.id === serverId ? { ...server, enabled: !server.enabled } : server)),
    }));
  };


  const managedServers: McpServerConfig[] = settings.servers.length ? settings.servers : [createLatticeServer(info)];
  const toolList: McpToolRow[] = managedServers.find((server) => server.id === 'lattice-local')?.tools
    ?? info?.tools
    ?? DEFAULT_MCP_TOOLS;

  const openAuthorization = (server: McpServerConfig) => {
    setAuthorizingServerId(server.id);
    setCredentialValues(Object.fromEntries((server.requiresEnv ?? []).map((item) => [item.name, server.env?.[item.name] ?? ''])));
  };

  const installFromMarket = (entry: McpMarketEntry) => {
    const existing = managedServers.find((server) => isMarketEntryInstalled([server], entry));
    if (existing) {
      const missingEnv = (existing.requiresEnv ?? []).filter((item) => !String(existing.env?.[item.name] ?? '').trim());
      const missingArgs = (existing.requiresArgs ?? []).filter((item) => !String(existing.argValues?.[item.token] ?? '').trim());
      if (missingEnv.length) {
        openAuthorization(existing);
        return;
      }
      if (missingArgs.length) {
        setNotice({ tone: 'warning', text: `${entry.name} 配置还不完整，请补齐必要参数；当前不会自动启动或重试。` });
        return;
      }
      if (!existing.enabled) {
        toggleServer(existing.id);
        setNotice({ tone: 'success', text: `${entry.name} 配置已启用。` });
      } else {
        toggleServer(existing.id);
        setNotice({ tone: 'neutral', text: `${entry.name} 已停用。` });
      }
      return;
    }
    const server = createServerFromMarketEntry(entry, {
      vaultDir: info?.vaultDir ?? vaultPath,
      dbFile: info?.dbFile,
      notionCalendarServerPath: info?.notionCalendarServerPath,
    });
    // 保留兼容配置形态供设置页展示和后续 sidecar 使用；当前 Tauri 桌面端不会
    // 据此启动 MCP 进程，也不会要求这里的命令立即可执行。
    if (entry.key === 'notion-calendar' && info?.command) {
      server.command = info.command;
      if (info.electronRuntime) server.env = { ...server.env, ELECTRON_RUN_AS_NODE: '1' };
    }
    // settings.servers 为空时列表展示的是回退出来的内置 Lattice Server（尚未落盘），
    // 以“当前可见列表”为基线追加，避免内置条目在下一次保存后消失。
    updateSettings((current) => ({
      ...current,
      servers: appendMarketServer(current.servers, managedServers, server),
    }));
    const missingEnv = (server.requiresEnv ?? []).filter((item) => !String(server.env?.[item.name] ?? '').trim());
    const missingArgs = (server.requiresArgs ?? []).filter((item) => !String(server.argValues?.[item.token] ?? '').trim());
    if (missingEnv.length) {
      openAuthorization(server);
      setNotice({ tone: 'warning', text: `${entry.name} 需要一次授权，其他配置已保存。` });
    } else if (missingArgs.length) {
      setNotice({ tone: 'warning', text: `${entry.name} 配置已保存，但还缺少必要参数；当前不会自动启动或重试。` });
    } else {
      setNotice({ tone: 'success', text: `${entry.name} 配置已保存；外部 MCP Server 将在 sidecar 能力交付后启用。` });
    }
  };

  const saveAuthorization = () => {
    const server = managedServers.find((item) => item.id === authorizingServerId);
    if (!server) return;
    const missing = (server.requiresEnv ?? []).filter((item) => !String(credentialValues[item.name] ?? '').trim());
    if (missing.length) {
      setNotice({ tone: 'warning', text: `请填写 ${missing.map((item) => item.name).join('、')} 后再保存。` });
      return;
    }
    updateSettings((current) => ({
      ...current,
      servers: withVisibleServers(current.servers, managedServers, (servers) => servers.map((item) => item.id === server.id
        ? { ...item, env: { ...item.env, ...credentialValues }, enabled: true }
        : item)),
    }));
    setAuthorizingServerId(null);
    setCredentialValues({});
    setNotice({ tone: 'success', text: `${server.name} 授权配置已保存；当前不会启动外部 MCP Server。` });
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
    const write = tool.write ?? (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name);
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
  const activeServers = managedServers.filter((server) => server.builtin !== true && server.enabled);
  const authorizingServer = managedServers.find((server) => server.id === authorizingServerId) ?? null;
  const authorizingEntry = authorizingServer
    ? MCP_MARKET_CATALOG.find((entry) => isMarketEntryInstalled([authorizingServer], entry))
    : null;
  const nativeToolPreview = readTools.slice(0, 6);

  return <div className="mcp-settings mcp-manager mcp-tools-center">
    <section className="mcp-tools-center__hero">
       <div><span className="settings-kicker">MCP TOOLS</span><h3>MCP 工具</h3><p>管理 AI 可使用的 MCP 配置。当前桌面端只保存和读取配置，不会启动外部 MCP Server。</p></div>
       <div className="mcp-tools-center__stats"><div><strong>{enabledToolCount + activeServers.length}</strong><span>已配置</span></div><div><strong>{MCP_MARKET_CATALOG.length}</strong><span>工具目录</span></div></div>
    </section>
    <div className="mcp-tools-center__toolbar">
       <span className="mcp-tools-center__status"><i />MCP 配置已加载</span>
       <label className="mcp-manager__search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索已配置工具..." aria-label="搜索已配置工具" /></label>
      <button type="button" className="icon-btn" onClick={() => loadInfo()} disabled={loading} aria-label="刷新工具状态" title="刷新工具状态"><NavIcon name="refresh" /></button>
    </div>

    <section className="mcp-tools-center__section">
       <div className="mcp-manager__section-head"><div><h4>已配置工具</h4><p>内置知识库能力由桌面 AI 直接提供；外部 MCP 仅保存连接配置，待 sidecar 支持后执行。</p></div><span className="settings-value">{activeServers.length + 1} 项</span></div>
      <div className="mcp-tools-center__enabled-grid">
        <article className="mcp-tools-center__enabled-card is-native">
          <McpIconBox fallback="L" />
          <div><strong>知识库工具</strong><p>读取、搜索、整理当前 Lattice 知识库</p><div className="mcp-tools-center__tool-tags">{nativeToolPreview.map((tool) => <span key={tool.name}>{tool.name}</span>)}</div></div>
          <span className="mcp-tools-center__enabled-badge">内置</span>
        </article>
        {activeServers.filter((server) => !search.trim() || `${server.name} ${server.description}`.toLowerCase().includes(search.trim().toLowerCase())).map((server) => {
          const entry = MCP_MARKET_CATALOG.find((item) => isMarketEntryInstalled([server], item));
          return <article className="mcp-tools-center__enabled-card" key={server.id}>
            <McpIconBox logo={entry?.logo ?? ''} fallback={server.name.slice(0, 2)} />
            <div><strong>{server.name}</strong><p>{entry?.tagline ?? server.description}</p><div className="mcp-tools-center__tool-tags">{(entry?.tools ?? server.tools ?? []).slice(0, 4).map((tool) => <span key={tool.name}>{tool.name}</span>)}</div></div>
            <McpToggle checked onChange={() => toggleServer(server.id)} label={'停用 ' + server.name} />
          </article>;
        })}
      </div>
    </section>

    {authorizingServer ? <section className="mcp-tools-center__auth" data-testid="mcp-authorization">
      <div className="mcp-tools-center__auth-head">
         <div><span className="settings-kicker">CONFIGURE SERVICE</span><h4>配置 {authorizingServer.name}</h4><p>授权信息只保存在本机。完成后会保存 MCP 连接配置；当前桌面端不会启动外部 MCP Server。</p></div>
        {authorizingEntry?.authorization ? <a className="mcp-tools-center__auth-link" href={authorizingEntry.authorization.url} target="_blank" rel="noreferrer">
          <ExternalLink size={14} aria-hidden="true" />
          {authorizingEntry.authorization.label}
        </a> : null}
      </div>
      <div className="mcp-tools-center__auth-steps">
        <div className="mcp-tools-center__auth-step"><span>01</span><div><strong>打开官方授权页</strong><p>{authorizingEntry?.authorization?.description ?? '打开服务方文档，找到对应的 API Key 或访问令牌。'}</p></div></div>
        <div className="mcp-tools-center__auth-step"><span>02</span><div><strong>把凭据填回这里</strong><p>只粘贴服务方生成的令牌，不要填写账号密码。</p></div></div>
      </div>
      <div className="mcp-tools-center__auth-fields">{(authorizingServer.requiresEnv ?? []).map((item, index) => <label key={item.name}><span><KeyRound size={13} aria-hidden="true" />{(authorizingServer.requiresEnv?.length ?? 0) > 1 ? `凭据 ${index + 1}` : 'API Key / 访问令牌'}<code>{item.name}</code></span><input type="password" autoComplete="off" value={credentialValues[item.name] ?? ''} onChange={(event) => setCredentialValues((current) => ({ ...current, [item.name]: event.target.value }))} placeholder={item.hint} /></label>)}</div>
       <div className="mcp-tools-center__auth-actions"><button type="button" className="btn btn--sm" onClick={() => { setAuthorizingServerId(null); setCredentialValues({}); }}>稍后配置</button><button type="button" className="btn btn--sm btn--primary" onClick={saveAuthorization}><PlugZap size={14} aria-hidden="true" />保存授权配置</button></div>
    </section> : null}

    <section className="mcp-tools-center__section" data-testid="mcp-market">
       <div className="mcp-manager__section-head"><div><h4>工具目录</h4><p>按需保存工具配置；完整的自动调用能力待 MCP sidecar 支持。</p></div><span className="settings-value">{MCP_MARKET_CATALOG.length} 个 · 已配置 {marketInstalledCount}</span></div>
      <div className="mcp-market mcp-tools-center__catalog">
        <div className="mcp-market__filters"><div className="mcp-market__chips" role="group" aria-label="工具分类">{['全部', ...MCP_MARKET_CATEGORIES].map((category) => <button key={category} type="button" className={'mcp-market__chip' + (marketCategory === category ? ' is-active' : '')} onClick={() => setMarketCategory(category)}>{category}</button>)}</div><label className="mcp-manager__search mcp-market__search"><span aria-hidden="true">⌕</span><input value={marketSearch} onChange={(event) => setMarketSearch(event.target.value)} placeholder="搜索工具..." aria-label="搜索工具目录" /></label></div>
        <div className="mcp-market__grid">{marketEntries.map((entry) => {
          const installedServer = managedServers.find((server) => isMarketEntryInstalled([server], entry));
          const installed = Boolean(installedServer);
          const expanded = expandedMarketKey === entry.key;
          const needsAuth = (entry.requiresEnv ?? []).length > 0;
          const authReady = !needsAuth || (entry.requiresEnv ?? []).every((item) => String(installedServer?.env?.[item.name] ?? '').trim());
          const argsReady = (entry.requiresArgs ?? []).every((item) => String(installedServer?.argValues?.[item.token] ?? '').trim());
           const configured = Boolean(installedServer?.enabled && authReady && argsReady);
          const pendingAuth = Boolean(installed && needsAuth && !authReady);
           const statusLabel = configured ? '已配置' : pendingAuth ? '待授权' : installed ? '待配置' : needsAuth ? '需要授权' : '可配置';
           const actionLabel = configured ? '停用' : pendingAuth ? '继续授权' : installed ? '继续配置' : needsAuth ? '开始配置' : '保存配置';
           return <article key={entry.key} className={'mcp-market__card' + (installed ? ' is-installed' : '') + (configured ? ' is-connected' : '') + (pendingAuth ? ' is-pending' : '') + (expanded ? ' is-expanded' : '')}>
             <header className="mcp-market__card-head"><McpIconBox logo={entry.logo} className="mcp-market__icon" fallback={entry.name.slice(0, 2)} /><div className="mcp-market__card-title"><strong>{entry.name}</strong>{entry.featured ? <span className="mcp-market__featured">推荐</span> : null}<span className={'mcp-market__runtime' + (configured ? ' is-connected' : pendingAuth ? ' is-pending' : '')}>{statusLabel}</span></div></header>
            <p className="mcp-market__card-desc">{entry.tagline}</p>
            <div className="mcp-market__card-tools">{(entry.tools ?? []).slice(0, 4).map((tool) => <code key={tool.name} title={tool.description}>{tool.name}</code>)}{(entry.tools?.length ?? 0) > 4 ? <span className="mcp-market__more">+{entry.tools.length - 4}</span> : null}</div>
            {expanded ? <div className="mcp-market__detail"><p className="mcp-market__detail-text">{entry.description}</p><ul className="mcp-market__detail-list">{(entry.tools ?? []).map((tool) => <li key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></li>)}</ul>{entry.authorization ? <div className="mcp-market__auth-destination"><div><span>授权入口</span><strong>{entry.authorization.kind === 'local-plugin' ? '本地插件设置' : '官方服务控制台'}</strong></div><a href={entry.authorization.url} target="_blank" rel="noreferrer"><ExternalLink size={13} aria-hidden="true" />{entry.authorization.label}</a></div> : null}<a className="mcp-market__docs" href={entry.docs} target="_blank" rel="noreferrer">查看工具说明 <ExternalLink size={13} aria-hidden="true" /></a></div> : null}
              <footer className="mcp-market__card-foot"><span className="mcp-market__category">{entry.category}</span><div className="mcp-market__card-actions"><button type="button" className="btn btn--sm btn--ghost" aria-expanded={expanded} aria-label={(expanded ? '收起 ' : '查看 ') + entry.name + ' 说明'} onClick={() => setExpandedMarketKey(expanded ? '' : entry.key)}>{expanded ? '收起' : '详情'}</button><button type="button" className={'btn btn--sm' + (configured ? '' : ' btn--primary')} aria-label={actionLabel + ' ' + entry.name} onClick={() => installFromMarket(entry)}>{configured ? <ShieldCheck size={14} aria-hidden="true" /> : <PlugZap size={14} aria-hidden="true" />}{actionLabel}</button></div></footer>
          </article>;
        })}{!marketEntries.length ? <div className="mcp-manager__empty mcp-market__empty"><strong>没有匹配的工具</strong><span>换个关键词或分类试试。</span></div> : null}</div>
         <p className="mcp-tools-center__catalog-note">Lattice 当前负责保存连接配置和授权信息。需要账号的工具只在配置时请求授权；外部 MCP Server 的启动、生命周期和工具调用待 sidecar 支持。</p>
      </div>
    </section>

    {loadError ? <Notice tone="danger"><span className="settings-notice__row"><span>部分工具状态暂时无法读取，默认内置工具仍可使用。</span><button type="button" className="btn btn--sm" onClick={() => loadInfo()}>重试</button></span></Notice> : null}
    {notice ? <div className="mcp-notice-dock"><Notice tone={notice.tone}>{notice.text}</Notice></div> : null}
  </div>;
}

function McpIconBox({ logo, className = '', fallback }: McpIconBoxProps) {
  const [broken, setBroken] = useState(false);
  const showLogo = Boolean(logo) && !broken;
  return <span className={`mcp-manager__server-icon mcp-logo-tile ${className}`.trim()} aria-hidden="true">
    {showLogo
      ? <img className="mcp-logo" src={logo as string} alt="" loading="lazy" onError={() => setBroken(true)} />
      : fallback}
  </span>;
}

function McpToggle({ checked, onChange, label, disabled = false }: McpToggleProps) {
  return <button type="button" className={'mcp-toggle ' + (checked ? 'is-on' : '')} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

function About({ settings, onChange, onCheckUpdate, updateState }: AboutProps) {
  const isChecking = updateState === 'checking';
  const updateInfo = typeof updateState === 'object' ? updateState : undefined;
  const status = updateInfo?.status;
  const release = updateInfo?.release;
  return <><Section title="关于 Lattice"><div className="settings-about"><img className="settings-about__mark" src={LATTICE_ICON_URL} alt="Lattice" /><div><h3>Lattice</h3><p>本地优先的双链知识库。</p><span>当前版本 {APP_VERSION} · Windows Desktop</span></div><button type="button" className="btn" onClick={onCheckUpdate} disabled={isChecking}>{isChecking ? '检查中...' : '检查更新'}</button></div><UpdateResult status={status} release={release} message={updateInfo?.message} /><Row title="官方网站" description="查阅使用文档、更新说明与常见问题。"><a className="settings-update__link" href="https://dawei-star.github.io/Lattice/website/lattice-docs.html" target="_blank" rel="noreferrer">打开文档站点</a></Row><Row title="自动保存" description="编辑内容会在短暂空闲后自动保存。"><Toggle checked={settings.autoSave} onChange={(value) => onChange('autoSave', value)} /></Row><Row title="快捷切换" description="允许使用 Ctrl / Cmd + K 打开快速切换器。"><Toggle checked={settings.quickSwitcher} onChange={(value) => onChange('quickSwitcher', value)} /></Row></Section><Section title="账户"><Row title="本地工作区" description="Lattice 不要求登录，数据默认保存在本机。"><span className="settings-value">离线可用</span></Row></Section></>;
}

function UpdateResult({ status, release, message }: UpdateResultProps) {
  if (status === 'error') return <Notice tone="danger">GitHub 更新检查失败：{message}</Notice>;
  if (!release || !['current', 'available'].includes(status as string)) return null;

  const releaseLink = <a className="settings-update__link" href={release.htmlUrl} target="_blank" rel="noreferrer">查看 GitHub 发布页</a>;
  if (status === 'available') {
    return <Notice tone="success"><div className="settings-update"><div><strong>发现新版本 {release.name}</strong><p>当前版本 {APP_VERSION}，可从 GitHub 下载 Windows 安装包。</p></div><div className="settings-update__actions">{release.installer ? <a className="btn btn--primary" href={release.downloadUrl} target="_blank" rel="noreferrer">下载 Windows 安装包</a> : null}{releaseLink}</div></div></Notice>;
  }

  return <Notice tone="success"><div className="settings-update"><div><strong>当前版本 {APP_VERSION} 已是最新</strong><p>已从 GitHub Releases 检查到 {release.name}。</p></div><div className="settings-update__actions">{releaseLink}</div></div></Notice>;
}

function VaultProfilePanel({ profile, status, warning, saveState, errors, error, onChange, onSave, onReload }: VaultProfilePanelProps) {
  const statusLabel = ({ default: '使用默认值', loaded: '已加载', invalid: '已回退默认值' } as Record<string, string>)[status] ?? '未读取';
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

function AiMetricsPanel() {
  const [summary, setSummary] = useState<AiMetricSummary>(() => summarizeAiRunMetrics(readAiRunMetrics()));
  const refresh = () => setSummary(summarizeAiRunMetrics(readAiRunMetrics()));
  const clear = () => {
    if (!window.confirm('清除本机保存的 AI 运行统计？')) return;
    clearAiRunMetrics();
    refresh();
  };
  return <>
    <Section title="运行概览"><div className="settings-metrics-overview"><div><strong>{summary.requests}</strong><span>次运行</span></div><div><strong>{summary.totalTokens.toLocaleString()}</strong><span>总 tokens</span></div><div><strong>{summary.durationP50Ms === null ? '—' : `${Math.round(summary.durationP50Ms)} ms`}</strong><span>耗时 P50</span></div><div><strong>{summary.ttftP50Ms === null ? '—' : `${Math.round(summary.ttftP50Ms)} ms`}</strong><span>TTFT P50</span></div><div><strong>{summary.costKnown ? `$${summary.estimatedCostUsd.toFixed(4)}` : '未估算'}</strong><span>估算成本</span></div></div></Section>
    <Section title="按任务类型"><div className="settings-metrics-table"><div className="settings-metrics-table__head"><span>任务</span><span>次数</span><span>tokens</span><span>耗时 P50</span></div>{summary.byTask.length ? summary.byTask.map((item) => <div className="settings-metrics-table__row" key={item.taskType}><span>{item.taskType === 'agent' ? 'Agent' : item.taskType === 'retrieval' ? '检索' : '快速问答'}</span><span>{item.requests}</span><span>{item.totalTokens.toLocaleString()}</span><span>{item.durationP50Ms === null ? '—' : `${Math.round(item.durationP50Ms)} ms`}</span></div>) : <div className="settings-memory-empty">暂无运行记录。</div>}</div></Section>
    <Section title="按模型"><div className="settings-metrics-table"><div className="settings-metrics-table__head"><span>模型</span><span>次数</span><span>tokens</span><span>成本</span></div>{summary.byModel.map((item) => <div className="settings-metrics-table__row" key={item.model}><span title={item.model}>{item.model}</span><span>{item.requests}</span><span>{item.totalTokens.toLocaleString()}</span><span>{item.costKnown ? `$${item.estimatedCostUsd.toFixed(4)}` : '未估算'}</span></div>)}</div><div className="settings-metrics-actions"><span>统计只保存在本机，最多保留最近 500 次运行。成本需要在模型设置中填写单价。</span><div><button type="button" className="btn" onClick={refresh}>刷新</button><button type="button" className="btn" onClick={clear}>清除统计</button></div></div></Section>
  </>;
}

function MemoryPanel() {
  const [items, setItems] = useState<MemoryRecord[]>([]);
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [kind, setKind] = useState<'preference' | 'knowledge'>('preference');
  const [content, setContent] = useState('');
  const [source, setSource] = useState('用户设置');
  const [expiresOn, setExpiresOn] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');

  const load = async () => {
    setStatus('loading');
    setError('');
    try {
      setItems(await memoryApi.list(true));
      setStatus('idle');
    } catch (failure) {
      setStatus('error');
      setError((failure as { message?: string })?.message ?? '无法读取工作区记忆。');
    }
  };

  useEffect(() => { void load(); }, []);

  const reset = () => {
    setEditing(null);
    setKind('preference');
    setContent('');
    setSource('用户设置');
    setExpiresOn('');
    setError('');
  };

  const edit = (item: MemoryRecord) => {
    setEditing(item);
    setKind(item.kind === 'knowledge' ? 'knowledge' : 'preference');
    setContent(item.content);
    setSource(item.source);
    setExpiresOn(item.expiresAt ? item.expiresAt.slice(0, 10) : '');
    setError('');
  };

  const save = async () => {
    if (!content.trim() || !source.trim()) {
      setError('请填写记忆内容和来源。');
      return;
    }
    setStatus('saving');
    setError('');
    try {
      const input = {
        kind,
        content: content.trim(),
        source: source.trim(),
        expiresAt: expiresOn ? new Date(`${expiresOn}T23:59:59.000Z`).toISOString() : null,
        confirmed: true,
      } as const;
      if (editing) await memoryApi.update(editing.id, { ...input, id: editing.id });
      else await memoryApi.create(input);
      await load();
      reset();
    } catch (failure) {
      setStatus('error');
      setError((failure as { message?: string })?.message ?? '保存记忆失败。敏感信息不会被保存。');
    }
  };

  const remove = async (item: MemoryRecord) => {
    if (!window.confirm('删除这条记忆？删除后不会再注入 AI 上下文。')) return;
    setError('');
    try {
      await memoryApi.delete(item.id, true);
      if (editing?.id === item.id) reset();
      await load();
    } catch (failure) {
      setError((failure as { message?: string })?.message ?? '删除记忆失败。');
    }
  };

  return <>
    <Section title="新增记忆">
      <div className="settings-memory-form">
        <div className="settings-memory-form__grid">
          <label><span>类型</span><select aria-label="记忆类型" value={kind} onChange={(event) => setKind(event.target.value as 'preference' | 'knowledge')}><option value="preference">用户偏好</option><option value="knowledge">工作区知识</option></select></label>
          <label><span>来源</span><input aria-label="记忆来源" value={source} onChange={(event) => setSource(event.target.value)} placeholder="例如：用户设置、项目说明" maxLength={200} /></label>
          <label><span>过期日期（可选）</span><input aria-label="记忆过期日期" type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} /></label>
        </div>
        <label className="settings-memory-form__content"><span>内容</span><textarea aria-label="记忆内容" value={content} onChange={(event) => setContent(event.target.value)} placeholder="只保存你明确希望 Lattice 长期使用的内容。密钥、身份信息和隐私内容会被拒绝。" maxLength={12000} /></label>
        <div className="settings-memory-form__actions"><span>{editing ? '正在编辑已有记忆' : '只会保存用户明确提交的记忆'}</span><div><button type="button" className="btn" onClick={reset}>清空</button><button type="button" className="btn btn--primary" onClick={save} disabled={status === 'saving'}>{status === 'saving' ? '保存中...' : editing ? '更新记忆' : '保存记忆'}</button></div></div>
      </div>
    </Section>
    {error ? <Notice tone="danger">{error}</Notice> : null}
    <Section title={`已保存记忆 · ${items.length}`}>{status === 'loading' ? <div className="settings-memory-empty">正在读取...</div> : !items.length ? <div className="settings-memory-empty">还没有保存的记忆。</div> : <div className="settings-memory-list">{items.map((item) => <article className={`settings-memory-item ${item.expired ? 'is-expired' : ''}`} key={item.id}><div className="settings-memory-item__head"><span className="settings-memory-item__kind">{item.kind === 'preference' ? '用户偏好' : '工作区知识'}</span>{item.expired ? <span className="settings-memory-item__expired">已过期</span> : null}<span className="settings-memory-item__source">来源：{item.source}</span></div><p>{item.content}</p><div className="settings-memory-item__foot"><span>更新于 {formatMemoryDate(item.updatedAt)}{item.expiresAt ? ` · ${item.expired ? '已于' : '将于'} ${formatMemoryDate(item.expiresAt)} 过期` : ''}</span><div><button type="button" className="btn btn--sm" onClick={() => edit(item)}>编辑</button><button type="button" className="btn btn--sm" onClick={() => void remove(item)}>删除</button></div></div></article>)}</div>}</Section>
  </>;
}

function formatMemoryDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN');
}

function Section({ title, children }: SectionProps) { return <section className="settings-section"><h3>{title}</h3><div className="settings-section__body">{children}</div></section>; }
function Row({ title, description, children }: RowProps) { return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-row__control">{children}</div></div>; }
function Toggle({ checked, onChange }: ToggleProps) { return <button type="button" className={`settings-toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={checked ? '已启用' : '已停用'} onClick={() => onChange(!checked)}><span aria-hidden="true" /></button>; }
function Notice({ children, tone = 'neutral' }: NoticeProps) { return <div className={'settings-notice settings-notice--' + tone}>{children}</div>; }
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
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
function formatBytes(value: number | string | null | undefined) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function NavIcon({ name }: NavIconProps) { const paths = { info: 'M12 17v-5m0-4h.01M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0', sun: 'M12 3v2m0 14v2M3 12h2m14 0h2m-3.4-6.6 1.4-1.4M7.8 16.2l-1.4 1.4m0-11.4 1.4 1.4m8.4 8.4 1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', layout: 'M4 5h16v14H4zM4 10h16M10 10v9', edit: 'M4 20h4L19 9l-4-4L4 16v4z', link: 'M10 13a5 5 0 0 0 7.1.1l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5.4M14 11a5 5 0 0 0-7.1-.1l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8', command: 'M6 4v16M18 4v16M4 6h16M4 18h16', home: 'M3 11l9-7 9 7v9H3z', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6', refresh: 'M20 11a8 8 0 1 0 2 5m0-5v-5m0 5h-5', brain: 'M9.5 5.5A3.5 3.5 0 0 0 6 9v.5A3.5 3.5 0 0 0 6 16a3.5 3.5 0 0 0 3.5 3.5M14.5 5.5A3.5 3.5 0 0 1 18 9v.5A3.5 3.5 0 0 1 18 16a3.5 3.5 0 0 1-3.5 3.5M9.5 5.5v13M14.5 5.5v13M9.5 12h5', chart: 'M4 19V5m0 14h16M8 16v-4m4 4V8m4 8v-7' }; return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name as keyof typeof paths] ?? paths.info} /></svg>; }
function ThemeImportPanel({ theme, onChange }: ThemeImportPanelProps) {
  const [error, setError] = useState(''); const [inputKey, setInputKey] = useState(0);
  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; setError(''); try { onChange(await importThemeFile(file)); } catch (importError) { setError((importError as { message?: string })?.message ?? '主题导入失败'); } finally { setInputKey((value) => value + 1); } };
  const reset = () => { clearImportedTheme(); onChange(null); };
  return <section className="theme-import" aria-label="导入主题"><div className="theme-import__copy"><span className="settings-kicker">CUSTOM THEME</span><strong>导入主题</strong><p>{theme ? `当前使用：${theme.name}` : '导入 JSON 或 CSS 颜色令牌，立即预览自定义主题。'}</p></div><div className="theme-import__actions"><label className="btn">选择主题文件<input key={inputKey} type="file" accept=".json,.css,application/json,text/css" onChange={handleImport} /></label>{theme ? <button type="button" className="btn" onClick={reset}>恢复默认</button> : null}</div>{error ? <p className="theme-import__error" role="alert">{error}</p> : null}</section>;
}

function BackgroundImagePanel({ image, onChange }: BackgroundImagePanelProps) {
  const [error, setError] = useState('');
  const [inputKey, setInputKey] = useState(0);

  const handleSelect = (event: ChangeEvent<HTMLInputElement>) => {
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
