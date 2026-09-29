import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownPreview from './MarkdownPreview.jsx';
import { formatDateTime, formatNumber } from '../lib/format.js';
import { parseOutline, renderMarkdown } from '../lib/markdown.js';
import ContextMenu from '../ui/ContextMenu.jsx';
import Resizer from '../ui/Resizer.jsx';
import { aiApi } from '../api/ai.js';
import { notesApi } from '../api/resources.js';
import { loadAiSettings } from '../settings/aiSettings.js';
import { loadLayout, saveLayout } from '../lib/layout.js';
import { loadSettings, subscribeSettings } from '../settings/settings.js';
import Modal from '../ui/Modal.jsx';
import { relativeAttachmentReference, resolveAttachmentPath, vaultAttachmentsApi, vaultFiles } from '../api/vault-files.js';
import { buildStaticHtml } from '../lib/static-export.js';

const MODES = [
  { key: 'edit', label: '编辑' },
  { key: 'split', label: '分栏' },
  { key: 'preview', label: '预览' },
];

/**
 * 编辑区。
 *
 * 保存策略：本地草稿 + 可配置的防抖自动保存，并额外提供 Ctrl/Cmd + S 立即保存。
 * 只有 title / content 与当前笔记不同才会发请求，避免自动保存空转刷新 updated_at。
 */
