import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownPreview from './MarkdownPreview.jsx';
import { formatDateTime, formatNumber } from '../lib/format.js';
import ContextMenu from '../ui/ContextMenu.jsx';
import Resizer from '../ui/Resizer.jsx';
import { loadLayout, saveLayout } from '../lib/layout.js';
import { loadSettings, subscribeSettings } from '../settings/settings.js';

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
  onDelete,
  onTogglePin,
  onMove,
  onOpenWikiLink,
  onCreateWikiLink,
  registerNavigationGuard,
  onCreateNote,
  onOpenSwitcher,
  onCloseTab,
  onDuplicate,
  onCopyPath,
  onCopyWikiLink,
}) {
  const [draft, setDraft] = useState(() => ({ title: note?.title ?? '', content: note?.content ?? '' }));
  const [settings, setSettings] = useState(() => loadSettings());
  const [mode, setMode] = useState(() => loadSettings().editorMode);
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const noteIdRef = useRef(note?.id ?? null);
  const draftRef = useRef(draft);
  const textareaRef = useRef(null);
  const previewRef = useRef(null);
  const bodyRef = useRef(null);
  const [splitRatio, setSplitRatio] = useState(() => loadLayout().split);

  // 分栏边界：dx 按编辑区实际宽度换算成百分比，收敛与持久化交给 layout.js
  const resizeSplit = (dx) => {
    const width = bodyRef.current?.clientWidth ?? 0;
    if (!width) return;
    setSplitRatio((current) => saveLayout({ ...loadLayout(), split: current + (dx / width) * 100 }).split);
  };
  const resetSplit = () => setSplitRatio((current) => saveLayout({ ...loadLayout(), split: 50 }).split);

  draftRef.current = draft;

  const dirty = Boolean(note) && (draft.title !== note.title || draft.content !== note.content);

  useEffect(() => subscribeSettings((next) => {
    setSettings(next);
    setMode(next.editorMode);
  }), []);

  /** 切换笔记时重置草稿；同一篇笔记的回写不覆盖用户正在输入的内容 */
  useEffect(() => {
    const nextId = note?.id ?? null;
    if (noteIdRef.current === nextId) return;
    noteIdRef.current = nextId;
    setDraft({ title: note?.title ?? '', content: note?.content ?? '' });
    setStatus('idle');
    setErrorMessage('');
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

  // 防抖自动保存
  useEffect(() => {
    if (!dirty || !settings.autoSave) return undefined;
    setStatus((current) => (current === 'saving' ? current : 'dirty'));

    const timer = setTimeout(() => commit(), Number(settings.autoSaveDelay));
    return () => clearTimeout(timer);
  }, [draft.title, draft.content, dirty, commit, settings.autoSave, settings.autoSaveDelay]);

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

  if (!note) {
    return (
      <section className="editor editor--empty">
        <div className="empty-state empty-state--large">
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
        { id: 'pin', label: note.isPinned ? '取消置顶' : '置顶', onSelect: () => onTogglePin(note) },
        { id: 'save', label: '立即保存', shortcut: 'Ctrl+S', onSelect: () => commit({ silent: false }) },
        { id: 'duplicate', label: '创建副本', onSelect: () => onDuplicate?.(note) },
        { id: 'copy-path', label: '复制路径', onSelect: () => onCopyPath?.(note) },
        { id: 'copy-link', label: '复制双链', onSelect: () => onCopyWikiLink?.(note) },
        { separator: true },
        { id: 'delete', label: '删除笔记', danger: true, onSelect: () => {
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
            {status === 'idle' && '已同步'}
          </span>

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
            className="icon-btn icon-btn--danger"
            title="删除这篇笔记"
            onClick={() => {
              if (window.confirm(`确定删除「${note.title}」吗？此操作不可撤销。`)) onDelete(note.id);
            }}
          >
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
            placeholder={'开始写作…\n\n用 [[标题]] 建立双链，用 #标签 归类，独占一行的 ![[标题]] 会展开为嵌入。'}
            aria-label="笔记正文"
            onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
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
