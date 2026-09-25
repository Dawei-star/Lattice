import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attachmentsApi } from '../api/resources.js';
import MarkdownPreview from './MarkdownPreview.jsx';
import VersionHistory from './VersionHistory.jsx';
import { PinIcon } from './NoteListPane.jsx';
import { ClockIcon, ImageIcon, TrashIcon } from './icons.jsx';
import { formatDateTime, formatNumber } from '../lib/format.js';

const AUTOSAVE_DELAY_MS = 900;
// 与后端 attachments.service 的白名单保持一致
const ACCEPTED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'application/pdf',
]);
const MODES = [
  { key: 'edit', label: '编辑' },
  { key: 'split', label: '分栏' },
  { key: 'preview', label: '预览' },
];

/**
 * 编辑区。
 *
 * 保存策略：本地草稿 + 防抖自动保存（900ms 静默即存），并额外提供 Ctrl/Cmd + S 立即保存。
 * 只有 title / content 与当前笔记不同才会发请求，避免自动保存空转刷新 updated_at。
 */
export default function EditorPane({
  note,
  folders,
  resolveTitle,
  resolveEmbed,
  onSave,
  onDelete,
  onTogglePin,
  onMove,
  onOpenWikiLink,
  onCreateWikiLink,
  onRestoreVersion,
  registerNavigationGuard,
}) {
  const [draft, setDraft] = useState(() => ({ title: note?.title ?? '', content: note?.content ?? '' }));
  const [mode, setMode] = useState('split');
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const noteIdRef = useRef(note?.id ?? null);
  const draftRef = useRef(draft);
  const textareaRef = useRef(null);
  const previewRef = useRef(null);
  const fileInputRef = useRef(null);

  draftRef.current = draft;

  const dirty = Boolean(note) && (draft.title !== note.title || draft.content !== note.content);

  /** 切换笔记时重置草稿；同一篇笔记的回写不覆盖用户正在输入的内容 */
  useEffect(() => {
    const nextId = note?.id ?? null;
    if (noteIdRef.current === nextId) return;
    noteIdRef.current = nextId;
    setDraft({ title: note?.title ?? '', content: note?.content ?? '' });
    setStatus('idle');
    setErrorMessage('');
    setHistoryOpen(false);
  }, [note]);

  const commit = useCallback(
    async ({ silent = true } = {}) => {
      if (!note) return;

      const patch = {};
      const trimmedTitle = draftRef.current.title.trim();
      // 标题为空时不提交：服务端会拒绝空标题，此时只保存正文
      if (trimmedTitle && trimmedTitle !== note.title) patch.title = trimmedTitle;
      if (draftRef.current.content !== note.content) patch.content = draftRef.current.content;

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
    [note, onSave],
  );

  /**
   * 恢复某个历史版本。App 层负责落库并刷新列表/图谱，返回恢复后的完整笔记。
   * 这里必须把编辑器草稿同步成恢复后的内容——因为笔记 id 没变，
   * 上方「按 id 变化重置草稿」的 effect 不会触发，不手动同步就会停在旧草稿。
   */
  const handleRestoreVersion = useCallback(
    async (versionId) => {
      const restored = await onRestoreVersion?.(note.id, versionId);
      if (!restored) return;
      setDraft({ title: restored.title ?? '', content: restored.content ?? '' });
      draftRef.current = { title: restored.title ?? '', content: restored.content ?? '' };
      setStatus('saved');
      setErrorMessage('');
      setHistoryOpen(false);
    },
    [note, onRestoreVersion],
  );

  // 防抖自动保存
  useEffect(() => {
    if (!dirty) return undefined;
    setStatus((current) => (current === 'saving' ? current : 'dirty'));

    const timer = setTimeout(() => commit(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft.title, draft.content, dirty, commit]);

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
      const hasChanges = current.title !== note.title || current.content !== note.content;
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
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const { selectionStart, selectionEnd, value } = event.currentTarget;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    setDraft((current) => ({ ...current, content: next }));
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (target) target.selectionStart = target.selectionEnd = selectionStart + 2;
    });
  };

  /** 在光标处插入 Markdown 图片/链接语法，并把光标移到其后 */
  const insertAtCursor = useCallback((snippet) => {
    const area = textareaRef.current;
    const start = area?.selectionStart ?? draftRef.current.content.length;
    const end = area?.selectionEnd ?? start;
    const value = draftRef.current.content;
    const next = `${value.slice(0, start)}${snippet}${value.slice(end)}`;
    setDraft((current) => ({ ...current, content: next }));
    draftRef.current = { ...draftRef.current, content: next };
    const caret = start + snippet.length;
    requestAnimationFrame(() => {
      if (!area) return;
      area.focus();
      area.selectionStart = area.selectionEnd = caret;
    });
  }, []);

  /**
   * 处理一批待插入的文件：过滤到受支持类型 → 逐个上传 → 插入 Markdown 图片语法。
   * PDF 用普通链接语法，图片用 ![..](..) 以便预览内嵌渲染。
   */
  const handleFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList ?? []).filter((file) => ACCEPTED_TYPES.has(file.type));
      if (files.length === 0) return;

      setAttaching(true);
      setErrorMessage('');
      try {
        for (const file of files) {
          const attachment = await attachmentsApi.upload(file);
          const safeName = (attachment.name ?? '').replace(/[[\]()]/g, '');
          const snippet =
            attachment.mime === 'application/pdf'
              ? `[${safeName}](${attachment.url})`
              : `![${safeName}](${attachment.url})`;
          insertAtCursor(snippet);
        }
      } catch (error) {
        setErrorMessage(error?.message ?? '附件上传失败，请重试');
      } finally {
        setAttaching(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [insertAtCursor],
  );

  const handlePaste = useCallback(
    (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      handleFiles(files);
    },
    [handleFiles],
  );

  const handleDrop = useCallback(
    (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      handleFiles(files);
    },
    [handleFiles],
  );

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

  if (!note) {
    return (
      <section className="editor editor--empty">
        <div className="empty-state empty-state--large">
          <p className="empty-state__title">选择一篇笔记开始</p>
          <p className="empty-state__hint">
            从左侧挑选一篇，或者直接新建。用 <code>[[双链]]</code> 连接笔记，用 <code>#标签</code> 归类。
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="editor" aria-label="笔记编辑区">
      <div className="editor__toolbar">
        <div className="segmented segmented--sm" role="tablist" aria-label="编辑模式">
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
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/avif,application/pdf"
            multiple
            hidden
            onChange={(event) => handleFiles(event.target.files)}
          />
          <button
            type="button"
            className="btn btn--sm"
            title="插入图片或附件（也可直接粘贴 / 拖拽）"
            disabled={attaching}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImageIcon />
            {attaching ? '上传中' : '图片'}
          </button>

          <button
            type="button"
            className="btn btn--sm"
            title="查看这篇笔记的历史版本"
            onClick={() => setHistoryOpen(true)}
          >
            <ClockIcon />
            历史
          </button>

          <span className={`savestate savestate--${status}`}>
            {status === 'saving' && '保存中…'}
            {status === 'saved' && '已保存'}
            {status === 'dirty' && '有未保存修改'}
            {status === 'error' && '保存失败'}
            {status === 'idle' && '已同步'}
          </span>

          <button
            type="button"
            className={`icon-btn ${note.isPinned ? 'is-pin-on' : ''}`}
            title={note.isPinned ? '取消置顶' : '置顶'}
            onClick={() => onTogglePin(note)}
          >
            <PinIcon filled={note.isPinned} />
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
            className="btn btn--sm btn--danger"
            title="删除这篇笔记"
            onClick={() => {
              if (window.confirm(`确定删除「${note.title}」吗？此操作不可撤销。`)) onDelete(note.id);
            }}
          >
            <TrashIcon />
            删除
          </button>
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

      <input
        className="editor__title"
        value={draft.title}
        placeholder="笔记标题"
        maxLength={200}
        aria-label="笔记标题"
        onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
      />

      <div className={`editor__body mode-${mode}`} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
        {mode !== 'preview' ? (
          <textarea
            ref={textareaRef}
            className="editor__textarea"
            value={draft.content}
            spellCheck={false}
            placeholder={'开始写作…\n\n用 [[标题]] 建立双链，用 #标签 归类，独占一行的 ![[标题]] 会展开为嵌入。'}
            aria-label="笔记正文"
            onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        ) : null}

        {mode !== 'edit' ? (
          <div className="editor__preview" ref={previewRef}>
            <MarkdownPreview
              content={draft.content}
              resolveTitle={resolveTitle}
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

      <VersionHistory
        open={historyOpen}
        note={note}
        onClose={() => setHistoryOpen(false)}
        onRestore={handleRestoreVersion}
      />
    </section>
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
