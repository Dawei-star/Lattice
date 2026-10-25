import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Copy, FileText, RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { parseBlocks, parseBlocksIncremental, type AiBlock } from '../../ai/parse-blocks.ts';
import { buildAiTimeline, type AiProgressStep } from '../../ai/timeline.ts';
import { buildAnswerNoteDraft, formatCostLabel } from '../../lib/ai-output.ts';
import type { AiAttachment } from '../../lib/ai-attachments.ts';
import type { AiRunMetrics } from '../../ai/contracts.ts';
import MarkdownBlock from './blocks/MarkdownBlock.tsx';
import CodeBlock from './blocks/CodeBlock.tsx';
import ReasoningBlock from './blocks/ReasoningBlock.tsx';
import MermaidBlock from './blocks/MermaidBlock.tsx';
import MathBlock from './blocks/MathBlock.tsx';
import AiAgentTimeline from './AiAgentTimeline.tsx';
import AiFileChangesCard, { type AiFileChange } from './AiFileChangesCard.tsx';
import AiCitationPopover, { type AiCitationPopoverTarget } from './AiCitationPopover.tsx';

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
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  /** 按已配置的 1k token 单价估算（未配置价格时缺省，只显示 token） */
  costUsd?: number | null;
  /** 该回答由本机推理端点（loopback）生成 */
  modelLocal?: boolean;
  metrics?: AiRunMetrics;
  /** 思考流时长（毫秒）：首个 reasoning 事件到首个内容事件/done */
  reasoningMs?: number;
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
  /** U2 FileChangesCard：任务模式写操作的文件变更（±行数由面板在预览时统计） */
  fileChanges?: AiFileChange[];
  /** U3 反馈回链：这条回答对应的 run（👍/👎 落 trace 用） */
  runId?: string;
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
  /** U3 变体切换（会话内存）：完整版本组（含当前显示版本）+ 当前显示下标 */
  variants?: AiDisplayMessage[];
  variantIndex?: number;
}

export interface AiMessageProps {
  message: AiDisplayMessage;
  onSuggestion: (value: string) => void;
  onOpenNote?: (noteId: string | null, target?: AiNoteNavigationTarget) => void | Promise<unknown>;
  /** 把这条回答保存为笔记（引用自动转 [[双链]] 来源节） */
  onSaveToNote?: (draft: { title: string; content: string }) => void | Promise<unknown>;
  isLastAssistant?: boolean;
  onRegenerate?: () => void;
  busy?: boolean;
  onUndoExecuted?: () => void;
  undoExecutedBusy?: boolean;
  undoExecutedDone?: boolean;
  /** 打开知识库内相对路径（FileChangesCard「打开」；解析失败由面板提示） */
  onOpenPath?: (path: string) => void;
  /** U3 变体切换：切到组内第 index 个版本 */
  onSwitchVariant?: (index: number) => void;
  /** U3 反馈进 trace：👍/👎 写 run 的 feedback 事件 */
  onFeedback?: (rating: 'up' | 'down') => void;
  feedbackGiven?: 'up' | 'down' | null;
}

