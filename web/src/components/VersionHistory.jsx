import { useCallback, useEffect, useState } from 'react';
import { versionsApi } from '../api/resources.js';
import { formatDateTime, formatNumber, formatRelativeTime } from '../lib/format.js';
import { CloseIcon } from './icons.jsx';

/**
 * 版本历史弹窗：列出当前笔记的历史快照，选中即在右侧预览其正文，一键恢复。
 *
 * 「版本」保存的是被覆盖前的旧状态，恢复会把所选状态写回当前，
 * 同时把恢复前的内容也存成一条历史，因此恢复本身可再次撤销。
 */
export default function VersionHistory({ open, note, onClose, onRestore }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const noteId = note?.id ?? null;

  useEffect(() => {
    if (!open || !noteId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setSelectedId(null);
    setPreview(null);
    versionsApi
      .list(noteId)
      .then((list) => {
        if (cancelled) return;
        setItems(list ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? '加载历史失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, noteId]);

  const handleSelect = useCallback(
    async (versionId) => {
      if (!noteId) return;
      setSelectedId(versionId);
      setPreviewLoading(true);
      setPreview(null);
      setError('');
      try {
        const version = await versionsApi.get(noteId, versionId);
        setPreview(version);
      } catch (err) {
        setError(err?.message ?? '读取版本内容失败');
      } finally {
        setPreviewLoading(false);
      }
    },
    [noteId],
  );

  const handleRestore = useCallback(async () => {
    if (!selectedId || restoring) return;
    if (!window.confirm('确定恢复到该历史版本吗？当前内容会先被存为一条历史，可再次撤销。')) return;
    setRestoring(true);
    setError('');
    try {
      await onRestore(selectedId);
    } catch (err) {
      setError(err?.message ?? '恢复失败');
    } finally {
      setRestoring(false);
    }
  }, [selectedId, restoring, onRestore]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return undefined;
    const handler = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open || !note) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="版本历史" onClick={onClose}>
      <div className="history" onClick={(event) => event.stopPropagation()}>
        <header className="history__head">
          <div>
            <h2 className="history__title">版本历史</h2>
            <p className="history__subtitle">{note.title}</p>
          </div>
          <button type="button" className="btn btn--sm" onClick={onClose} aria-label="关闭">
            <CloseIcon />
            关闭
          </button>
        </header>

        {error ? <div className="banner banner--error">{error}</div> : null}

        <div className="history__body">
          <div className="history__list">
            {loading ? (
              <p className="empty-hint">加载历史中…</p>
            ) : items.length === 0 ? (
              <p className="empty-hint">
                这篇笔记还没有历史版本。当你多次编辑并自动保存后，被覆盖的旧内容会在这里留下快照。
              </p>
            ) : (
              <ul>
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`history__item ${selectedId === item.id ? 'is-active' : ''}`}
                      onClick={() => handleSelect(item.id)}
                    >
                      <span className="history__item-time">{formatRelativeTime(item.createdAt)}</span>
                      <span className="history__item-title">{item.title || '（无标题）'}</span>
                      <span className="history__item-meta">
                        {formatNumber(item.wordCount)} 字 · {formatDateTime(item.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="history__detail">
            {selectedId ? (
              <>
                <div className="history__content" aria-label="版本内容预览">
                  {previewLoading ? (
                    <p className="empty-hint">读取中…</p>
                  ) : (
                    <pre>{preview?.content ?? ''}</pre>
                  )}
                </div>
                <footer className="history__foot">
                  <span className="history__foot-hint">
                    {preview ? `将恢复为 ${formatDateTime(preview.createdAt)} 的状态` : ' '}
                  </span>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={!preview || restoring}
                    onClick={handleRestore}
                  >
                    {restoring ? '恢复中…' : '恢复此版本'}
                  </button>
                </footer>
              </>
            ) : (
              <div className="history__detail-empty">
                <p className="empty-state__title">选择左侧的一个版本</p>
                <p className="empty-state__hint">即可预览其正文，并把它恢复为当前内容。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
