import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Copy, FileText, RefreshCw, Sparkles, Zap } from 'lucide-react';
import { renderMarkdown } from '../../lib/markdown.ts';
import type { AiAttachment } from '../../lib/ai-attachments.ts';
import type { AiRunMetrics } from '../../ai/contracts.ts';
import AiProgressChecklist, { type AiProgressStep } from './AiProgressChecklist.tsx';

interface AiMessageReference {
  id?: string;
  number?: number;
  title?: string;
  excerpt?: string;
  path?: string | null;
  anchor?: string;
  inferred?: boolean;
}

export interface AiNoteNavigationTarget {
  heading?: string;
  excerpt?: string;
}

interface AiToolExecution {
  kind?: string;
  server?: string;
  tool?: string;
  label?: string;
  transport?: string;
  ok?: boolean;
  error?: string;
}

interface AiMessageMeta {
  provider?: string;
  model?: string;
  latencyMs?: number;
  rounds?: number;
  usage?: { total_tokens?: number } | null;
  metrics?: AiRunMetrics;
  context?: {
    historyAvailableMessages?: number;
    historyMessages?: number;
    historyTokens?: number;
    historyTruncated?: boolean;
    contextRetry?: boolean;
    contextWindowTokens?: number;
  } | null;
  executed?: string[];
  executedFailed?: string[];
  toolExecutions?: AiToolExecution[];
  progress?: AiProgressStep[];
  taskMode?: boolean;
  executedOperations?: Array<{ operationId: string }>;
  [key: string]: unknown;
}

export interface AiDisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: AiAttachment[];
  suggestions?: Array<string | { title?: string; detail?: string }>;
  references?: AiMessageReference[];
  reasoning?: string;
  meta?: AiMessageMeta | null;
}

export interface AiMessageProps {
  message: AiDisplayMessage;
  onSuggestion: (value: string) => void;
  onOpenNote?: (noteId: string | null, target?: AiNoteNavigationTarget) => void | Promise<unknown>;
  isLastAssistant?: boolean;
  onRegenerate?: () => void;
  busy?: boolean;
  onUndoExecuted?: () => void;
  undoExecutedBusy?: boolean;
  undoExecutedDone?: boolean;
}

export interface AiStreamingMessageProps {
  taskMode?: boolean;
  progress?: AiProgressStep[];
  reasoningText?: string;
  reasoningOpen?: boolean;
  streamText?: string;
  streamStatus?: string;
  onReasoningToggle?: (open: boolean) => void;
}

