import { useCallback, useEffect, useMemo, useState } from 'react';
import { attachmentsApi } from '../api/resources.js';
import { CloseIcon } from './icons.jsx';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * 附件管理视图。
 * 自取数：进入时拉取全部附件（含引用计数），支持删除单个与一键清理未引用。
 * 图片渲染缩略图，其余（PDF）用占位行；有引用的附件点击可跳到首篇引用它的笔记。
 */
export default function AttachmentsView({ onOpenNote }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await attachmentsApi.list()) ?? []);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error?.message ?? '附件列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const orphanCount = useMemo(() => items.filter((item) => item.refCount === 0).length, [items]);

  const handleDelete = useCallback(
    async (attachment) => {
      if (!window.confirm(`删除附件「${attachment.name}」？该操作会同时删掉磁盘文件，不可撤销。`)) return;
      setBusyId(attachment.id);
      try {
        await attachmentsApi.remove(attachment.id);
        setItems((current) => current.filter((item) => item.id !== attachment.id));
      } catch (error) {
        setErrorMessage(error?.message ?? '删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const handleCleanup = useCallback(async () => {
    if (orphanCount === 0) return;
    if (!window.confirm(`清理 ${orphanCount} 个未被任何笔记引用的附件？删除后不可撤销。`)) return;
    setBusyId('__cleanup__');
    try {
      await attachmentsApi.cleanup();
      await reload();
    } catch (error) {
      setErrorMessage(error?.message ?? '清理失败');
    } finally {
      setBusyId(null);
    }
  }, [orphanCount, reload]);

  return (
    <section className="attachments" aria-label="附件管理">
      <div className="attachments__bar">
        <span>
          共 {items.length} 个附件
          {orphanCount > 0 ? <span className="attachments__orphans"> · {orphanCount} 个未引用</span> : null}
        </span>
        <div className="attachments__bar-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={handleCleanup}
            disabled={orphanCount === 0 || busyId === '__cleanup__'}
          >
            {busyId === '__cleanup__' ? '清理中…' : `清理未引用${orphanCount ? ` (${orphanCount})` : ''}`}
          </button>
          <button type="button" className="btn btn--sm" onClick={reload} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      {errorMessage ? (
        <div className="banner banner--error">
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {loading ? (
        <p className="attachments__hint">加载中…</p>
      ) : items.length === 0 ? (
        <div className="empty-state empty-state--large">
          <p className="empty-state__title">还没有附件</p>
          <p className="empty-state__hint">在笔记编辑器里点「图片」，或直接粘贴 / 拖拽，即可把图片和 PDF 存进本地附件文件夹。</p>
        </div>
      ) : (
        <ul className="attachments__grid">
          {items.map((item) => {
            const isImage = item.mime.startsWith('image/');
            return (
              <li key={item.id} className={`attachment-card ${item.refCount === 0 ? 'is-orphan' : ''}`}>
                <div className="attachment-card__preview">
                  {isImage ? (
                    <img src={item.url} alt={item.name} loading="lazy" />
                  ) : (
                    <span className="attachment-card__doc" aria-hidden="true">
                      PDF
                    </span>
                  )}
                </div>
                <div className="attachment-card__meta">
                  <span className="attachment-card__name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="attachment-card__sub">
                    {formatBytes(item.size)} ·{' '}
                    {item.refCount === 0 ? (
                      '未引用'
                    ) : (
                      <button
                        type="button"
                        className="linklike"
                        title={item.referrers.map((r) => r.title).join('、')}
                        onClick={() => onOpenNote?.(item.referrers[0].id)}
                      >
                        被 {item.refCount} 篇引用
                      </button>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="attachment-card__delete"
                  onClick={() => handleDelete(item)}
                  disabled={busyId === item.id}
                  title="删除附件"
                  aria-label={`删除 ${item.name}`}
                >
                  {busyId === item.id ? '…' : <CloseIcon />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