export default function EditorPane({
  note,
  folders,
  resolveTitle,
  resolveEmbed,
  onSave,
  externalWriteGranted = false,
  onRequestExternalWrite,
  onSaveExternal,
  onDelete,
  onTogglePin,
  onMove,
  onOpenWikiLink,
  onCreateWikiLink,
  registerNavigationGuard,
  onCreateNote,
  onCreateFromTemplate,
  onCreateDaily,
  onOpenSwitcher,
  onCloseTab,
  onDuplicate,
  onCopyPath,
  onCopyWikiLink,
}) {
  const [draft, setDraft] = useState(() => ({ title: note?.title ?? '', content: note?.content ?? '', properties: note?.properties ?? {} }));
  const [settings, setSettings] = useState(() => loadSettings());
  const [mode, setMode] = useState(() => loadSettings().editorMode);
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [historyState, setHistoryState] = useState({ open: false, loading: false, items: [], currentHash: '', selected: null, error: '' });
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  const [templates, setTemplates] = useState([]);

  const noteIdRef = useRef(note ? `${note.id}:${note.externalRevision ?? ''}` : null);
  const draftRef = useRef(draft);
  const textareaRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const previewRef = useRef(null);
  const bodyRef = useRef(null);
  const [splitRatio, setSplitRatio] = useState(() => loadLayout().split);
  const isExternal = Boolean(note?.external);
  const canEdit = !isExternal || externalWriteGranted;
  const resolveAsset = useCallback((reference) => {
    const attachmentPath = resolveAttachmentPath(note?.filePath, reference);
    return attachmentPath ? vaultFiles.attachmentUrl(attachmentPath) : null;
  }, [note?.filePath]);

  // 分栏边界：dx 按编辑区实际宽度换算成百分比，收敛与持久化交给 layout.js
  const resizeSplit = (dx) => {
    const width = bodyRef.current?.clientWidth ?? 0;
    if (!width) return;
    setSplitRatio((current) => saveLayout({ ...loadLayout(), split: current + (dx / width) * 100 }).split);
  };
  const resetSplit = () => setSplitRatio((current) => saveLayout({ ...loadLayout(), split: 50 }).split);

  draftRef.current = draft;

  const dirty = Boolean(note) && (
    draft.title !== note.title
    || draft.content !== note.content
    || !propertiesEqual(draft.properties, note.properties)
  );

  useEffect(() => subscribeSettings((next) => {
    setSettings(next);
    setMode(next.editorMode);
  }), []);

  useEffect(() => {
    if (note) return undefined;
    let cancelled = false;
    notesApi.templates()
      .then((items) => { if (!cancelled) setTemplates(Array.isArray(items) ? items : []); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [note]);

  /** 切换笔记时重置草稿；同一篇笔记的回写不覆盖用户正在输入的内容 */
  useEffect(() => {
    const nextId = note ? `${note.id}:${note.externalRevision ?? ''}` : null;
    if (noteIdRef.current === nextId) return;
    noteIdRef.current = nextId;
    setDraft({ title: note?.title ?? '', content: note?.content ?? '', properties: note?.properties ?? {} });
    setStatus('idle');
    setErrorMessage('');
  }, [note]);

  const openHistory = useCallback(async () => {
    if (!note || isExternal) return;
    setHistoryState((current) => ({ ...current, open: true, loading: true, error: '' }));
    try {
      const result = await notesApi.history(note.id);
      setHistoryState({ open: true, loading: false, items: result?.items ?? [], currentHash: result?.currentHash ?? '', selected: null, error: '' });
    } catch (error) {
      setHistoryState((current) => ({ ...current, loading: false, error: error?.message ?? '无法加载版本历史' }));
    }
  }, [isExternal, note]);

  const selectHistoryVersion = useCallback(async (version) => {
    if (!note) return;
    try {
      const selected = await notesApi.historyVersion(note.id, version);
      setHistoryState((current) => ({ ...current, selected }));
    } catch (error) {
      setHistoryState((current) => ({ ...current, error: error?.message ?? '无法读取版本' }));
    }
  }, [note]);

  const restoreSelectedHistory = useCallback(async () => {
    const selected = historyState.selected;
    if (!note || !selected || !window.confirm(`确定恢复到 ${new Date(selected.createdAt).toLocaleString()} 吗？`)) return;
    try {
      await notesApi.restoreHistory(note.id, selected.version, { expectedCurrentHash: historyState.currentHash });
      setHistoryState((current) => ({ ...current, open: false, selected: null }));
      await onSave(note.id, { title: selected.title, content: selected.content, isPinned: selected.isPinned, properties: selected.properties ?? {} });
    } catch (error) {
      setHistoryState((current) => ({ ...current, error: error?.message ?? '恢复版本失败' }));
    }
  }, [historyState.currentHash, historyState.selected, note, onSave]);

  const commit = useCallback(
    async ({ silent = true } = {}) => {
      if (!note) return;

      if (isExternal) {
        if (!canEdit || draftRef.current.content === note.content) return;
        setStatus('saving');
        try {
          await onSaveExternal?.(note.externalToken, draftRef.current.content);
          setStatus('saved');
          setErrorMessage('');
        } catch (error) {
          setStatus('error');
          setErrorMessage(error?.message ?? '保存失败，请重试');
          if (!silent) throw error;
        }
        return;
      }

      const patch = {};
      const trimmedTitle = draftRef.current.title.trim();
      // 标题为空时不提交：服务端会拒绝空标题，此时只保存正文
      if (trimmedTitle && trimmedTitle !== note.title) patch.title = trimmedTitle;
      if (draftRef.current.content !== note.content) patch.content = draftRef.current.content;
      if (!propertiesEqual(draftRef.current.properties, note.properties)) patch.properties = draftRef.current.properties ?? {};

      if (Object.keys(patch).length === 0) return;

      setStatus('saving');
      try {
        await onSave(note.id, patch);
        setStatus('saved');
        setErrorMessage('');
      } catch (error) {
        setStatus('error');
        setErrorMessage(error?.message ?? '保存失败，请重试');
        if (!silent) throw error;
      }
    },
    [canEdit, isExternal, note, onSave, onSaveExternal],
  );

  // 防抖自动保存
  useEffect(() => {
    if (!dirty || !canEdit || !settings.autoSave) return undefined;
    setStatus((current) => (current === 'saving' ? current : 'dirty'));

    const timer = setTimeout(() => commit(), Number(settings.autoSaveDelay));
    return () => clearTimeout(timer);
  }, [canEdit, draft.content, draft.properties, draft.title, dirty, commit, settings.autoSave, settings.autoSaveDelay]);

  // 离开页面前提醒（自动保存已覆盖绝大多数情况，这里兜住关标签页）
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // 切换笔记前拦截未保存内容
  useEffect(() => {
    registerNavigationGuard?.(() => {
      const current = draftRef.current;
      if (!note) return true;
      const hasChanges = current.title !== note.title || current.content !== note.content || !propertiesEqual(current.properties, note.properties);
      if (!hasChanges) return true;
      return window.confirm('这篇笔记还有未保存的修改，确定要离开吗？');
    });
    return () => registerNavigationGuard?.(null);
  }, [note, registerNavigationGuard]);

  // 快捷键：Ctrl/Cmd + S 立即保存，Ctrl/Cmd + E 切换模式
  useEffect(() => {
    const handler = (event) => {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        commit({ silent: false });
      }
      if (event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setMode((current) => (current === 'preview' ? 'edit' : current === 'edit' ? 'preview' : 'edit'));
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [commit]);

  /** 分栏模式下让预览跟随编辑器的滚动比例，减少来回找位置 */
  const handleScroll = (event) => {
    if (mode !== 'split' || !previewRef.current) return;
    const source = event.currentTarget;
    const scrollable = source.scrollHeight - source.clientHeight;
    if (scrollable <= 0) return;

    const ratio = source.scrollTop / scrollable;
    const target = previewRef.current;
    const targetScrollable = target.scrollHeight - target.clientHeight;
    target.scrollTop = ratio * targetScrollable;
  };

  const handleKeyDown = (event) => {
    if (!canEdit) return;
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const { selectionStart, selectionEnd, value } = event.currentTarget;
    const next = `${value.slice(0, selectionStart)}${' '.repeat(Number(settings.tabSize))}${value.slice(selectionEnd)}`;
    setDraft((current) => ({ ...current, content: next }));
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (target) target.selectionStart = target.selectionEnd = selectionStart + Number(settings.tabSize);
    });
  };

  const stats = useMemo(() => {
    const content = draft.content ?? '';
    const cjk = content.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
    const latin = content.match(/[A-Za-z0-9]+/g)?.length ?? 0;
    return {
      words: cjk + latin,
      lines: content ? content.split('\n').length : 0,
      chars: content.length,
    };
  }, [draft.content]);

  const outline = useMemo(() => parseOutline(draft.content), [draft.content]);

  const jumpToHeading = useCallback((heading) => {
    const textarea = textareaRef.current;
    if (textarea) {
      const line = draft.content.slice(0, heading.start).split('\n').length - 1;
      const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 24;
      textarea.focus();
      textarea.setSelectionRange(heading.start, heading.start);
      textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight * 0.25);
    }

    const previewHeading = previewRef.current?.querySelectorAll('h1, h2, h3, h4, h5, h6')?.[heading.index];
    previewHeading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [draft.content]);

  // ── AI 写作助手：选区加工（润色/摘要/翻译/续写）+ 无选区创作（全文/文案/构思）──
  const [selection, setSelection] = useState({ start: 0, end: 0, text: '' });
  const [assist, setAssist] = useState(null);
  const [customInstruction, setCustomInstruction] = useState('');
  const assistAbortRef = useRef(null);
  const assistBusy = Boolean(assist && !assist.done);

  const syncSelection = (event) => {
    const { selectionStart, selectionEnd } = event.currentTarget;
    setSelection({
      start: selectionStart,
      end: selectionEnd,
      text: draftRef.current.content.slice(selectionStart, selectionEnd),
    });
  };

  const handleAttachmentUpload = useCallback(async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !note || !canEdit || isExternal) return;

    setAttachmentBusy(true);
    try {
      const uploaded = await vaultAttachmentsApi.upload(file);
      const reference = encodeURI(relativeAttachmentReference(note.filePath, uploaded.path));
      const label = String(uploaded.name ?? file.name).replace(/[\[\]]/g, '');
      const syntax = uploaded.mimeType?.startsWith('image/')
        ? `![${label}](${reference})`
        : `[${label}](${reference})`;
      const value = draftRef.current.content;
      const start = Math.min(selection.start, value.length);
      const end = Math.min(Math.max(selection.end, start), value.length);
      const next = `${value.slice(0, start)}${syntax}${value.slice(end)}`;
      setDraft((current) => ({ ...current, content: next }));
      setSelection({ start: start + syntax.length, end: start + syntax.length, text: '' });
      setErrorMessage('');
      requestAnimationFrame(() => {
        const target = textareaRef.current;
        if (!target) return;
        target.focus();
        target.selectionStart = target.selectionEnd = start + syntax.length;
      });
    } catch (error) {
      setErrorMessage(error?.message ?? '附件上传失败');
    } finally {
      setAttachmentBusy(false);
    }
  }, [canEdit, isExternal, note, selection.end, selection.start]);

  const handleStaticExport = useCallback(async () => {
    if (!note || exportBusy) return;
    setExportBusy(true);
    setExportError('');
    try {
      const html = await buildStaticHtml({
        title: note.title,
        content: draftRef.current.content,
        resolveTitle,
        resolveAsset,
        resolveEmbed,
      });
      triggerHtmlDownload(note.title, html);
    } catch (error) {
      setExportError(error?.message ?? 'HTML 导出失败，请重试');
    } finally {
      setExportBusy(false);
    }
  }, [exportBusy, note, resolveAsset, resolveEmbed, resolveTitle]);

  const updateProperty = (key, value) => {
    setDraft((current) => ({
      ...current,
      properties: { ...(current.properties ?? {}), [key]: value },
    }));
  };

  const renameProperty = (oldKey, rawKey) => {
    const nextKey = rawKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(nextKey) || (nextKey !== oldKey && nextKey in (draft.properties ?? {}))) return;
    setDraft((current) => {
      const properties = {};
      for (const [key, value] of Object.entries(current.properties ?? {})) properties[key === oldKey ? nextKey : key] = value;
      return { ...current, properties };
    });
  };

  const addProperty = () => {
    const properties = draft.properties ?? {};
    let key = 'property';
    let index = 2;
    while (key in properties) key = `property${index++}`;
    setDraft((current) => ({ ...current, properties: { ...(current.properties ?? {}), [key]: '' } }));
  };

  const removeProperty = (key) => {
    setDraft((current) => {
      const properties = { ...(current.properties ?? {}) };
      delete properties[key];
      return { ...current, properties };
    });
  };

  // 选区兜底同步：部分内核不派发 textarea 级 select 事件（React onSelect 因此失灵），
  // document 级 selectionchange 在各内核都可靠，这里统一作准
  useEffect(() => {
    const sync = () => {
      const target = textareaRef.current;
      if (!target || document.activeElement !== target) return;
      const { selectionStart, selectionEnd } = target;
      setSelection((current) => (
        current.start === selectionStart && current.end === selectionEnd
          ? current
          : { start: selectionStart, end: selectionEnd, text: draftRef.current.content.slice(selectionStart, selectionEnd) }
      ));
    };
    document.addEventListener('selectionchange', sync);
    return () => document.removeEventListener('selectionchange', sync);
  }, []);

  const runWriteAssist = async (label, instruction, assistMode) => {
    if (!canEdit) return;
    if (assist && !assist.done) return;
    const hasSelection = selection.text.trim().length > 0;
    const source = assistMode === 'continue'
      ? draftRef.current.content.slice(Math.max(0, selection.end - 2000), selection.end)
      : assistMode === 'create'
        ? draftRef.current.content
        : selection.text;
    if (assistMode === 'rewrite' && !hasSelection) return;
    if (assistMode === 'continue' && !source.trim()) return;

    const controller = new AbortController();
    assistAbortRef.current = controller;
    setAssist({ label, mode: assistMode, streamText: '', error: '', done: false, result: '' });
    try {
      const accessToken = loadAiSettings().accessToken?.trim();
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const payload = await aiApi.writeStream({
        instruction,
        text: source,
        mode: assistMode,
        title: draftRef.current.title,
      }, {
        headers,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'delta') {
            setAssist((current) => (current ? { ...current, streamText: current.streamText + event.text } : current));
          }
        },
      });
      if (payload?.cancelled) {
        setAssist(null);
        return;
      }
      setAssist((current) => (current ? { ...current, done: true, result: payload?.text ?? '' } : current));
    } catch (requestError) {
      setAssist((current) => (current ? { ...current, error: requestError?.message ?? '写作助手调用失败' } : current));
    } finally {
      assistAbortRef.current = null;
    }
  };

  const applyAssistResult = (result, placement) => {
    if (!canEdit) return;
    const value = draftRef.current.content;
    let next = value;
    let caret = 0;
    if (assist.mode === 'continue') {
      next = value.slice(0, selection.end) + result + value.slice(selection.end);
      caret = selection.end + result.length;
    } else if (assist.mode === 'create' && placement === 'append') {
      next = value.trimEnd() ? `${value.trimEnd()}\n\n${result}` : result;
      caret = next.length;
    } else if (assist.mode === 'create') {
      next = result;
      caret = result.length;
    } else {
      next = value.slice(0, selection.start) + result + value.slice(selection.end);
      caret = selection.start + result.length;
    }
    setDraft((current) => ({ ...current, content: next }));
    setAssist(null);
    setSelection({ start: 0, end: 0, text: '' });
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (target) {
        target.focus();
        target.selectionStart = target.selectionEnd = caret;
      }
    });
  };

  const acceptAssist = () => {
    if (!assist?.done || !assist.result.trim()) return;
    if (assist.mode === 'create' && draftRef.current.content.trim()) {
      if (!window.confirm('当前笔记已有正文，「替换全文」会覆盖现有内容。确认替换？（也可选择「追加到末尾」）')) return;
    }
    applyAssistResult(assist.result);
  };

  useEffect(() => () => assistAbortRef.current?.abort(), []);

  // AI 智能建议写入：LinkPanel 的「＋链接 / ＋标签」确认后走这里，
  // 追加进当前编辑器草稿再由自动保存落盘——不绕过编辑缓冲，避免覆盖未保存内容
  useEffect(() => {
    const handler = (event) => {
      const detail = event.detail ?? {};
      if (!note || !canEdit || detail.noteId !== note.id) return;
      const suffix = detail.type === 'link'
        ? `[[${String(detail.value ?? '').trim()}]]`
        : `#${String(detail.value ?? '').trim()}`;
      if (!suffix || suffix.length < 3) return;
      const value = draftRef.current.content;
      const next = value.trimEnd() ? `${value.trimEnd()}\n\n${suffix}` : suffix;
      setDraft((current) => ({ ...current, content: next }));
      requestAnimationFrame(() => {
        const target = textareaRef.current;
        if (target) {
          target.focus();
          target.selectionStart = target.selectionEnd = next.length;
        }
      });
    };
    window.addEventListener('lattice:ai-suggestion-accept', handler);
    return () => window.removeEventListener('lattice:ai-suggestion-accept', handler);
  }, [canEdit, note]);

  if (!note) {
    return (
      <section className="editor editor--empty">
        <div className="empty-state empty-state--large">
          <div className="empty-state__templates" aria-label="从模板创建">
            <div className="empty-state__templates-head">
              <span>从模板创建</span>
              <button type="button" className="btn btn--sm" onClick={onCreateDaily}>每日笔记</button>
            </div>
            {templates.length ? (
              <div className="empty-state__template-list">
                {templates.map((template) => (
                  <button type="button" className="empty-state__template" key={template.name} onClick={() => onCreateFromTemplate?.(template.name)}>
                    <strong>{template.title || template.name}</strong>
                    <small>{template.name}</small>
                  </button>
                ))}
              </div>
            ) : <p className="empty-state__hint">暂无模板，可在 Vault 的 _templates 目录中添加 Markdown 文件。</p>}
          </div>
          <p className="empty-state__title">新标签页</p>
          <div className="empty-state__actions" role="group" aria-label="新标签页操作">
            <button type="button" className="empty-state__action" onClick={onCreateNote}>
              <span>创建新文件</span>
              <kbd>Ctrl + N</kbd>
            </button>
            <button type="button" className="empty-state__action" onClick={onOpenSwitcher}>
              <span>打开文件</span>
              <kbd>Ctrl + K</kbd>
            </button>
            <button type="button" className="empty-state__action empty-state__action--quiet" onClick={onCloseTab}>
              关闭标签页
            </button>
          </div>
          <p className="empty-state__hint">也可以从左侧目录选择笔记，或使用双链和标签组织知识。</p>
        </div>
      </section>
    );
  }

  return (
    <ContextMenu
      label={`笔记「${note.title}」操作`}
      getItems={() => [
        { id: 'pin', label: note.isPinned ? '取消置顶' : '置顶', disabled: isExternal, onSelect: () => onTogglePin(note) },
        { id: 'save', label: '立即保存', shortcut: 'Ctrl+S', disabled: !canEdit, onSelect: () => commit({ silent: false }) },
        { id: 'duplicate', label: '创建副本', disabled: isExternal, onSelect: () => onDuplicate?.(note) },
        { id: 'copy-path', label: '复制路径', disabled: isExternal, onSelect: () => onCopyPath?.(note) },
        { id: 'copy-link', label: '复制双链', disabled: isExternal, onSelect: () => onCopyWikiLink?.(note) },
        { separator: true },
        { id: 'delete', label: '删除笔记', danger: true, disabled: isExternal, onSelect: () => {
          if (window.confirm(`确定删除「${note.title}」吗？此操作不可撤销。`)) onDelete(note.id);
        } },
      ]}
    >
    <section className="editor" aria-label="笔记编辑区">
      <div className="editor__toolbar">
        <div className="segmented segmented--sm" role="tablist" aria-label="编辑模式" style={{ '--seg-active': MODES.findIndex((item) => item.key === mode) }}>
          {MODES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={mode === item.key}
              className={mode === item.key ? 'is-active' : ''}
              onClick={() => setMode(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="editor__toolbar-right">
          <span className={`savestate savestate--${status}`} role="status" aria-live="polite">
            {status === 'saving' && '保存中…'}
            {status === 'saved' && '已保存'}
            {status === 'dirty' && '有未保存修改'}
            {status === 'error' && '保存失败'}
            {status === 'idle' && (isExternal && !canEdit ? '只读' : '已同步')}
          </span>

          {isExternal ? (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={canEdit}
              onClick={() => onRequestExternalWrite?.(note)}
            >
              {canEdit ? '已获得写权限' : '获取写权限'}
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`icon-btn ${note.isPinned ? 'is-on' : ''}`}
                title={note.isPinned ? '取消置顶' : '置顶'}
                onClick={() => onTogglePin(note)}
              >
                ★
              </button>

              <select
                className="select select--sm"
                value={note.folderId ?? ''}
                aria-label="所属目录"
                onChange={(event) => onMove(note.id, event.target.value || null)}
              >
                <option value="">未分类</option>
                {flattenFolders(folders).map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="icon-btn"
                title="插入附件"
                aria-label="插入附件"
                disabled={attachmentBusy}
                onClick={() => attachmentInputRef.current?.click()}
              >
                ↑
              </button>
              <input
                ref={attachmentInputRef}
                className="editor__attachment-input"
                type="file"
                accept="image/*,.pdf,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.mp3,.mp4,.wav,.webm"
                onChange={handleAttachmentUpload}
                disabled={attachmentBusy}
              />

              <button
                type="button"
                className="icon-btn"
                title="导出 HTML"
                aria-label="导出 HTML"
                disabled={exportBusy}
                onClick={handleStaticExport}
              >
                ↓
              </button>

              <button
                type="button"
                className="icon-btn"
                title="版本历史"
                aria-label="版本历史"
                onClick={openHistory}
              >
                ◷
              </button>

              <button
                type="button"
                className="icon-btn icon-btn--danger"
                title="删除这篇笔记"
                onClick={() => {
                  if (window.confirm(`确定删除「${note.title}」吗？此操作不可撤销。`)) onDelete(note.id);
                }}
              >
                删除
              </button>
            </>
          )}
        </div>
      </div>

      {errorMessage ? (
        <div className="banner banner--error">
          <span>{errorMessage}</span>
          <button type="button" className="btn btn--sm" onClick={() => commit({ silent: false })}>
            重试保存
          </button>
        </div>
      ) : null}

      {exportError ? (
        <div className="banner banner--error">
          <span>{exportError}</span>
          <button type="button" className="btn btn--sm" onClick={() => setExportError('')}>Close</button>
        </div>
      ) : null}

      <input
        className="editor__title"
        value={draft.title}
        placeholder="笔记标题"
        maxLength={200}
        aria-label="笔记标题"
        readOnly={isExternal}
        onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
      />

      {!isExternal ? (
        <details className="editor__properties">
          <summary>属性 <span>{Object.keys(draft.properties ?? {}).length}</span></summary>
          <div className="editor__properties-list">
            {Object.entries(draft.properties ?? {}).map(([key, value]) => (
              <div className="editor__property" key={key}>
                <input
                  value={key}
                  aria-label={`属性名 ${key}`}
                  onChange={(event) => renameProperty(key, event.target.value)}
                />
                <input
                  value={formatPropertyValue(value)}
                  aria-label={`属性值 ${key}`}
                  onChange={(event) => updateProperty(key, event.target.value)}
                />
                <button type="button" className="icon-btn icon-btn--danger" title="删除属性" aria-label={`删除属性 ${key}`} onClick={() => removeProperty(key)}>×</button>
              </div>
            ))}
            <button type="button" className="btn btn--sm" onClick={addProperty}>添加属性</button>
          </div>
        </details>
      ) : null}

      {outline.length ? (
        <details className="editor__outline" open>
          <summary>文档大纲 <span>{outline.length}</span></summary>
          <nav aria-label="文档大纲">
            {outline.map((heading) => (
              <button
                key={`${heading.start}-${heading.index}`}
                type="button"
                className="editor__outline-item"
                style={{ '--outline-level': heading.level }}
                onClick={() => jumpToHeading(heading)}
              >
                {heading.text}
              </button>
            ))}
          </nav>
        </details>
      ) : null}

      {mode !== 'preview' ? (
        <div className="ai-write" aria-label="AI 写作助手">
          <div className="ai-write__bar">
            <span className="ai-write__mark">✦ AI 写作</span>
            {selection.text.trim() ? <span className="ai-write__hint">已选中 {selection.text.length} 字</span> : null}
            <div className="ai-write__actions">
              {selection.text.trim() ? (
                <>
                  <button type="button" disabled={assistBusy || !canEdit} onClick={() => runWriteAssist('润色', '润色这段文字：提升流畅度与表达，保持原意、篇幅与格式', 'rewrite')}>润色</button>
                  <button type="button" disabled={assistBusy || !canEdit} onClick={() => runWriteAssist('摘要', '把这段文字压缩成一段简洁的摘要，保留关键信息', 'rewrite')}>摘要</button>
                  <button type="button" disabled={assistBusy || !canEdit} onClick={() => runWriteAssist('译成中文', '翻译成流畅的简体中文', 'rewrite')}>译中</button>
                  <button type="button" disabled={assistBusy || !canEdit} onClick={() => runWriteAssist('译成英文', 'Translate into natural English', 'rewrite')}>译英</button>
                </>
              ) : (
                <>
                  <button type="button" disabled={assistBusy || !canEdit} onClick={() => runWriteAssist('从标题写全文', '围绕笔记标题写一篇结构完整的文章草稿：开头引入、分节展开、结尾总结', 'create')}>从标题写全文</button>
                  <button type="button" disabled={assistBusy || !canEdit} onClick={() => runWriteAssist('头脑风暴', '围绕笔记标题头脑风暴：给出 10 个创意点子、切入角度或大纲方向，用清单输出', 'create')}>头脑风暴</button>
                  <button type="button" disabled={assistBusy || !canEdit || !draft.content.trim()} onClick={() => runWriteAssist('续写', '接着这段内容自然续写，保持语气、人称与 Markdown 格式', 'continue')}>续写</button>
                </>
              )}
            </div>
            <form
              className="ai-write__custom"
              onSubmit={(event) => {
                event.preventDefault();
                if (!customInstruction.trim()) return;
                const hasSelection = selection.text.trim().length > 0;
                runWriteAssist('自定义', customInstruction.trim(), hasSelection ? 'rewrite' : 'create');
              }}
            >
              <input
                value={customInstruction}
                onChange={(event) => setCustomInstruction(event.target.value)}
                placeholder={selection.text.trim() ? '对选中内容的指令，如：改成清单格式…' : '想写什么？如：写一条产品发布文案…'}
                aria-label="自定义写作指令"
                maxLength={200}
                disabled={assistBusy || !canEdit}
              />
              <button type="submit" disabled={assistBusy || !canEdit || !customInstruction.trim()}>运行</button>
            </form>
          </div>

          {assist ? (
            <div className="ai-write__preview" role="status">
              <header>
                <strong>{assist.label}{assist.done ? ' · 完成' : ' · 生成中…'}</strong>
                <span className="ai-write__preview-actions">
                  {assist.done
                    ? (
                      <>
                        {assist.mode === 'create'
                          ? (
                            <>
                              <button type="button" className="btn btn--sm" onClick={() => applyAssistResult(assist.result, 'append')} disabled={!canEdit || !assist.result.trim()}>追加到末尾</button>
                              <button type="button" className="btn btn--sm is-primary" onClick={acceptAssist} disabled={!canEdit || !assist.result.trim()}>替换全文</button>
                            </>
                          )
                          : (
                            <>
                              <button type="button" className="btn btn--sm" onClick={() => setAssist(null)}>丢弃</button>
                              <button type="button" className="btn btn--sm is-primary" onClick={acceptAssist} disabled={!canEdit || !assist.result.trim()}>接受并写入</button>
                            </>
                          )}
                      </>
                    )
                    : <button type="button" className="btn btn--sm" onClick={() => assistAbortRef.current?.abort()}>停止</button>}
                </span>
              </header>
              {assist.error
                ? <p className="ai-write__error" role="alert">{assist.error}</p>
                : <div className="ai-write__text markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(assist.streamText || assist.result || '…') }} />}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        ref={bodyRef}
        className={`editor__body mode-${mode}`}
        style={mode === 'split' ? { gridTemplateColumns: `minmax(0, ${splitRatio}fr) minmax(0, ${100 - splitRatio}fr)` } : undefined}
      >
        {mode !== 'preview' ? (
          <textarea
            ref={textareaRef}
            className="editor__textarea"
            value={draft.content}
            spellCheck={false}
            readOnly={!canEdit}
            placeholder={'开始写作…\n\n用 [[标题]] 建立双链，用 #标签 归类，独占一行的 ![[标题]] 会展开为嵌入。'}
            aria-label="笔记正文"
            onChange={(event) => {
              if (canEdit) setDraft((current) => ({ ...current, content: event.target.value }));
            }}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            onSelect={syncSelection}
            onMouseUp={syncSelection}
          />
        ) : null}

        {mode === 'split' ? (
          <Resizer
            className="pane-resizer--split"
            label="编辑 / 预览分栏"
            style={{ '--split-pos': `${splitRatio}%` }}
            onDrag={resizeSplit}
            onReset={resetSplit}
          />
        ) : null}

        {mode !== 'edit' ? (
          <div className="editor__preview" ref={previewRef}>
            <MarkdownPreview
              content={draft.content}
              resolveTitle={resolveTitle}
              resolveAsset={resolveAsset}
              resolveEmbed={resolveEmbed}
              onOpenWikiLink={onOpenWikiLink}
              onCreateWikiLink={onCreateWikiLink}
            />
          </div>
        ) : null}
      </div>

      <div className="editor__statusbar">
        <span>{formatNumber(stats.words)} 字</span>
        <span>{formatNumber(stats.lines)} 行</span>
        <span>{formatNumber(stats.chars)} 字符</span>
        <span className="editor__statusbar-spacer" />
        <span>创建于 {formatDateTime(note.createdAt)}</span>
        <span>更新于 {formatDateTime(note.updatedAt)}</span>
      </div>
    </section>
    <Modal open={historyState.open} onClose={() => setHistoryState((current) => ({ ...current, open: false }))} title="版本历史" ariaLabel="版本历史">
      <div className="history-modal">
        {historyState.error ? <div className="banner banner--error">{historyState.error}</div> : null}
        {historyState.loading ? <div className="empty-state__hint">正在加载版本历史…</div> : null}
        {!historyState.loading && !historyState.items.length ? <div className="empty-state__hint">还没有可恢复的历史版本</div> : null}
        <div className="history-modal__body">
          <div className="history-modal__list">
            {historyState.items.map((item) => (
              <button
                key={item.version}
                type="button"
                className={`history-modal__item ${historyState.selected?.version === item.version ? 'is-selected' : ''}`}
                onClick={() => selectHistoryVersion(item.version)}
              >
                <strong>{new Date(item.createdAt).toLocaleString()}</strong>
                <small>{Math.ceil(item.size / 1024)} KB</small>
              </button>
            ))}
          </div>
          {historyState.selected ? (
            <div className="history-modal__preview">
              <div className="history-modal__preview-head">
                <strong>{historyState.selected.title}</strong>
                <button type="button" className="btn btn--sm btn--primary" onClick={restoreSelectedHistory}>恢复此版本</button>
              </div>
              <pre>{historyState.selected.content}</pre>
            </div>
          ) : <div className="history-modal__preview history-modal__preview--empty">选择一个版本查看内容</div>}
        </div>
      </div>
    </Modal>
    </ContextMenu>
  );
}

/** 把目录树摊平成带缩进前缀的下拉选项 */
export function flattenFolders(nodes, depth = 0, output = []) {
  for (const node of nodes ?? []) {
    output.push({ id: node.id, label: `${'　'.repeat(depth)}${node.name}` });
    if (node.children?.length) flattenFolders(node.children, depth + 1, output);
  }
  return output;
}

function triggerHtmlDownload(title, html) {
  const safeTitle = String(title || 'note').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'note';
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeTitle}.html`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatPropertyValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value === null || value === undefined ? '' : String(value);
}

function propertiesEqual(left, right) {
  const normalize = (value) => Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
