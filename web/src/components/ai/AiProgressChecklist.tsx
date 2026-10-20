import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Circle, CircleAlert, LoaderCircle } from 'lucide-react';

export interface AiProgressStep {
  id: string;
  label: string;
  status?: string;
  detail?: string;
}

export interface AiProgressChecklistProps {
  steps?: AiProgressStep[];
  live?: boolean;
}

export default function AiProgressChecklist({ steps = [], live = false }: AiProgressChecklistProps) {
  const completed = steps.filter((step) => step.status === 'completed').length;
  const failed = steps.filter((step) => step.status === 'failed').length;
  const waiting = steps.filter((step) => step.status === 'waiting').length;
  const allDone = completed === steps.length && !failed && !waiting;
  const [expanded, setExpanded] = useState(() => live || !allDone);
  const statusText = failed
    ? `${failed} 项失败`
    : waiting
      ? '等待确认'
      : live
        ? '执行中'
        : '已完成全部步骤';
  const summaryText = failed
    ? `${completed}/${steps.length} 个步骤完成，${failed} 个失败`
    : waiting
      ? `${completed}/${steps.length} 个步骤完成，等待确认`
      : allDone
        ? `全部 ${completed} 个步骤已完成`
        : `已完成 ${completed}/${steps.length} 个步骤`;

  useEffect(() => {
    if (live) setExpanded(true);
  }, [live]);

  if (!steps.length) return null;

  return (
    <details
      className={`ai-progress ${live ? 'is-live' : ''} ${allDone ? 'is-complete' : ''}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      aria-label="任务进度"
    >
      <summary className="ai-progress__summary">
        <span className="ai-progress__summary-main">
          <span className="ai-assistant__eyebrow">{allDone ? 'TASK COMPLETE' : 'PROGRESS'}</span>
          <strong>{allDone ? '执行完成' : '任务进度'}</strong>
          <small>{summaryText}</small>
        </span>
        <span className="ai-progress__summary-side">
          <span className={`ai-progress__count ${failed ? 'has-failures' : live ? 'is-live' : ''}`}>{completed}/{steps.length}</span>
          <ChevronDown className="ai-progress__toggle" size={14} aria-hidden="true" />
        </span>
      </summary>
      <ol className="ai-progress__list" aria-live={live ? 'polite' : undefined}>
        {steps.map((step) => {
          const status = step.status ?? 'pending';
          const Icon = status === 'completed'
            ? CheckCircle2
            : status === 'failed' || status === 'waiting'
              ? CircleAlert
              : status === 'running'
                ? LoaderCircle
                : Circle;
          return (
            <li className={`ai-progress__item is-${status}`} key={step.id} aria-current={status === 'running' ? 'step' : undefined}>
              <Icon size={15} aria-hidden="true" />
              <span className="ai-progress__copy">
                <strong>{step.label}</strong>
                {step.detail ? <small>{step.detail}</small> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <footer className={`ai-progress__footer ${failed ? 'has-failures' : ''}`}>
        <span aria-live={live ? 'polite' : undefined}>{statusText}</span>
        <span>{live ? '状态来自实际执行' : expanded ? '收起明细' : '查看明细'}</span>
      </footer>
    </details>
  );
}
