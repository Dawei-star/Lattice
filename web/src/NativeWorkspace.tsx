import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { FilePlus2, FolderOpen, RefreshCw, Save, Search } from 'lucide-react';
import { marked } from 'marked';
import { nativeVault, type NativeIndexStats, type NativeNoteContents, type NativeNoteFile } from './api/native-vault';
import { createNativeDocument, splitNativeDocument } from './api/native-document.js';
import { resolveAttachmentPath } from './api/vault-files.js';
import MarkdownPreview from './components/MarkdownPreview.jsx';
import './native-workspace.css';

type EditorMode = 'edit' | 'split' | 'preview';

/** 侧栏列表项：普通列表不带摘要，搜索命中时附带命中上下文。 */
type VisibleNote = NativeNoteFile & { excerpt?: string | undefined };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileName(title: string): string {
  return title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 100);
}

export default function NativeWorkspace() {
  const [vaultPath, setVaultPath] = useState('');
  const [files, setFiles] = useState<NativeNoteFile[]>([]);
  const [visible, setVisible] = useState<VisibleNote[]>([]);
  const [index, setIndex] = useState<NativeIndexStats | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<NativeNoteContents | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<EditorMode>('split');
  const [status, setStatus] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assetRevision, setAssetRevision] = useState(0);
  const assetCacheRef = useRef(new Map<string, string | null>());
  const activeRef = useRef(active);
  const draftRef = useRef(draft);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const closingRef = useRef(false);
  activeRef.current = active;
  draftRef.current = draft;

  /**
   * 读取 Vault 信息与笔记列表。
   * `rescan` 会先做一次增量索引对齐（首次启动 / 手动刷新）：未变化的文件不读盘，
   * 所以重复调用成本很低，列表则始终直接读索引。
   */
  const refresh = useCallback(async ({ rescan = false } = {}) => {
    try {
      if (rescan) {
        const summary = await nativeVault.scan();
        const changed = summary.added + summary.updated + summary.removed;
        setStatus(
          changed > 0
            ? `索引已更新：新增 ${summary.added} · 更新 ${summary.updated} · 移除 ${summary.removed}（${summary.durationMs}ms）`
            : `索引已是最新：${summary.total} 篇 · ${summary.durationMs}ms`,
        );
      }
      const [info, notes, stats] = await Promise.all([
        nativeVault.info(),
        nativeVault.list(),
        nativeVault.indexStats(),
      ]);
      setVaultPath(info.path);
      setFiles(notes);
      setVisible(notes);
      setIndex(stats);
    } catch (error) {
      setStatus(`无法读取 Vault：${errorText(error)}`);
    }
  }, []);

  useEffect(() => { void refresh({ rescan: true }); }, [refresh]);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(async () => {
      try {
        const results = query.trim() ? await nativeVault.search(query, 100) : files;
        if (live) setVisible(results);
      } catch (error) {
        if (live) setStatus(`搜索失败：${errorText(error)}`);
      }
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, files]);

  const dirty = active !== null && active.raw !== splitNativeDocument(active.raw).prefix + draft;

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) await savingRef.current;
    const note = activeRef.current;
    if (!note) return true;
    const raw = splitNativeDocument(note.raw).prefix + draftRef.current;
    if (raw === note.raw) return true;
    const saving = (async () => {
      try {
        setStatus('正在保存');
        const saved = await nativeVault.write(note.path, raw, note.sha256);
        if (activeRef.current?.path === note.path) {
          activeRef.current = saved;
          setActive(saved);
        }
        setStatus('已保存');
        setFiles(await nativeVault.list());
        return true;
      } catch (error) {
        setStatus(`保存失败：${errorText(error)}`);
        return false;
      }
    })();
    savingRef.current = saving;
    const result = await saving;
    savingRef.current = null;
    return result;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    const windowHandle = getCurrentWindow();
    let live = true;
    let unlisten: (() => void) | undefined;
    void windowHandle.onCloseRequested(async (event) => {
      if (closingRef.current) return;
      const note = activeRef.current;
      if (!note || note.raw === splitNativeDocument(note.raw).prefix + draftRef.current) return;
      event.preventDefault();
      if (await saveNow()) {
        closingRef.current = true;
        try {
          await windowHandle.close();
        } catch (error) {
          closingRef.current = false;
          setStatus(`关闭失败：${errorText(error)}`);
        }
      }
    }).then((stop) => { if (live) unlisten = stop; else stop(); }).catch((error) => {
      if (live) setStatus(`无法监听窗口关闭：${errorText(error)}`);
    });
    return () => { live = false; unlisten?.(); window.removeEventListener('keydown', onKeyDown); };
  }, [saveNow]);

  useEffect(() => {
    if (!dirty) return undefined;
    const timer = window.setTimeout(() => { void saveNow(); }, 900);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, saveNow]);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    const paths = new Set<string>();
    marked.walkTokens(marked.lexer(draft), (token) => {
      if (token.type !== 'image') return;
      const path = resolveAttachmentPath(active.path, token.href);
      if (path && !assetCacheRef.current.has(path)) paths.add(path);
    });
    void Promise.all([...paths].map(async (path) => {
      try {
        const asset = await nativeVault.readAsset(path);
        if (live) assetCacheRef.current.set(path, asset);
      } catch {
        if (live) assetCacheRef.current.set(path, null);
      }
    })).then(() => { if (live && paths.size) setAssetRevision((value) => value + 1); });
    return () => { live = false; };
  }, [active?.path, draft]);

  const openNote = useCallback(async (path: string) => {
    if (path === activeRef.current?.path) return;
    if (!(await saveNow())) return;
    setBusy(true);
    try {
      const note = await nativeVault.read(path);
      activeRef.current = note;
      setActive(note);
      setDraft(splitNativeDocument(note.raw).content);
      setStatus('');
    } catch (error) {
      setStatus(`无法打开笔记：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }, [saveNow]);

  const chooseVault = async () => {
    if (!(await saveNow())) return;
    const selected = await open({ directory: true, multiple: false, title: '选择 Vault 文件夹' });
    if (typeof selected !== 'string') return;
    try {
      await nativeVault.open(selected);
      assetCacheRef.current.clear();
      setAssetRevision((value) => value + 1);
      activeRef.current = null;
      setActive(null);
      setDraft('');
      setQuery('');
      await refresh({ rescan: true });
    } catch (error) {
      setStatus(`无法切换 Vault：${errorText(error)}`);
    }
  };

  const createNote = async () => {
    const title = newTitle.trim();
    const stem = fileName(title);
    if (!stem) { setStatus('请输入有效的笔记标题'); return; }
    if (!(await saveNow())) return;
    const used = new Set(files.map((note) => note.path.toLowerCase()));
    let path = `Inbox/${stem}.md`;
    for (let suffix = 2; used.has(path.toLowerCase()); suffix += 1) path = `Inbox/${stem} ${suffix}.md`;
    try {
      const note = await nativeVault.write(path, createNativeDocument(title));
      setCreating(false);
      setNewTitle('');
      setFiles(await nativeVault.list());
      activeRef.current = note;
      setActive(note);
      setDraft('');
      setStatus('已创建');
    } catch (error) {
      setStatus(`创建失败：${errorText(error)}`);
    }
  };

  const titleIndex = useMemo(() => {
    const index = new Map<string, NativeNoteFile>();
    for (const file of files) index.set(file.title.toLocaleLowerCase(), file);
    return index;
  }, [files]);
  const resolveTitle = useCallback((title: string) => titleIndex.get(title.toLocaleLowerCase()) ? { id: title } : null, [titleIndex]);
  const resolveEmbed = useCallback(async (title: string) => {
    const file = titleIndex.get(title.toLocaleLowerCase());
    if (!file) return null;
    const note = await nativeVault.read(file.path);
    return splitNativeDocument(note.raw).content;
  }, [titleIndex]);
  const resolveAsset = useCallback((reference: string) => {
    const path = resolveAttachmentPath(active?.path, reference);
    return path ? assetCacheRef.current.get(path) ?? null : null;
  }, [active?.path, assetRevision]);
  const activeTitle = files.find((file) => file.path === active?.path)?.title ?? '';

  return <div className="native-workspace">
    <header className="native-header">
      <strong className="native-brand">格物 Lattice</strong>
      <span className="native-vault-path" title={vaultPath}>{vaultPath}</span>
      <button title="切换 Vault" aria-label="切换 Vault" onClick={() => void chooseVault()}><FolderOpen size={17} /></button>
      <button title="重新扫描索引" aria-label="重新扫描索引" onClick={() => void refresh({ rescan: true })}><RefreshCw size={17} /></button>
    </header>
    <div className="native-body">
      <aside className="native-sidebar">
        <div className="native-sidebar-tools">
          <label className="native-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记" aria-label="搜索笔记" /></label>
          <button title="新建笔记" aria-label="新建笔记" onClick={() => setCreating(true)}><FilePlus2 size={17} /></button>
        </div>
        {creating && <form className="native-create" onSubmit={(event) => { event.preventDefault(); void createNote(); }}>
          <input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="笔记标题" aria-label="笔记标题" />
          <button type="submit">创建</button><button type="button" onClick={() => setCreating(false)}>取消</button>
        </form>}
        <div className="native-list-count">{query.trim() ? `找到 ${visible.length} 篇` : `${visible.length} 篇笔记`}</div>
        <div className="native-list">{visible.map((file) => <button key={file.path} className={active?.path === file.path ? 'is-active' : ''} onClick={() => void openNote(file.path)} disabled={busy}>
          <span className="native-item-title">{file.title}</span>
          <span className="native-item-path">{file.path}</span>
          {file.excerpt && <span className="native-item-excerpt">{file.excerpt}</span>}
        </button>)}</div>
      </aside>
      <main className="native-main">
        {active ? <>
          <div className="native-editor-bar"><div className="native-heading"><strong>{activeTitle}</strong><span>{active.path}</span></div>
            <div className="native-modes" role="group" aria-label="编辑模式">{(['edit', 'split', 'preview'] as const).map((item) => <button key={item} className={mode === item ? 'is-active' : ''} onClick={() => setMode(item)}>{item === 'edit' ? '编辑' : item === 'split' ? '分栏' : '预览'}</button>)}</div>
            <button title="保存笔记" aria-label="保存笔记" onClick={() => void saveNow()}><Save size={17} /></button>
          </div>
          <div className={`native-editor native-editor--${mode}`}>
            {mode !== 'preview' && <textarea aria-label="笔记内容" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} />}
            {mode !== 'edit' && <div className="native-preview"><MarkdownPreview content={draft} resolveTitle={resolveTitle} resolveAsset={resolveAsset} resolveEmbed={resolveEmbed} onOpenWikiLink={(title: string) => { const file = titleIndex.get(title.toLocaleLowerCase()); if (file) void openNote(file.path); }} onCreateWikiLink={(title: string) => { setNewTitle(title); setCreating(true); }} /></div>}
          </div>
        </> : <div className="native-empty">选择一篇笔记，或新建笔记。</div>}
      </main>
    </div>
    <footer className="native-status" role="status">
      <span>{status}</span>
      <span>
        {[
          files.length ? `共 ${files.length} 篇` : '',
          index ? `索引库 ${formatBytes(index.dbBytes)}` : '',
          dirty ? '未保存' : active ? '磁盘已同步' : '',
        ].filter(Boolean).join(' · ')}
      </span>
    </footer>
  </div>;
}
