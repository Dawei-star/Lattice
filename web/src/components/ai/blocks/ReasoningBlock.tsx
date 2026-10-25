import { memo } from 'react';
import { renderMarkdown } from '../../../lib/markdown.ts';

export interface ReasoningBlockProps {
  reasoning: string;
  /** 思考时长（毫秒）：流式期间为已进行时长，完成消息为 meta.reasoningMs */
  durationMs?: number;
  streaming?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}

function formatDuration(ms: number | undefined): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/**
 * ReasoningBlock（U2）：思考流 markdown 化（与回答同一渲染+脱敏管线），
 * 思考时长徽标；完成自动折叠沿用面板的 open 状态。
 */
const ReasoningBlock = memo(function ReasoningBlock({ reasoning, durationMs, streaming = false, open, onToggle }: ReasoningBlockProps) {
  const badge = formatDuration(durationMs);
  return (
    <details
      className={`ai-message__reasoning ${streaming ? 'is-streaming' : ''}`}
      open={streaming ? open : false}
      onToggle={streaming ? (event) => onToggle?.(event.currentTarget.open) : undefined}
    >
      <summary>
        <span className="ai-message__reasoning-label">分析摘要</span>
        {badge ? <span className="ai-message__reasoning-duration">{badge}</span> : null}
        {streaming ? <span className="ai-message__reasoning-state">实时更新</span> : null}
      </summary>
      <div
        className="ai-message__reasoning-body markdown-body"
        aria-live={streaming ? 'off' : undefined}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(reasoning) }}
      />
    </details>
  );
});

export default ReasoningBlock;