function formatTokenCount(usage: { total_tokens?: number }) {
  const total = Number(usage.total_tokens ?? 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  if (total >= 10_000) return `${(total / 1000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}

function formatContextWindow(tokens: number | null | undefined) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '上下文预算未知';
  if (value >= 1_000_000) return '上下文 1M';
  if (value >= 1_000) return `上下文 ${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}k`;
  return `上下文 ${value}`;
}

function formatCompactTokenCount(value: number | null | undefined) {
  const total = Number(value);
  if (!Number.isFinite(total) || total <= 0) return '历史 token 未知';
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
  if (total >= 10_000) return `${(total / 1_000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}

function formatMetricDuration(value: number | null | undefined): string {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return '';
  return duration >= 1000 ? `${(duration / 1000).toFixed(1)}s` : `${Math.round(duration)}ms`;
}

async function copyPlainText(value: unknown) {
  const text = String(value ?? '');
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export default function AiMessage({ message, onSuggestion, onOpenNote, isLastAssistant = false, onRegenerate, busy = false, onUndoExecuted, undoExecutedBusy = false, undoExecutedDone = false }: AiMessageProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState('');
  const usage = message.meta?.usage;
  const metrics = message.meta?.metrics;
  const context = message.meta?.context;
  const contextLine = context?.historyAvailableMessages
    ? ` · 历史 ${context.historyMessages}/${context.historyAvailableMessages} 条 · ${formatCompactTokenCount(context.historyTokens)} / ${formatContextWindow(context.contextWindowTokens)}${context.historyTruncated ? ' · 已按预算裁剪' : ''}${context.contextRetry ? ' · 已自动缩短重试' : ''}`
    : '';
  const metricsLine = metrics
    ? ` · 首字 ${formatMetricDuration(metrics.timeToFirstTokenMs) || '未记录'} · 总计 ${formatMetricDuration(metrics.durationMs)}${metrics.toolCalls ? ` · 工具 ${metrics.toolCalls} 次` : ''}`
    : '';
  const metaLine = message.meta?.provider === 'external' && message.meta?.model
    ? `${message.meta.model}${message.meta.latencyMs ? ` · ${(message.meta.latencyMs / 1000).toFixed(1)}s` : ''}${(message.meta.rounds ?? 0) > 1 ? ` · ${message.meta.rounds} 轮` : ''}${usage?.total_tokens ? ` · ${formatTokenCount(usage)}` : ''}${contextLine}${metricsLine}`
    : message.meta?.provider === 'local-instant'
      ? `本地即时回答 · 未调用模型${message.meta.latencyMs ? ` · ${message.meta.latencyMs}ms` : ''}`
      : message.meta?.provider === 'local'
        ? '本地模式 · 未配置外部模型'
        : null;
  const executed = Array.isArray(message.meta?.executed) ? message.meta.executed : [];
  const executedFailed = Array.isArray(message.meta?.executedFailed) ? message.meta.executedFailed : [];
  const toolExecutions = Array.isArray(message.meta?.toolExecutions) ? message.meta.toolExecutions : [];
  const progress = Array.isArray(message.meta?.progress) ? message.meta.progress : [];
  const plainText = String(message.content ?? '');

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return undefined;
    const referenceCount = message.references?.length ?? 0;
    for (const pre of root.querySelectorAll('pre')) {
      if (pre.querySelector('.ai-code-copy')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ai-code-copy';
      button.textContent = '复制';
      button.setAttribute('aria-label', '复制代码');
      pre.appendChild(button);
    }
    if (referenceCount > 0) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent || /^(PRE|CODE|BUTTON|A)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
          return /\[\d{1,2}\]/.test(node.nodeValue as string) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const targets: Node[] = [];
      while (walker.nextNode()) targets.push(walker.currentNode);
      for (const node of targets) {
        const fragment = document.createDocumentFragment();
        let rest = node.nodeValue ?? '';
        while (rest) {
          const match = rest.match(/\[(\d{1,2})\]/);
          if (!match) { fragment.appendChild(document.createTextNode(rest)); break; }
          const number = Number(match[1]);
          const index = match.index ?? 0;
          if (index > 0) fragment.appendChild(document.createTextNode(rest.slice(0, index)));
          if (number >= 1 && number <= referenceCount) {
            const cite = document.createElement('button');
            cite.type = 'button'; cite.className = 'ai-cite'; cite.dataset.ref = String(number); cite.textContent = match[0]; cite.setAttribute('aria-label', `查看引用来源 ${number}`);
            fragment.appendChild(cite);
          } else fragment.appendChild(document.createTextNode(match[0]));
          rest = rest.slice(index + match[0].length);
        }
        (node as ChildNode).replaceWith(fragment);
      }
    }
    return undefined;
  }, [message.content, message.references]);

  const flashReference = (number: number) => {
    const body = contentRef.current?.parentElement;
    const chip = [...(body?.querySelectorAll('.ai-message__references button') ?? [])].find((item) => (item as HTMLElement).dataset.ref === String(number)) as HTMLElement | undefined;
    if (!chip) return;
    chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    chip.classList.remove('is-flash'); void chip.offsetWidth; chip.classList.add('is-flash');
    window.setTimeout(() => chip.classList.remove('is-flash'), 1600);
  };

  const openReference = (number: number) => {
    const reference = message.references?.find((item, index) => (item.number ?? index + 1) === number);
    if (!reference?.id) {
      flashReference(number);
      return;
    }
    void onOpenNote?.(reference.id, { heading: reference.anchor, excerpt: reference.excerpt });
  };

  const handleContentClick = async (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const codeButton = target.closest?.('.ai-code-copy');
    if (codeButton) {
      const code = codeButton.parentElement?.querySelector('code') ?? codeButton.parentElement;
      const success = await copyPlainText(code?.textContent ?? '');
      codeButton.textContent = success ? '已复制' : '复制失败';
      window.setTimeout(() => { codeButton.textContent = '复制'; }, 1400);
      return;
    }
    const cite = target.closest?.('.ai-cite');
    if (cite) openReference(Number((cite as HTMLElement).dataset.ref));
  };

  const copyMessage = async () => {
    const success = await copyPlainText(plainText);
    setCopied(success ? 'ok' : 'fail');
    window.setTimeout(() => setCopied(''), 1400);
  };

  return (
    <article className={`ai-message ai-message--${message.role}`}>
      {message.role === 'assistant' ? <span className="ai-message__avatar" aria-hidden="true"><Sparkles size={15} strokeWidth={1.8} /></span> : null}
      <div className="ai-message__body">
        {message.reasoning ? <details className="ai-message__reasoning"><summary>查看分析摘要</summary><div className="ai-message__reasoning-body">{message.reasoning}</div></details> : null}
        {message.meta?.taskMode === true && progress.length ? <AiProgressChecklist steps={progress} /> : null}
        <div className="ai-message__content markdown-body" ref={contentRef} onClick={handleContentClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(plainText) }} />
        {message.attachments?.length ? <div className="ai-message__attachments" aria-label="本条消息的附件">{message.attachments.map((attachment) => attachment.kind === 'image' ? <img key={attachment.id} src={attachment.dataUrl} alt={attachment.name} title={attachment.name} /> : <span key={attachment.id} title={attachment.name}><FileText size={14} />{attachment.name}</span>)}</div> : null}
        {executed.length ? <details className="ai-message__executed"><summary><Zap size={12} aria-hidden="true" />已自动执行 {executed.length} 项操作</summary><ul>{executed.map((item, index) => <li key={index}>{item}</li>)}</ul>{executedFailed.length ? <ul className="has-failures">{executedFailed.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}{onUndoExecuted && message.meta?.executedOperations?.length ? <button type="button" className="btn btn--sm" onClick={onUndoExecuted} disabled={undoExecutedBusy || undoExecutedDone}>{undoExecutedDone ? '已撤销' : undoExecutedBusy ? '撤销中…' : '撤销这批操作'}</button> : null}</details> : null}
        {toolExecutions.length ? <details className="ai-message__executed ai-message__tools" open><summary>工具执行记录 · {toolExecutions.length} 项</summary><ul>{toolExecutions.map((item, index) => { const label = item.kind === 'mcp' ? `MCP ${item.server ?? '?'} / ${item.tool ?? '?'}` : `${item.kind === 'search' ? '检索' : '读取'} ${item.label ?? ''}`; const transport = item.transport === 'stdio' ? ' · 本地 MCP 进程' : item.transport === 'sse' ? ' · MCP 网络服务' : ''; return <li key={`${label}-${index}`} className={item.ok ? '' : 'has-failures'}>{label}{transport} · {item.ok ? '已完成' : `失败：${item.error ?? '未知错误'}`}</li>; })}</ul></details> : null}
        {metaLine ? <span className="ai-message__meta">{metaLine}</span> : null}
        {message.references?.length ? <div className="ai-message__references">{message.references.map((reference, index) => <button type="button" key={reference.id ?? `${reference.title}-${index}`} data-ref={String(reference.number ?? index + 1)} onClick={() => reference.id && onOpenNote?.(reference.id, { heading: reference.anchor, excerpt: reference.excerpt })} title={reference.excerpt ?? ''}><span>{reference.inferred ? '◇' : `[${reference.number ?? index + 1}]`}</span><strong>{reference.title}</strong><small>{reference.anchor ? `${reference.anchor} · ` : ''}{reference.excerpt ? reference.excerpt.slice(0, 60) : (reference.path ?? '来源笔记')}</small></button>)}</div> : null}
        {message.suggestions?.length ? <div className="ai-message__suggestions">{message.suggestions.map((suggestion, index) => { const label = typeof suggestion === 'string' ? suggestion : suggestion.title; const detail = typeof suggestion === 'string' ? '' : suggestion.detail; return <button type="button" key={`${label}-${index}`} onClick={() => label && onSuggestion(label)}><span>＋</span><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span></button>; })}</div> : null}
        {plainText ? <div className="ai-message__actions"><button type="button" className="ai-message__action" onClick={copyMessage} title={copied === 'ok' ? '已复制' : '复制全文'} aria-label="复制全文">{copied === 'ok' ? '已复制' : <Copy size={12.5} strokeWidth={1.8} aria-hidden="true" />}</button>{isLastAssistant && message.id !== 'ai-welcome' ? <button type="button" className="ai-message__action" onClick={() => onRegenerate?.()} disabled={busy} title={busy ? '正在生成中' : '重新生成这条回答'} aria-label="重新生成"><RefreshCw size={12.5} strokeWidth={1.8} aria-hidden="true" /></button> : null}</div> : null}
      </div>
    </article>
  );
}

export function AiStreamingMessage({ taskMode = false, progress = [], reasoningText = '', reasoningOpen = true, streamText = '', streamStatus = '', onReasoningToggle }: AiStreamingMessageProps) {
  return (
    <div className="ai-message ai-message--assistant">
      <span className="ai-message__avatar" aria-hidden="true"><Sparkles size={15} strokeWidth={1.8} /></span>
      <div className="ai-message__body">
        {taskMode ? <AiProgressChecklist steps={progress} live /> : null}
        {reasoningText ? <details className="ai-message__reasoning is-streaming" open={reasoningOpen} onToggle={(event) => onReasoningToggle?.(event.currentTarget.open)}>
          <summary><span className="ai-message__reasoning-label">分析摘要</span><span className="ai-message__reasoning-state">{streamText ? '已收起' : '实时更新'}</span></summary>
          <div className="ai-message__reasoning-body" aria-live="off">{reasoningText}</div>
        </details> : null}
        {streamText ? <div className="ai-message__content markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamText) }} /> : !reasoningText ? <div className="ai-message__typing" role="status" aria-label="AI 正在处理请求"><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></div> : null}
        <span className="ai-message__meta">{streamStatus || (streamText ? '生成中…' : reasoningText ? '正在思考…' : '正在检索知识与文件上下文…')}</span>
      </div>
    </div>
  );
}