export interface AiStreamingMessageProps {
  taskMode?: boolean;
  progress?: AiProgressStep[];
  reasoningText?: string;
  reasoningOpen?: boolean;
  /** 思考流起点（毫秒时间戳）：徽标显示实时已思考时长 */
  reasoningStartedAt?: number;
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

/** 块渲染分派：markdown/table 走文本块，code 走围栏块，mermaid/math 走 U3 富渲染（失败回退代码块）。 */
function renderBlock(block: AiBlock, index: number) {
  if (block.kind === 'markdown' || block.kind === 'table') {
    return <MarkdownBlock key={index} source={block.source} />;
  }
  if (block.kind === 'mermaid') return <MermaidBlock key={index} block={block} />;
  if (block.kind === 'math') return <MathBlock key={index} block={block} />;
  return <CodeBlock key={index} block={block} />;
}

export default function AiMessage({ message, onSuggestion, onOpenNote, onSaveToNote, isLastAssistant = false, onRegenerate, busy = false, onUndoExecuted, undoExecutedBusy = false, undoExecutedDone = false, onOpenPath, onSwitchVariant, onFeedback, feedbackGiven = null }: AiMessageProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState('');
  const [noteSaveState, setNoteSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [citationHover, setCitationHover] = useState<{ target: AiCitationPopoverTarget; x: number; y: number } | null>(null);
  const hoverTimerRef = useRef(0);
  const usage = message.meta?.usage;
  const metrics = message.meta?.metrics;
  const context = message.meta?.context;
  const contextLine = context?.historyAvailableMessages
    ? ` · 历史 ${context.historyMessages}/${context.historyAvailableMessages} 条 · ${formatCompactTokenCount(context.historyTokens)} / ${formatContextWindow(context.contextWindowTokens)}${context.historyTruncated ? ' · 已按预算裁剪' : ''}${context.contextRetry ? ' · 已自动缩短重试' : ''}`
    : '';
  const metricsLine = metrics
    ? ` · 首字 ${formatMetricDuration(metrics.timeToFirstTokenMs) || '未记录'} · 总计 ${formatMetricDuration(metrics.durationMs)}${metrics.toolCalls ? ` · 工具 ${metrics.toolCalls} 次` : ''}`
    : '';
  // 桌面端 provider 为 'tauri'（durable run 原样透传），浏览器端为 'external'，都按模型回答渲染
  const isModelAnswer = (message.meta?.provider === 'external' || message.meta?.provider === 'tauri') && Boolean(message.meta?.model);
  const sourceLabel = message.meta?.modelLocal === true ? ' · 本机（数据不出机器）' : '';
  const costLabel = typeof message.meta?.costUsd === 'number' ? ` · ≈${formatCostLabel(message.meta.costUsd as number)}` : '';
  const metaLine = isModelAnswer
    ? `${message.meta?.model}${message.meta?.latencyMs ? ` · ${(message.meta.latencyMs / 1000).toFixed(1)}s` : ''}${(message.meta?.rounds ?? 0) > 1 ? ` · ${message.meta?.rounds} 轮` : ''}${usage?.total_tokens ? ` · ${formatTokenCount(usage)}` : ''}${contextLine}${metricsLine}${sourceLabel}${costLabel}`
    : message.meta?.provider === 'local-instant'
      ? `本地即时回答 · 未调用模型${message.meta.latencyMs ? ` · ${message.meta.latencyMs}ms` : ''}`
      : message.meta?.provider === 'local'
        ? '本地模式 · 未配置外部模型'
        : null;
  const executed = Array.isArray(message.meta?.executed) ? message.meta.executed : [];
  const executedFailed = Array.isArray(message.meta?.executedFailed) ? message.meta.executedFailed : [];
  const toolExecutions = Array.isArray(message.meta?.toolExecutions) ? message.meta.toolExecutions : [];
  const progress = Array.isArray(message.meta?.progress) ? message.meta.progress : [];
  const fileChanges = Array.isArray(message.meta?.fileChanges) ? message.meta.fileChanges : [];
  const plainText = String(message.content ?? '');
  // U2 块架构：整条消息一次性解析成稳定块；块组件按 source 引用 memo，
  // 流式增量解析复用前缀块引用 → 已完成消息重渲染不再整段重注入。
  const blocks = useMemo(() => parseBlocks(plainText), [plainText]);
  // U2 UnifiedTimeline：progress + toolExecutions + executed 合并为单一时间线
  const timelineEntries = useMemo(() => buildAiTimeline({
    progress,
    toolExecutions,
    executed,
    executedFailed,
  }), [progress, toolExecutions, executed, executedFailed]);

  useEffect(() => () => window.clearTimeout(hoverTimerRef.current), []);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return undefined;
    const referenceCount = message.references?.length ?? 0;
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

  // U2 引用悬停预览：300ms 防抖展示预览卡，点击才跳转（导航副作用只在点击时发生）
  const handleCitationOver = (event: MouseEvent<HTMLElement>) => {
    const target = (event.target as HTMLElement).closest?.('.ai-cite, .ai-message__references button') as HTMLElement | null;
    if (!target) return;
    const number = Number(target.dataset.ref);
    if (!Number.isFinite(number) || number <= 0) return;
    const reference = message.references?.find((item, index) => (item.number ?? index + 1) === number);
    if (!reference) return;
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      const rect = target.getBoundingClientRect();
      setCitationHover({
        target: { number, title: reference.title, path: reference.path, anchor: reference.anchor, excerpt: reference.excerpt },
        x: rect.left,
        y: rect.bottom,
      });
    }, 300);
  };

