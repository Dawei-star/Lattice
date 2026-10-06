import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { encodeMarkdownUrlReference, markdownLinkLabel, relativeAttachmentReference, resolveAttachmentPath, vaultAttachmentsApi, vaultFiles } from '../api/vault-files.js';
import { buildStaticHtml } from '../lib/static-export.js';
import { getClipboardImageFiles } from '../lib/clipboard.js';
import { BookOpenText, Bug, CalendarDays, Download, FilePlus2, History, ImagePlus, Inbox, Pin, RefreshCw, Search, Scale, Trash2, UsersRound } from 'lucide-react';

const MODES = [
  { key: 'edit', label: '编辑' },
  { key: 'split', label: '分栏' },
  { key: 'preview', label: '预览' },
];

const BUILTIN_TEMPLATE_META = Object.freeze({
  bug: { label: 'Bug', description: '现象、复现步骤与根因', icon: Bug },
  decision: { label: '技术决策', description: '背景、方案与影响', icon: Scale },
  meeting: { label: '会议记录', description: '参与者、讨论与行动项', icon: UsersRound },
  learning: { label: '学习记录', description: '问题、结论与示例', icon: BookOpenText },
  retrospective: { label: '项目复盘', description: '做得好、问题与下一步', icon: RefreshCw },
});

