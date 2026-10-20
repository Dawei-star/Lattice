import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { AiSessionSummary } from '../../api/ai.ts';

export interface AiSessionHistoryProps {
  rows: AiSessionSummary[];
  meta?: { total?: number; hasMore?: boolean } | null;
  loading: boolean;
  query: string;
  searchContent: boolean;
  page: number;
  pageSize: number;
  deleteId: string;
  currentSessionId: string;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onSearchContentChange: (value: boolean) => void;
  onRefresh: () => void;
  onPageChange: (page: number) => void;
  onSelect: (session: AiSessionSummary) => void;
  onDelete: (session: AiSessionSummary) => void;
}

function formatSessionDate(value: string | number | null | undefined): string {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '时间未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  } catch {
    return '时间未知';
  }
}

function sessionDateGroup(value: string | number | null | undefined, now: Date = new Date()): string {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '更早';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.floor((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 0) return '今天';
  if (days < 7) return '最近 7 天';
  return '更早';
}

function groupSessionsByDate(rows: AiSessionSummary[]): Array<[string, AiSessionSummary[]]> {
  const groups = new Map<string, AiSessionSummary[]>([['今天', []], ['最近 7 天', []], ['更早', []]]);
  for (const row of rows) groups.get(sessionDateGroup(row.updatedAt))!.push(row);
  return [...groups.entries()].filter(([, items]) => items.length);
}

export default function AiSessionHistory({ rows, meta, loading, query, searchContent, page, pageSize, deleteId, currentSessionId, onClose, onQueryChange, onSearchContentChange, onRefresh, onPageChange, onSelect, onDelete }: AiSessionHistoryProps) {
  const groups = groupSessionsByDate(rows);
  const total = Number(meta?.total ?? rows.length);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrevious = page > 0;
  const hasNext = Boolean(meta?.hasMore) || page + 1 < totalPages;
  return (
    <section className="ai-session-browser" aria-label="会话历史">
      <header className="ai-session-browser__header">
        <div><span className="ai-assistant__eyebrow">CONVERSATION ARCHIVE</span><h3>会话历史</h3></div>
        <div className="ai-session-browser__header-actions">
          <button type="button" className="icon-btn" onClick={onRefresh} disabled={loading} title="刷新会话历史" aria-label="刷新会话历史"><RefreshCw size={14} className={loading ? 'is-spinning' : ''} /></button>
          <button type="button" className="icon-btn" onClick={onClose} title="返回当前对话" aria-label="返回当前对话"><X size={16} /></button>
        </div>
      </header>
      <div className="ai-session-browser__filters">
        <label className="ai-session-browser__search"><Search size={14} aria-hidden="true" /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索会话标题" aria-label="搜索会话标题" autoFocus />{loading ? <LoaderCircle size={14} className="is-spinning" aria-label="正在搜索" /> : null}</label>
        <label className={`ai-session-browser__content-toggle ${searchContent ? 'is-on' : ''}`} title="同时搜索会话消息正文"><input type="checkbox" checked={searchContent} onChange={(event) => onSearchContentChange(event.target.checked)} /><span>搜索正文</span></label>
      </div>
      <div className="ai-session-browser__list">
        {!loading && !rows.length ? <div className="ai-session-browser__empty">{query ? '没有匹配的会话' : '还没有历史会话'}</div> : null}
        {groups.map(([label, items]) => (
          <section className="ai-session-browser__group" key={label}>
            <div className="ai-session-browser__group-title"><span>{label}</span><small>{items.length}</small></div>
            <div className="ai-session-browser__rows">
              {items.map((session) => (
                <article className={`ai-session-browser__row ${session.id === currentSessionId ? 'is-current' : ''}`} key={session.id}>
                  <button type="button" className="ai-session-browser__row-main" onClick={() => onSelect(session)}>
                    <span className="ai-session-browser__row-mark" aria-hidden="true">{String(session.title || '新').trim().slice(0, 1)}</span>
                    <span className="ai-session-browser__row-copy"><strong>{String(session.title || '').trim() || '未命名会话'}</strong><small>{Number(session.messageCount ?? 0)} 条消息 · {formatSessionDate(session.updatedAt)}</small></span>
                    {session.id === currentSessionId ? <span className="ai-session-browser__current">当前</span> : null}
                  </button>
                  <button type="button" className="icon-btn ai-session-browser__delete" onClick={() => onDelete(session)} disabled={deleteId === session.id} title="删除会话" aria-label={`删除会话：${session.title || '未命名会话'}`}>{deleteId === session.id ? <LoaderCircle size={14} className="is-spinning" /> : <Trash2 size={14} />}</button>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
      <footer className="ai-session-browser__footer"><span>{total ? `${total} 个会话` : '暂无会话'}</span><div className="ai-session-browser__pagination"><button type="button" className="icon-btn" onClick={() => onPageChange(page - 1)} disabled={!hasPrevious || loading} title="上一页" aria-label="上一页"><ChevronLeft size={15} /></button><span>{page + 1} / {totalPages}</span><button type="button" className="icon-btn" onClick={() => onPageChange(page + 1)} disabled={!hasNext || loading} title="下一页" aria-label="下一页"><ChevronRight size={15} /></button></div></footer>
    </section>
  );
}