  const handleCitationOut = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest?.('.ai-cite, .ai-message__references button')) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = 0;
      setCitationHover(null);
    }
  };

  const handleContentClick = async (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const codeButton = target.closest?.('.ai-code-copy');
    if (codeButton) {
      const code = codeButton.closest('.ai-code')?.querySelector('code');
      const success = await copyPlainText(code?.textContent ?? '');
      codeButton.textContent = success ? '已复制' : '复制失败';
      window.setTimeout(() => { codeButton.textContent = '复制'; }, 1400);
      return;
    }
    const wrapButton = target.closest?.('.ai-code-wrap');
    if (wrapButton) {
      wrapButton.closest('.ai-code')?.classList.toggle('is-wrapped');
      return;
    }
    const cite = target.closest?.('.ai-cite');
    if (cite) {
      const number = Number((cite as HTMLElement).dataset.ref);
      window.clearTimeout(hoverTimerRef.current);
      setCitationHover(null);
      openReference(number);
    }
  };

  const copyMessage = async () => {
    const success = await copyPlainText(plainText);
    setCopied(success ? 'ok' : 'fail');
    window.setTimeout(() => setCopied(''), 1400);
  };

  // 存为笔记：引用按标题去重后转为 [[双链]] 来源节；创建走 App 侧的 WorkspaceService 写路径
  const saveToNote = async () => {
    if (noteSaveState === 'saving' || !onSaveToNote) return;
    setNoteSaveState('saving');
    try {
      await onSaveToNote(buildAnswerNoteDraft({ content: plainText, references: message.references }));
      setNoteSaveState('saved');
    } catch {
      setNoteSaveState('failed');
    }
    window.setTimeout(() => setNoteSaveState('idle'), 1800);
  };

  const timelineUndoable = Boolean(onUndoExecuted && message.meta?.executedOperations?.length);
  const variantCount = message.variants?.length ?? 0;
  const variantIndex = message.variantIndex ?? 0;

  return (
    <article className={`ai-message ai-message--${message.role}`}>
      {message.role === 'assistant' ? <span className="ai-message__avatar" aria-hidden="true"><Sparkles size={15} strokeWidth={1.8} /></span> : null}
      <div className="ai-message__body">
        {variantCount > 1 && onSwitchVariant ? (
          <div className="ai-message__variants" role="group" aria-label="回答版本">
            <button type="button" onClick={() => onSwitchVariant(variantIndex - 1)} disabled={variantIndex <= 0} aria-label="上一版本">‹</button>
            <span>{variantIndex + 1}/{variantCount}</span>
            <button type="button" onClick={() => onSwitchVariant(variantIndex + 1)} disabled={variantIndex >= variantCount - 1} aria-label="下一版本">›</button>
          </div>
        ) : null}
        {message.reasoning ? <ReasoningBlock reasoning={message.reasoning} durationMs={message.meta?.reasoningMs} /> : null}
        <AiAgentTimeline
          entries={timelineEntries}
          undoable={timelineUndoable}
          undoBusy={undoExecutedBusy}
          undoDone={undoExecutedDone}
          onUndo={onUndoExecuted}
        />
        <div
          className="ai-message__content markdown-body"
          ref={contentRef}
          onClick={handleContentClick}
          onMouseOver={handleCitationOver}
          onMouseOut={handleCitationOut}
        >
          {blocks.map(renderBlock)}
        </div>
        {message.attachments?.length ? <div className="ai-message__attachments" aria-label="本条消息的附件">{message.attachments.map((attachment) => attachment.kind === 'image' ? <img key={attachment.id} src={attachment.dataUrl} alt={attachment.name} title={attachment.name} /> : <span key={attachment.id} title={attachment.name}><FileText size={14} />{attachment.name}</span>)}</div> : null}
        {fileChanges.length ? <AiFileChangesCard changes={fileChanges} onOpenPath={onOpenPath} /> : null}
        {metaLine ? <span className="ai-message__meta">{metaLine}</span> : null}
        {message.references?.length ? <div className="ai-message__references">{message.references.map((reference, index) => <button type="button" key={reference.id ?? `${reference.title}-${index}`} data-ref={String(reference.number ?? index + 1)} onClick={() => reference.id && onOpenNote?.(reference.id, { heading: reference.anchor, excerpt: reference.excerpt })} title={reference.excerpt ?? ''}><span>{reference.inferred ? '◇' : `[${reference.number ?? index + 1}]`}</span><strong>{reference.title}</strong><small>{reference.anchor ? `${reference.anchor} · ` : ''}{reference.excerpt ? reference.excerpt.slice(0, 60) : (reference.path ?? '来源笔记')}</small></button>)}</div> : null}
        {message.suggestions?.length ? <div className="ai-message__suggestions">{message.suggestions.map((suggestion, index) => { const label = typeof suggestion === 'string' ? suggestion : suggestion.title; const detail = typeof suggestion === 'string' ? '' : suggestion.detail; return <button type="button" key={`${label}-${index}`} onClick={() => label && onSuggestion(label)}><span>＋</span><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span></button>; })}</div> : null}
        {plainText ? <div className="ai-message__actions"><button type="button" className="ai-message__action" onClick={copyMessage} title={copied === 'ok' ? '已复制' : '复制全文'} aria-label="复制全文">{copied === 'ok' ? '已复制' : <Copy size={12.5} strokeWidth={1.8} aria-hidden="true" />}</button>{onSaveToNote ? <button type="button" className="ai-message__action" onClick={saveToNote} disabled={noteSaveState === 'saving'} title="保存为笔记（引用自动转为双链）" aria-label="保存为笔记">{noteSaveState === 'saving' ? '保存中…' : noteSaveState === 'saved' ? '已保存' : noteSaveState === 'failed' ? '保存失败' : <FileText size={12.5} strokeWidth={1.8} aria-hidden="true" />}</button> : null}{isModelAnswer && onFeedback ? <button type="button" className={`ai-message__action ${feedbackGiven === 'up' ? 'is-active' : ''}`} onClick={() => onFeedback('up')} disabled={feedbackGiven !== null} title="有帮助" aria-label="有帮助"><ThumbsUp size={12.5} strokeWidth={1.8} aria-hidden="true" /></button> : null}{isModelAnswer && onFeedback ? <button type="button" className={`ai-message__action ${feedbackGiven === 'down' ? 'is-active' : ''}`} onClick={() => onFeedback('down')} disabled={feedbackGiven !== null} title="需改进" aria-label="需改进"><ThumbsDown size={12.5} strokeWidth={1.8} aria-hidden="true" /></button> : null}{isLastAssistant && message.id !== 'ai-welcome' ? <button type="button" className="ai-message__action" onClick={() => onRegenerate?.()} disabled={busy} title={busy ? '正在生成中' : '重新生成这条回答（旧回答保留为变体）'} aria-label="重新生成"><RefreshCw size={12.5} strokeWidth={1.8} aria-hidden="true" /></button> : null}</div> : null}
        {citationHover ? (
          <AiCitationPopover
            target={citationHover.target}
            x={citationHover.x}
            y={citationHover.y}
            onOpen={(target) => { setCitationHover(null); openReference(target.number); }}
            onClose={() => setCitationHover(null)}
          />
        ) : null}
      </div>
    </article>
  );
}

