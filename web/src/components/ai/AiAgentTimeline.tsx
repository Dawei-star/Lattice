import { useEffect, useState } from 'react';
import { ChevronDown, FileText, Plug, PenLine, Search, Wrench, Zap } from 'lucide-react';
import type { AiTimelineEntry, AiTimelineKind } from '../../ai/timeline.ts';

const KIND_ICONS: Record<AiTimelineKind, typeof FileText> = {
  search: Search,
  read: FileText,
  write: PenLine,
  mcp: Plug,
  step: Wrench,
  execution: Zap,
};

const KIND_LABELS: Record<AiTimelineKind, string> = {
  search: '检索',
  read: '读取',
  write: '写入',
  mcp: 'MCP',
  step: '步骤',
  execution: '执行',
};

export interface AiAgentTimelineProps {
  entries: AiTimelineEntry[];
  /** 流式执行中默认展开、完成后默认收起（沿用进度清单行为） */
  live?: boolean;
  undoable?: boolean;
  undoBusy?: boolean;
  undoDone?: boolean;
  onUndo?: () => void;
}

/**
 * UnifiedTimeline（U2）：合并 progress + toolExecutions + executed 为单一时间线。
 * 图标按检索/读取/写入/MCP/步骤/执行区分，失败条目红色；流式展开、完成收起。
 * 条目序与去重规则钉在 `ai/timeline.ts`（夹具 web/test/ai-timeline.test.mjs）。
 */
export default function AiAgentTimeline({ entries, live = false, undoable = false, undoBusy = false, undoDone = false, onUndo }: AiAgentTimelineProps) {
  const failed = entries.filter((entry) => entry.status === 'failed').length;
  const completed = entries.filter((entry) => entry.status === 'completed').length;
  const waiting = entries.filter((entry) => entry.status === 'waiting').length;
  const allDone = !live && !failed && !waiting && completed === entries.length && entries.length > 0;
  const [expanded, setExpanded] = useState(() => live || !allDone);

  useEffect(() => {
    if (live) setExpanded(true);
  }, [live]);

  if (!entries.length) return null;

  const summaryText = failed
    ? `${completed}/${entries.length} 项完成，${failed} 项失败`
    : waiting
      ? `${completed}/${entries.length} 项完成，等待确认`
      : live
        ? '执行中'
        : `已完成 ${completed} 项`;

  return (
    <details
      className={`ai-timeline ${live ? 'is-live' : ''} ${allDone ? 'is-complete' : ''} ${failed ? 'has-failures' : ''}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      aria-label="执行时间线"
    >
      <summary className="ai-timeline__summary">
        <span className="ai-timeline__summary-main">
          <span className="ai-assistant__eyebrow">{allDone ? 'TASK COMPLETE' : 'ACTIVITY'}</span>
          <strong>{allDone ? '执行完成' : live ? '任务执行' : '执行时间线'}</strong>
          <small>{summaryText}</small>
        </span>
        <span className="ai-timeline__summary-side">
          <span className={`ai-timeline__count ${failed ? 'has-failures' : live ? 'is-live' : ''}`}>{completed}/{entries.length}</span>
          <ChevronDown className="ai-timeline__toggle" size={14} aria-hidden="true" />
        </span>
      </summary>
      <ol className="ai-timeline__list" aria-live={live ? 'polite' : undefined}>
        {entries.map((entry) => {
          const Icon = KIND_ICONS[entry.kind] ?? FileText;
          return (
            <li className={`ai-timeline__item is-${entry.status}`} key={entry.id} aria-current={entry.status === 'running' ? 'step' : undefined}>
              <Icon size={14} aria-hidden="true" />
              <span className="ai-timeline__kind">{KIND_LABELS[entry.kind] ?? '步骤'}</span>
              <span className="ai-timeline__copy">
                <strong>{entry.label}</strong>
                {entry.detail ? <small>{entry.detail}</small> : null}
              </span>
              <span className="ai-timeline__status">{entry.status === 'failed' ? '失败' : entry.status === 'running' ? '执行中' : entry.status === 'waiting' ? '等待确认' : entry.status === 'completed' ? '完成' : '待执行'}</span>
            </li>
          );
        })}
      </ol>
      {undoable ? (
        <footer className="ai-timeline__footer">
          <button type="button" className="btn btn--sm" onClick={onUndo} disabled={undoBusy || undoDone}>
            {undoDone ? '已撤销' : undoBusy ? '撤销中…' : '撤销这批操作'}
          </button>
        </footer>
      ) : null}
    </details>
  );
}