function getTemplateMeta(template) {
  const key = template?.name?.toLowerCase();
  return BUILTIN_TEMPLATE_META[key] ?? {
    label: template?.title || template?.name,
    description: template?.name,
    icon: CalendarDays,
  };
}

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
  registerDirtyProbe,
  onCreateNote,
  onCaptureInbox,
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
  // 乐观锁冲突：服务端返回 409（笔记已被其他窗口修改）时置位，
  // 横幅提供「仍要保存」的显式覆盖入口；普通重试仍携带版本校验
  const [conflict, setConflict] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentNotice, setAttachmentNotice] = useState('');
  const [historyState, setHistoryState] = useState({ open: false, loading: false, items: [], currentHash: '', selected: null, error: '' });
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  const [templates, setTemplates] = useState([]);

  const noteIdRef = useRef(note ? `${note.id}:${note.externalRevision ?? ''}` : null);
  const previousNoteRef = useRef(note);
  const draftRef = useRef(draft);
  const textareaRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const attachmentNoticeTimerRef = useRef(0);
  const previewRef = useRef(null);
  const bodyRef = useRef(null);
  const [splitRatio, setSplitRatio] = useState(() => loadLayout().split);
  const isExternal = Boolean(note?.external);
  const canEdit = !isExternal || externalWriteGranted;
  const announceAttachment = useCallback((message) => {
    window.clearTimeout(attachmentNoticeTimerRef.current);
    setAttachmentNotice(message);
    if (message) attachmentNoticeTimerRef.current = window.setTimeout(() => setAttachmentNotice(''), 2400);
  }, []);
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
  // useLayoutEffect：必须在浏览器有机会派发用户输入事件之前同步对齐草稿。
  // 若用异步 useEffect，用户在「渲染提交」与「effect 执行」的间隙里输入的内容
  // 会被这里的 setDraft 按旧值覆盖（自动保存/改名往返时是真实发生的竞态）
  useLayoutEffect(() => {
    const previousNote = previousNoteRef.current;
    const nextId = note ? `${note.id}:${note.externalRevision ?? ''}` : null;
    if (noteIdRef.current !== nextId) {
      noteIdRef.current = nextId;
      setDraft({ title: note?.title ?? '', content: note?.content ?? '', properties: note?.properties ?? {} });
      setStatus('idle');
      setErrorMessage('');
      setConflict(false);
      setAttachmentError('');
      setAttachmentNotice('');
    } else if (
      note
      && previousNote?.id === note.id
      && previousNote.title !== note.title
      && (draftRef.current.title === previousNote.title || previousNote.filePath !== note.filePath)
    ) {
      // A context-menu rename updates the note outside the editor. Keep the
      // local draft aligned so the next autosave cannot restore the old title.
      setDraft((current) => ({ ...current, title: note.title }));
    }
    previousNoteRef.current = note;
  }, [note]);

  useEffect(() => () => window.clearTimeout(attachmentNoticeTimerRef.current), []);

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
      // 先把草稿同步为恢复后的内容：否则防抖自动保存会用旧草稿把刚恢复的版本覆盖回去
      setDraft({ title: selected.title ?? '', content: selected.content ?? '', properties: selected.properties ?? {} });
      setHistoryState((current) => ({ ...current, open: false, selected: null }));
      await onSave(note.id, { title: selected.title, content: selected.content, isPinned: selected.isPinned, properties: selected.properties ?? {} });
    } catch (error) {
      setHistoryState((current) => ({ ...current, error: error?.message ?? '恢复版本失败' }));
    }
  }, [historyState.currentHash, historyState.selected, note, onSave]);

  const commit = useCallback(
    async ({ silent = true, force = false } = {}) => {
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

      // 乐观锁：携带读取时的版本哈希；仅「仍要保存」的显式覆盖跳过校验
      if (!force && note.contentHash) patch.expectedHash = note.contentHash;

      setStatus('saving');
      try {
        await onSave(note.id, patch);
        setStatus('saved');
        setErrorMessage('');
        setConflict(false);
      } catch (error) {
        setStatus('error');
        setErrorMessage(error?.message ?? '保存失败，请重试');
        setConflict(error?.status === 409 || error?.code === 'CONFLICT');
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

  // 切换笔记前拦截未保存内容；同时注册无副作用的"脏状态"探针，
  // 供 SSE 外部更新判断能否自动刷新（见 useVault）
  useEffect(() => {
    const hasPendingChanges = () => {
      const current = draftRef.current;
      if (!note) return false;
      return current.title !== note.title || current.content !== note.content || !propertiesEqual(current.properties, note.properties);
    };
    registerNavigationGuard?.(() => {
      if (!hasPendingChanges()) return true;
      return window.confirm('这篇笔记还有未保存的修改，确定要离开吗？');
    });
    registerDirtyProbe?.(hasPendingChanges);
    return () => {
      registerNavigationGuard?.(null);
      registerDirtyProbe?.(null);
    };
  }, [note, registerDirtyProbe, registerNavigationGuard]);

  // 快捷键：Ctrl/Cmd + S 立即保存，Ctrl/Cmd + E 切换模式
  useEffect(() => {
    const handler = (event) => {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        commit({ silent: false }).catch(() => {});
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
    setAttachmentError('');
    announceAttachment('正在上传附件…');
    try {
      // 按当前笔记归组存放（Yank Note 式），便于按笔记查找附件
      const uploaded = await vaultAttachmentsApi.upload(file, { query: { folder: note.title } });
      const reference = encodeMarkdownUrlReference(relativeAttachmentReference(note.filePath, uploaded.path));
      const label = markdownLinkLabel(uploaded.name ?? file.name);
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
      announceAttachment(file.type.startsWith('image/') ? '图片已插入' : '附件已插入');
      requestAnimationFrame(() => {
        const target = textareaRef.current;
        if (!target) return;
        target.focus();
        target.selectionStart = target.selectionEnd = start + syntax.length;
      });
    } catch (error) {
      setAttachmentError(error?.message ?? '附件上传失败');
      announceAttachment('附件插入失败');
    } finally {
      setAttachmentBusy(false);
    }
  }, [announceAttachment, canEdit, isExternal, note, selection.end, selection.start]);

  const handlePaste = useCallback(async (event) => {
    const files = getClipboardImageFiles(event.clipboardData);
    if (!files.length || !note || !canEdit || isExternal) return;

    if (attachmentBusy) {
      // 上传中粘贴的图片不能被 preventDefault 后静默吞掉（内容直接丢失）；
      // 不拦截默认行为（文本照常粘贴），并明确告知用户原因
      setAttachmentError('正在上传上一批图片，请等上传完成后再粘贴');
      announceAttachment('正在上传上一批图片，请等上传完成后再粘贴');
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget;
    const value = draftRef.current.content;
    const targetStart = Number.isInteger(target?.selectionStart) ? target.selectionStart : selection.start;
    const targetEnd = Number.isInteger(target?.selectionEnd) ? target.selectionEnd : selection.end;
    const start = Math.min(Math.max(targetStart, 0), value.length);
    const end = Math.min(Math.max(targetEnd, start), value.length);

    setAttachmentBusy(true);
    setAttachmentError('');
    announceAttachment(files.length === 1 ? '正在上传图片…' : `正在上传 ${files.length} 张图片…`);
    try {
      const syntaxParts = [];
      for (const file of files) {
        // 按当前笔记归组存放（Yank Note 式），便于按笔记查找附件
        const uploaded = await vaultAttachmentsApi.upload(file, { query: { folder: note.title } });
        const reference = encodeMarkdownUrlReference(relativeAttachmentReference(note.filePath, uploaded.path));
        const label = markdownLinkLabel(uploaded.name ?? file.name);
        syntaxParts.push(`![${label}](${reference})`);
      }
      const syntax = `${syntaxParts.join('\n')}\n`;
      const next = `${value.slice(0, start)}${syntax}${value.slice(end)}`;
      setDraft((current) => ({ ...current, content: next }));
      setSelection({ start: start + syntax.length, end: start + syntax.length, text: '' });
      setErrorMessage('');
      announceAttachment(files.length === 1 ? '图片已插入' : `${files.length} 张图片已插入`);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + syntax.length;
      });
    } catch (error) {
      setAttachmentError(error?.message ?? '图片导入失败');
      announceAttachment('图片插入失败');
    } finally {
      setAttachmentBusy(false);
    }
  }, [announceAttachment, attachmentBusy, canEdit, isExternal, note, selection.end, selection.start]);

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
      // 主动「停止」（AbortError）不是故障：直接收起预览面板。否则面板停在
      // error 态只剩失效的停止按钮，assistBusy 也卡死所有 AI 按钮直到切换笔记。
      if (requestError?.name === 'AbortError') {
        setAssist(null);
        return;
      }
      // 其他错误置 done：让完成分支的「丢弃」按钮可用来关闭面板、解除 busy
      setAssist((current) => (current ? { ...current, done: true, error: requestError?.message ?? '写作助手调用失败' } : current));
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
          <div className="empty-state__intro">
            <span className="empty-state__eyebrow">WORKSPACE / START HERE</span>
            <h1>从一个下一步开始</h1>
            <p>把想法先放进 Inbox，或直接用开发者模板开始工作。</p>
          </div>
          <div className="empty-state__actions" role="group" aria-label="新标签页操作">
            <button type="button" className="empty-state__action" onClick={() => onCreateNote?.()}>
              <span className="empty-state__action-icon" aria-hidden="true"><FilePlus2 size={17} strokeWidth={1.8} /></span>
              <span className="empty-state__action-copy"><strong>新建笔记</strong><small>从空白页面开始</small></span>
              <kbd>Ctrl + N</kbd>
            </button>
            <button type="button" className="empty-state__action" onClick={() => onCaptureInbox?.()}>
              <span className="empty-state__action-icon" aria-hidden="true"><Inbox size={17} strokeWidth={1.8} /></span>
              <span className="empty-state__action-copy"><strong>收集到 Inbox</strong><small>先记录，再整理</small></span>
              <kbd>Ctrl + Shift + I</kbd>
            </button>
            <button type="button" className="empty-state__action" onClick={() => onOpenSwitcher?.()}>
              <span className="empty-state__action-icon" aria-hidden="true"><Search size={17} strokeWidth={1.8} /></span>
              <span className="empty-state__action-copy"><strong>打开笔记</strong><small>搜索已有知识</small></span>
              <kbd>Ctrl + K</kbd>
            </button>
          </div>
          <div className="empty-state__templates" aria-label="从模板创建">
            <div className="empty-state__templates-head">
              <span>从模板创建</span>
              <button type="button" className="btn btn--sm" onClick={onCreateDaily}>每日笔记</button>
            </div>
            {templates.length ? (
              <div className="empty-state__template-list">
                {templates.map((template) => {
                  const meta = getTemplateMeta(template);
                  const Icon = meta.icon;
                  return (
                    <button type="button" className="empty-state__template" key={template.name} onClick={() => onCreateFromTemplate?.(template.name)}>
                      <span className="empty-state__template-icon" aria-hidden="true"><Icon size={16} strokeWidth={1.8} /></span>
                      <span className="empty-state__template-copy">
                        <strong>{meta.label}</strong>
                        <small>{meta.description}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : <p className="empty-state__hint">暂无模板，可在 Vault 的 _templates 目录中添加 Markdown 文件。</p>}
          </div>
          <button type="button" className="empty-state__close" onClick={onCloseTab}>关闭新标签页</button>
        </div>
      </section>
    );
  }

  return (
    <ContextMenu
      label={`笔记「${note.title}」操作`}
      getItems={() => [
        { id: 'pin', label: note.isPinned ? '取消置顶' : '置顶', disabled: isExternal, onSelect: () => onTogglePin(note) },
        { id: 'save', label: '立即保存', shortcut: 'Ctrl+S', disabled: !canEdit, onSelect: () => commit({ silent: false }).catch(() => {}) },
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
                <Pin size={15} strokeWidth={1.8} aria-hidden="true" />
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
                title="插入附件，也可以直接粘贴图片"
                aria-label="插入附件"
                disabled={attachmentBusy}
                onClick={() => attachmentInputRef.current?.click()}
              >
                <ImagePlus size={15} strokeWidth={1.8} />
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
                <Download size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>

              <button
                type="button"
                className="icon-btn"
                title="版本历史"
                aria-label="版本历史"
                onClick={openHistory}
              >
                <History size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>

              <button
                type="button"
                className="icon-btn icon-btn--danger"
                title="删除这篇笔记"
                aria-label="删除这篇笔记"
                onClick={() => {
                  if (window.confirm(`确定删除「${note.title}」吗？此操作不可撤销。`)) onDelete(note.id);
                }}
              >
                <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>

      {errorMessage ? (
        <div className="banner banner--error">
          <span>{errorMessage}</span>
          {conflict ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => commit({ force: true, silent: false }).catch(() => {})}
            >
              仍要保存（覆盖磁盘版本）
            </button>
          ) : (
            <button type="button" className="btn btn--sm" onClick={() => commit({ silent: false }).catch(() => {})}>
              重试保存
            </button>
          )}
        </div>
      ) : null}

      {exportError ? (
        <div className="banner banner--error">
          <span>{exportError}</span>
          <button type="button" className="btn btn--sm" onClick={() => setExportError('')}>关闭</button>
        </div>
      ) : null}

      {attachmentError ? (
        <div className="banner banner--error">
          <span>{attachmentError}</span>
          <button type="button" className="btn btn--sm" onClick={() => setAttachmentError('')}>关闭</button>
        </div>
      ) : null}

      <input
        className="editor__title"
        value={draft.title}
        placeholder="笔记标题"
        maxLength={200}
        aria-label="笔记标题"
        readOnly={isExternal}
        onChange={(event) => {
          // 值必须在这里同步捕获：React 18 里 updater 可能延迟/多次执行，
          // 届时受控输入的 DOM value 已被恢复成旧 state，读到的是旧标题，
          // 会把用户刚输入的内容静默改回去（自动保存往返时尤其容易触发）
          const { value } = event.target;
          setDraft((current) => ({ ...current, title: value }));
        }}
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
                <strong>{assist.label}{assist.error ? ' · 失败' : (assist.done ? ' · 完成' : ' · 生成中…')}</strong>
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
            aria-busy={attachmentBusy}
            placeholder={'开始写作…\n\n用 [[标题]] 建立双链，用 #标签 归类，独占一行的 ![[标题]] 会展开为嵌入。'}
            aria-label="笔记正文"
            onChange={(event) => {
              // 与标题输入同理：同步捕获值，updater 内不能读 event.target
              if (canEdit) {
                const { value } = event.target;
                setDraft((current) => ({ ...current, content: value }));
              }
            }}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
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
        {attachmentNotice ? <span className={`editor__statusbar-note ${attachmentBusy ? 'is-busy' : ''}`} role="status">{attachmentNotice}</span> : null}
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