export function AiStreamingMessage({ taskMode = false, progress = [], reasoningText = '', reasoningOpen = true, reasoningStartedAt, streamText = '', streamStatus = '', onReasoningToggle }: AiStreamingMessageProps) {
  // U2 流式增量解析：只重解析尾部块；文本回退/整轮替换时全量重解析
  const parseCacheRef = useRef<{ text: string; blocks: AiBlock[] }>({ text: '', blocks: [] });
  const blocks = useMemo(() => {
    const cache = parseCacheRef.current;
    const next = cache.text && streamText.startsWith(cache.text)
      ? parseBlocksIncremental(streamText, cache.blocks)
      : parseBlocks(streamText);
    parseCacheRef.current = { text: streamText, blocks: next };
    return next;
  }, [streamText]);
  const timelineEntries = useMemo(() => buildAiTimeline({ progress }), [progress]);

  return (
    <div className="ai-message ai-message--assistant">
      <span className="ai-message__avatar" aria-hidden="true"><Sparkles size={15} strokeWidth={1.8} /></span>
      <div className="ai-message__body">
        <AiAgentTimeline entries={timelineEntries} live={taskMode} />
        {reasoningText ? (
          <ReasoningBlock
            reasoning={reasoningText}
            streaming
            open={reasoningOpen}
            onToggle={onReasoningToggle}
            durationMs={reasoningStartedAt ? Date.now() - reasoningStartedAt : undefined}
          />
        ) : null}
        {streamText ? <div className="ai-message__content markdown-body">{blocks.map(renderBlock)}</div> : !reasoningText ? <div className="ai-message__typing" role="status" aria-label="AI 正在处理请求"><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></div> : null}
        <span className="ai-message__meta">{streamStatus || (streamText ? '生成中…' : reasoningText ? '正在思考…' : '正在检索知识与文件上下文…')}</span>
      </div>
    </div>
  );
}
