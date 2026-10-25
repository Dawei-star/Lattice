import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ArrowUp, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, FileSearch, FileText, Globe2, LayoutGrid, List, MessageCircle, MoreHorizontal, Paperclip, Pin, Plus, RefreshCw, Search, Settings2, Share2, Sparkles, Square, Table2, TriangleAlert, UserRound, WandSparkles, X } from 'lucide-react';
import { aiApi } from '../api/ai.ts';
import type { AiSessionSummary, AiStreamEvent, AiStreamFinalPayload } from '../api/ai.ts';
import { expertsApi } from '../api/experts.ts';
import type { Expert, Skill } from '../api/experts.ts';
import { filesApi } from '../api/files.ts';
import { getActiveAiProvider, getActiveAiProviderRuntime, getAiProviderRouteRuntime, hasExternalAi, hydrateAiSettingsFromServer, loadAiSettings, saveAiSettings, subscribeAiSettings } from '../settings/aiSettings.ts';
import { collectActiveMcpServers, loadMcpSettings, mergeProjectServers } from '../settings/mcpSettings.ts';
import { mcpApi } from '../api/mcp.ts';
import type { McpServerEntry } from '../api/mcp.ts';
import { memoryApi, type MemoryRecord } from '../api/memory.ts';
import { createAiAttachment, formatAiAttachmentSize, validateAiAttachment, type AiAttachment } from '../lib/ai-attachments.ts';
import { buildAiRunStages, type AiRunStage, type AiRunStageStatus } from '../lib/ai-run.ts';
import { createAiController } from '../ai/ai-controller.ts';
import { planAiQueries } from '../ai/query-planner.ts';
import { routeAiRequest, type AiRouteDecision } from '../lib/ai-policy.ts';
import { createAiRetrievalCache } from '../ai/retrieval-cache.ts';
import { createSmallModelClient } from '../ai/small-model.ts';
import { createRunId, type AiPermissionContext, type AiRunEvent, type AiRunMetrics } from '../ai/contracts.ts';
import { recordAiRunMetric, type AiMetricTaskType } from '../ai/run-metrics-store.ts';
import { recordAiRunTraceEvent, type AiTraceEventType } from '../ai/run-trace-store.ts';
import { checkpointForPlan, completedToolStep, createToolCheckpoint, normalizeToolCheckpoint, recordToolCheckpointStep, type AiToolCheckpoint } from '../ai/tool-checkpoint.ts';
import { createAiOperationAdapter } from '../ai/ai-operation-adapter.ts';
import { createAiOperationPlanner, isAutoExecutableL1Plan, type AiOperationPreview } from '../ai/ai-operation-planner.ts';
import { createProviderReadTools, executeProviderReadToolCalls, isProviderReadToolCall, providerReadCallFromCheckpoint, providerReadCheckpointDescriptor, type ProviderReadExecutionResult } from '../ai/provider-read-tools.ts';
import { createAiSessionStore } from '../ai/ai-session-store.ts';
import { appendAiMessage, attachRegenerateVariant, restoreAiMessages, switchMessageVariant } from '../ai/ai-message-state.ts';
import { computeVirtualRange } from '../ai/virtual-window.ts';
import { countDiffLines, estimateCostUsd, isLoopbackEndpoint } from '../lib/ai-output.ts';
import type { AiFileChange } from './ai/AiFileChangesCard.tsx';
import { createTauriDurableRunClient, createTauriDurableRunTransport } from '../ai/providers/tauri-provider.ts';
import { createAiProviderRouterTransport } from '../ai/providers/provider-router.ts';
import type { AiProviderRequest } from '../ai/providers/provider.ts';
import { forgetDurableRun, rememberDurableRun, scanDurableRuns, type DurableRunRecovery } from '../ai/run-recovery.ts';
import { aiStorageKey } from '../ai/storage.ts';
import { notifyAiRunCompletion } from '../lib/ai-notifications.ts';
import { useToast } from '../hooks/useToast.tsx';
import AiMessageView, { AiStreamingMessage as AiStreamingMessageView, type AiNoteNavigationTarget } from './ai/AiMessageList.tsx';
import AiOperationPreviewView from './ai/AiOperationPreview.tsx';
import AiExecutionSummaryView from './ai/AiExecutionSummary.tsx';
import AiSessionHistoryView from './ai/AiSessionHistory.tsx';
import GlimMascot, { GLIM_STATES, useGlimState, type GlimState } from './GlimMascot.tsx';
import { getClipboardImageFiles } from '../lib/clipboard.ts';
import Modal from '../ui/Modal.tsx';
import type { RequestOptions } from '../api/client.ts';
import type { FolderNode, NoteProperties } from '../api/resources.ts';
import type { NoteDetailRow, NoteIndexRow } from '../hooks/useVault.ts';

/** HTTP 请求失败的常见字段（catch 变量的最小形状）。 */
interface RequestFailure { status?: number; name?: string; message?: string; }

/** 从 vault 路径派生侧栏工作区显示名：取最后一段非空路径，空则回退。 */
function deriveWorkspaceLabel(identity: string | null | undefined): string {
  const parts = (identity ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] ?? '我的空间' : '我的空间';
}

/** 空态欢迎区的起步提示词：一条点击即发送。 */
const WELCOME_PROMPTS = [
  { icon: FileText, label: '总结当前笔记', prompt: '请总结当前笔记的要点，并列出待办。' },
  { icon: BookOpen, label: '检索知识库', prompt: '在我的知识库里检索与当前话题相关的内容，并给出引用。' },
  { icon: FileSearch, label: '深入研究', prompt: '研究这个问题并整理关键结论：' },
  { icon: Sparkles, label: '规划项目', prompt: '帮我规划一个项目，给出阶段、任务清单和里程碑。' },
] as const;

/** API 响应信封（data 字段包裹）。 */
interface HttpEnvelope { data?: unknown; [key: string]: unknown; }

type AiMessageRole = 'user' | 'assistant' | 'system';
type ContextScopePreference = 'auto' | 'current' | 'project' | 'all' | 'inbox';

/** 任务进度步骤。 */
interface ProgressStep { id: string; label: string; status?: string; detail?: string; }

interface AiMessageSuggestion { title?: string; detail?: string; }

interface AiReference { id?: string; number?: number; title?: string; excerpt?: string; path?: string | null; anchor?: string; inferred?: boolean; }

interface AiToolExecution { kind?: string; server?: string; tool?: string; label?: string; transport?: string; ok?: boolean; error?: string; }

interface AiUsage { total_tokens?: number; [key: string]: unknown; }

interface AiMessageContext {
  historyAvailableMessages?: number;
  historyMessages?: number;
  historyTokens?: number;
  historyTruncated?: boolean;
  contextRetry?: boolean;
  contextWindowTokens?: number;
}

interface AiMessageMeta {
  provider?: string;
  model?: string;
  latencyMs?: number;
  rounds?: number;
  usage?: AiUsage | null;
  metrics?: AiRunMetrics;
  context?: AiMessageContext | null;
  executed?: string[];
  executedFailed?: string[];
  toolExecutions?: AiToolExecution[];
  progress?: ProgressStep[];
  taskMode?: boolean;
  completionStatus?: string;
  awaitingConfirmation?: boolean;
  executedOperations?: Array<{ operationId: string }>;
  [key: string]: unknown;
}

interface AiMessage {
  id: string;
  role: AiMessageRole;
  content: string;
  attachments?: AiAttachment[];
  suggestions?: Array<string | AiMessageSuggestion>;
  references?: AiReference[];
  reasoning?: string;
  meta?: AiMessageMeta | null;
  /** U3 变体切换（会话内存）：完整版本组（含当前显示版本）+ 当前显示下标 */
  variants?: AiMessage[];
  variantIndex?: number;
}

interface AiAction {
  id?: string;
  type: string;
  path?: string | null;
  targetPath?: string | null;
  content?: string;
  sourcePath?: string | null;
  fromPath?: string | null;
  toPath?: string | null;
  destination?: string | null;
  [key: string]: unknown;
}

type OperationPreviewData = AiOperationPreview;

interface AiExecuteResult {
  results?: OperationResult[] | null;
  operationId?: string | null;
  operationIds?: string[] | null;
  partialFailure?: boolean;
  completed?: number;
  failed?: number;
  failure?: { message?: string } | null;
  compensation?: { operationIds?: string[] | null } | null;
  [key: string]: unknown;
}

interface OperationResult {
  id?: string;
  type?: string;
  path?: string | null;
  targetPath?: string | null;
  status?: string;
  error?: string;
  result?: AiExecuteResult | null;
  operationIds?: string[];
  [key: string]: unknown;
}

interface ExecutionResult { results?: OperationResult[]; completed?: number; failed?: number; skipped?: number; }

interface RelatedNote { id: string; title?: string; filePath?: string | null; score: number; anchor?: string; }

interface SessionMessage {
  id: string;
  role: AiMessageRole;
  content: string;
  payload?: { suggestions?: AiMessageSuggestion[]; references?: AiReference[]; reasoning?: string; meta?: AiMessageMeta | null } | null;
  [key: string]: unknown;
}

interface AiDigestResult { created?: boolean; title?: string; modifiedCount?: number; aiOverview?: boolean; noteId?: string | null; [key: string]: unknown; }

interface PanelExpertCapabilities { context?: string[]; writePolicy?: string; [key: string]: unknown; }

interface PanelExpert extends Expert {
  description?: string;
  skillCount?: number;
  skills?: Skill[];
  capabilities?: PanelExpertCapabilities;
}

interface PanelNote {
  id: string;
  title: string;
  folderId?: string | null;
  filePath?: string | null;
  wordCount?: number;
  updatedAt?: string;
  properties?: NoteProperties;
}

interface ProjectContext { name: string; path: string; folderId: string | null; folderIds: Set<string | null>; }

interface FolderEntry extends FolderNode { path: string; }

interface SessionRenameState { id: string; title: string; }

interface RoutingClarificationState {
  message: string;
  route: AiRouteDecision;
}

interface SendOptions {
  preferModel?: boolean;
  mode?: string;
  displayMessage?: string;
  regenerate?: boolean;
  skipUserMessage?: boolean;
  runId?: string;
  resumeRun?: boolean;
  sessionId?: string;
  context?: Record<string, unknown>;
  attachments?: AiAttachment[];
  toolCheckpoint?: AiToolCheckpoint | null;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolResults?: Array<{ callId: string; result: Record<string, unknown> }>;
  continuation?: boolean;
}

interface ProviderContinuation {
  calls: NonNullable<AiStreamPayload['toolCalls']>;
  results: Array<{ callId: string; result: Record<string, unknown> }>;
  context?: Record<string, unknown>;
  sourceRunId?: string;
}

interface AiStreamPayload extends AiStreamFinalPayload {
  reply?: string;
  suggestions?: AiMessageSuggestion[];
  references?: AiReference[];
  reasoning?: string;
  actions?: AiAction[];
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  meta?: AiMessageMeta | null;
}

interface SessionMessagesResponse { session?: AiSessionSummary | null; data?: { session?: AiSessionSummary | null } | null; [key: string]: unknown; }

interface AIAssistantPanelProps {
  open: boolean;
  onClose: () => void;
  onNewChat?: () => void;
  initialSessionId?: string;
  onSessionChange?: (sessionId: string, title: string) => void;
  noteIndex?: NoteIndexRow[];
  folders?: FolderNode[];
  activeNote?: NoteDetailRow | null;
  onOpenNote?: (noteId: string | null, target?: AiNoteNavigationTarget) => void | Promise<unknown>;
  /** 把一条 AI 回答保存为笔记（引用自动转 [[双链]] 来源节） */
  onSaveToNote?: (draft: { title: string; content: string }) => void | Promise<unknown>;
  onOperationComplete?: () => void | Promise<unknown>;
  initialPrompt?: string;
  initialPromptPreferModel?: boolean;
  onInitialPromptConsumed?: () => void;
  expertId?: string;
  expert?: PanelExpert | null;
  experts?: PanelExpert[];
  onSelectExpert?: (expertId: string) => void;
  onOpenExpertManager?: (tab?: 'experts' | 'skills' | 'mcp') => void;
  onOpenSettings?: (section?: unknown) => void;
  workspaceIdentity?: string | null;
}

interface SessionRenameDialogProps {
  open: boolean;
  title: string;
  saving: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onChange: (title: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}

interface RunConsoleProps {
  stages: AiRunStage[];
  open: boolean;
  onToggle: () => void;
  active: boolean;
  webSearch: boolean;
}

interface DurableRunPayload {
  message?: unknown;
  sessionId?: unknown;
  mode?: unknown;
  context?: unknown;
}

function asDurableRunPayload(value: unknown): DurableRunPayload {
  return value && typeof value === 'object' ? value as DurableRunPayload : {};
}

function recoveryStatusLabel(status: string): string {
  return status === 'queued' ? '排队中' : status === 'running' ? '执行中' : status === 'completed' ? '等待确认' : status === 'failed' ? '已失败' : '已取消';
}

function recoveryKindLabel(kind: DurableRunRecovery['recoveryKind']): string {
  return kind === 'run_resume'
    ? '可继续运行'
    : kind === 'read_replayable'
    ? '只读步骤可安全重放'
    : kind === 'write_payload_unavailable'
      ? '写入内容未保存，需重新生成计划'
      : kind === 'tool_replay_unavailable'
        ? '工具状态未保存，需重新提交任务'
      : '需要重新确认写入计划';
}

// 这里的「执行」是调用文件内核 / AI 动作的 HTTP 接口，与 SQL 无关；
// 为免静态扫描把 execute + 变量传参误判为动态 SQL，解构时即改名
const aiController = createAiController();
const tauriAiRunClient = createTauriDurableRunClient({
  invoke: (command, args) => invoke(command, args),
});
const tauriAiTransport = createTauriDurableRunTransport({
  invoke: (command, args) => invoke(command, args),
});
const tauriAiRouterTransport = createAiProviderRouterTransport({
  stream: tauriAiTransport.stream,
  getResumeSequence: async (runId) => {
    const events = await tauriAiRunClient.events(runId, 0, 10_000);
    return events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0);
  },
});
const tauriAiController = createAiController({
  streamChat: (input, options) => tauriAiRouterTransport.stream(input as AiProviderRequest, options),
});
const aiRetrievalCache = createAiRetrievalCache<unknown>({ ttlMs: 30_000, maxEntries: 24 });
const smallModelClient = createSmallModelClient((command, args) => invoke(command, args));
const aiOperationAdapter = createAiOperationAdapter({
  preview: aiApi.preview,
  execute: aiApi.execute,
  undo: filesApi.undo,
});
const aiOperationPlanner = createAiOperationPlanner({
  preview: aiApi.preview,
  filePreview: filesApi.preview,
});

const LAST_SESSION_KEY = 'lattice-ai-active-session-v2';
const LAST_DRAFT_KEY = 'lattice-ai-draft-v1';
const SYSTEM_ROOT_FOLDERS = new Set(['inbox', 'daily', 'journal']);
const CONTEXT_SCOPE_META: Record<string, { capability: string; label: string }> = {
  current: { capability: 'current-note', label: '当前笔记' },
  project: { capability: 'project', label: '当前项目' },
  all: { capability: 'vault', label: '全库' },
  inbox: { capability: 'inbox', label: 'Inbox' },
};
const CONTEXT_CAPABILITY_LABELS: Record<string, string> = {
  'current-note': '当前笔记',
  project: '项目',
  vault: '全库',
  inbox: 'Inbox',
};
const WRITE_POLICY_LABELS: Record<string, string> = {
  disabled: '只读',
  confirm: '写入需确认',
  auto: '任务模式（需确认）',
};
const ROUTING_CLARIFICATION_OPTIONS = [
  { label: '回答问题', prompt: '请直接回答我的问题。' },
  { label: '搜索知识库', prompt: '请先搜索知识库，再给出答案。' },
  { label: '写作或改写', prompt: '请把它作为写作或改写任务处理。' },
  { label: '执行文件操作', prompt: '请把它作为文件操作任务处理，先说明计划。' },
] as const;
// The local UI has one owner. Keep the compatibility value for older server APIs,
// but do not expose or derive permissions from a user role in this panel.
const LOCAL_OWNER_ROLE = 'editor';
const LATTICE_FILE_OPERATION_TOOL = {
  name: 'lattice_file_operation',
  kind: 'write',
  riskLevel: 'L1',
  description: '提出一个本地 Vault 文件操作计划；实际写入必须经过预览和用户确认。',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['create', 'update', 'delete', 'move', 'copy'] },
      path: { type: 'string', description: 'Vault 相对路径' },
      targetPath: { type: 'string', description: '移动或复制的目标 Vault 相对路径' },
      content: { type: 'string', description: '创建或更新时的文件内容' },
    },
    required: ['type', 'path'],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  supportsUndo: true,
  idempotent: true,
} as const;

function actionsFromProviderToolCalls(calls: AiStreamPayload['toolCalls']): AiAction[] {
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => {
    if (!call || call.name !== LATTICE_FILE_OPERATION_TOOL.name || !call.input || typeof call.input !== 'object') return [];
    const type = String(call.input.type ?? '').trim().toLowerCase();
    if (!['create', 'update', 'delete', 'move', 'copy'].includes(type)) return [];
    const path = typeof call.input.path === 'string' ? call.input.path : undefined;
    if (!path?.trim()) return [];
    return [{
      ...call.input,
      id: call.id,
      type,
      path,
      ...(typeof call.input.targetPath === 'string' ? { targetPath: call.input.targetPath } : {}),
      ...(typeof call.input.content === 'string' ? { content: call.input.content } : {}),
    } as AiAction];
  });
}

function toolResultsFromExecution(
  calls: NonNullable<AiStreamPayload['toolCalls']>,
  results: OperationResult[],
  readResults: ProviderReadExecutionResult[] = [],
) {
  const byId = new Map(results.map((item) => [String(item.id ?? ''), item]));
  const readById = new Map(readResults.map((item) => [item.id, item]));
  return calls.map((call) => {
    const readItem = readById.get(call.id);
    if (readItem) return { callId: call.id, result: readItem.result };
    const item = byId.get(call.id);
    const operationId = typeof item?.result?.operationId === 'string'
      ? item.result.operationId
      : typeof item?.operationId === 'string' ? item.operationId : null;
    const operationIds = Array.isArray(item?.operationIds)
      ? item.operationIds.filter((value): value is string => typeof value === 'string')
      : Array.isArray(item?.result?.operationIds)
        ? item.result.operationIds.filter((value): value is string => typeof value === 'string')
        : [];
    const safeResult: Record<string, unknown> = {
      status: item?.status ?? 'failed',
      ...(item?.path ? { path: item.path } : {}),
      ...(item?.targetPath ? { targetPath: item.targetPath } : {}),
      ...(operationId ? { operationId } : {}),
      ...(operationIds.length ? { operationIds } : {}),
      ...(item?.error ? { error: String(item.error).slice(0, 500) } : {}),
    };
    return { callId: call.id, result: safeResult };
  });
}

function stablePanelFingerprint(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function buildPanelContentVersion(notes: readonly PanelNote[]): string {
  return stablePanelFingerprint(notes
    .map((note) => `${note.id}|${note.filePath ?? note.title}|${note.updatedAt ?? ''}|${note.wordCount ?? ''}`)
    .sort()
    .join('\n'));
}

function expertAllowsScope(expert: PanelExpert | null | undefined, scope: string): boolean {
  if (!scope || scope === 'auto') return true;
  const allowed = new Set(expert?.capabilities?.context ?? ['current-note', 'project', 'vault']);
  if (scope === 'project') return allowed.has('project') || allowed.has('vault');
  if (scope === 'inbox') return allowed.has('inbox') || allowed.has('vault');
  return allowed.has(CONTEXT_SCOPE_META[scope]?.capability as string);
}

function normalizeContextScope(expert: PanelExpert | null | undefined, scope: string, { activeNote = null, projectContext = null, hasInbox = false }: { activeNote?: NoteDetailRow | null; projectContext?: ProjectContext | null; hasInbox?: boolean } = {}) {
  const autoCandidates = expert?.id === 'general'
    ? ['project', 'current', 'all', 'inbox']
    : ['project', 'current', 'inbox', 'all'];
  const candidates = scope === 'auto'
    ? autoCandidates
    : [scope, 'project', 'current', 'inbox', 'all'];
  for (const candidate of candidates) {
    if (!CONTEXT_SCOPE_META[candidate] || !expertAllowsScope(expert, candidate)) continue;
    if (candidate === 'current' && !activeNote) continue;
    if (candidate === 'project' && !projectContext) continue;
    if (candidate === 'inbox' && !hasInbox) continue;
    return candidate;
  }
  return 'none';
}

function expertContextLabels(expert: PanelExpert | null | undefined): string[] {
  const context = expert?.capabilities?.context ?? ['current-note', 'project', 'vault'];
  const labels = [...new Set(context.map((item) => CONTEXT_CAPABILITY_LABELS[item] ?? item).filter(Boolean))];
  return labels.length ? labels : ['无上下文'];
}

const WELCOME_MESSAGE: AiMessage = {
  id: 'ai-welcome',
  role: 'assistant',
  content: '你好，我是 Lattice 知识库助手。可以直接问「这篇笔记讲了什么」，我会检索全库相关知识并给出带来源引用的回答；也可以让我搜索、整理、编辑或移动文件，写操作前都会先给出可确认的预览。',
  suggestions: ['总结当前笔记的内容', '搜索最近修改的项目笔记', '检查当前笔记的 Markdown 问题'],
};

function newSessionId() {
  return `sess-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`;
}

function readStoredDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStoredDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // 隐私模式或存储配额不足时，草稿仍保留在当前组件状态中。
  }
}

const LOCAL_AI_SESSIONS_KEY = 'lattice:ai:sessions:v1';

interface LocalAiSession extends AiSessionSummary {
  expertId: string;
  messages: SessionMessage[];
}

function readLocalAiSessions(expertId: string, workspaceIdentity?: string | null): LocalAiSession[] {
  try {
    const raw = localStorage.getItem(aiStorageKey(LOCAL_AI_SESSIONS_KEY, workspaceIdentity));
    const parsed = raw ? JSON.parse(raw) : {};
    const rows = Array.isArray(parsed?.[expertId]) ? parsed[expertId] : [];
    return rows
      .filter((row: LocalAiSession) => row && typeof row.id === 'string' && row.expertId === expertId)
      .map((row) => ({ ...row, title: safeSessionTitle(row.title) }));
  } catch {
    return [];
  }
}

function writeLocalAiSessions(expertId: string, rows: LocalAiSession[], workspaceIdentity?: string | null) {
  try {
    const storageKey = aiStorageKey(LOCAL_AI_SESSIONS_KEY, workspaceIdentity);
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    localStorage.setItem(storageKey, JSON.stringify({
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      [expertId]: rows.slice(0, 80),
    }));
  } catch {
    // 本地存储不可用时，当前内存中的对话仍然可以继续使用。
  }
}

function localAiSessionTitle(content: string) {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 34 ? `${compact.slice(0, 34)}…` : compact || '新对话';
}

function safeSessionTitle(value: unknown, fallback = '新对话'): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || /^(undefined|null|nan)$/i.test(title)) return fallback;
  return title;
}

const SESSION_PAGE_SIZE = 20;

function sessionDateGroup(value: string | number | null | undefined, now: Date = new Date()): string {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return '更早';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.floor((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return '上周';
  return '更早';
}

function groupSessionsByDate(rows: AiSessionSummary[]): Array<[string, AiSessionSummary[]]> {
  const groups = new Map<string, AiSessionSummary[]>([
    ['今天', []],
    ['昨天', []],
    ['上周', []],
    ['更早', []],
  ]);
  for (const row of rows) groups.get(sessionDateGroup(row.updatedAt))!.push(row);
  return [...groups.entries()].filter(([, items]) => items.length);
}

// 流式原始输出里，动作围栏与「自动读取」标记不直接展示给用户
function displayStreamText(raw: string): string {
  const fence = raw.match(/```lattice[-_]actions/i);
  const visible = fence ? raw.slice(0, fence.index) : raw;
  return visible.replace(/\[\[自动读取文件中…\]\]/g, '').trimEnd();
}

function createInitialProgress(): ProgressStep[] {
  return [
    { id: 'client-request', label: '接收任务', detail: '已发送到 AI 助手', status: 'completed' },
    { id: 'client-working', label: '等待执行状态', detail: '正在连接任务进度', status: 'running' },
  ];
}

function mergeProgressStep(steps: ProgressStep[], event: AiStreamEvent | null | undefined): ProgressStep[] {
  if (!event?.id || !event?.label) return steps;
  const next = { id: String(event.id), label: String(event.label), status: (event.status as string | undefined) ?? 'pending', detail: String(event.detail ?? '') };
  const index = steps.findIndex((step) => step.id === next.id);
  if (index < 0) return [...steps.filter((step) => step.id !== 'client-working'), next];
  return steps.map((step, itemIndex) => itemIndex === index ? { ...step, ...next } : step);
}

function mergeRuntimeToolProgress(steps: ProgressStep[], event: AiRunEvent): ProgressStep[] {
  if (event.type !== 'tool_call' && event.type !== 'tool_result') return steps;
  const payload = event.payload ?? {};
  const callId = String(payload.callId ?? payload.id ?? payload.toolName ?? payload.tool ?? 'unknown');
  const toolName = String(payload.toolName ?? payload.tool ?? payload.name ?? '工具');
  const failed = event.type === 'tool_result' && (payload.ok === false || Boolean(payload.error));
  const duration = Number(payload.durationMs);
  const detail = event.type === 'tool_call'
    ? '正在执行…'
    : failed
      ? String(payload.error ?? '执行失败')
      : Number.isFinite(duration) && duration >= 0 ? `已完成 · ${duration}ms` : '已完成';
  const next = {
    id: `tool-${callId}`,
    label: `工具：${toolName}`,
    status: event.type === 'tool_call' ? 'running' : failed ? 'failed' : 'completed',
    detail,
  };
  const index = steps.findIndex((step) => step.id === next.id);
  if (index < 0) return [...steps.filter((step) => step.id !== 'client-working'), next];
  return steps.map((step, itemIndex) => itemIndex === index ? { ...step, ...next } : step);
}

function updateProgressDetail(steps: ProgressStep[], detail: string | null | undefined): ProgressStep[] {
  const index = [...steps].reverse().findIndex((step) => step.status === 'running' || step.status === 'pending');
  if (index < 0) return steps;
  const actualIndex = steps.length - index - 1;
  return steps.map((step, itemIndex) => itemIndex === actualIndex ? { ...step, detail: String(detail ?? '') } : step);
}

function completeProgress(steps: ProgressStep[], { awaitingConfirmation = false }: { awaitingConfirmation?: boolean } = {}): ProgressStep[] {
  const normalized = steps.map((step) => step.status === 'failed' || step.status === 'waiting'
    ? step
    : awaitingConfirmation
      ? { ...step, status: 'waiting', detail: step.detail || '文件操作等待确认' }
      : { ...step, status: 'completed', detail: step.detail || '已完成' });
  if (!awaitingConfirmation || normalized.some((step) => step.status === 'waiting')) return normalized;
  return [...normalized, {
    id: 'client-confirmation',
    label: '等待确认',
    detail: '文件操作不会自动执行',
    status: 'waiting',
  }];
}

function failProgress(steps: ProgressStep[], detail: string | null | undefined): ProgressStep[] {
  const index = [...steps].reverse().findIndex((step) => step.status === 'running' || step.status === 'pending');
  if (index < 0) return steps;
  const actualIndex = steps.length - index - 1;
  return steps.map((step, itemIndex) => itemIndex === actualIndex
    ? { ...step, status: 'failed', detail: detail || '执行失败' }
    : step);
}

export default function AIAssistantPanel({ open, onClose, onNewChat, initialSessionId, onSessionChange, noteIndex = [], folders = [], activeNote, onOpenNote, onSaveToNote, onOperationComplete, initialPrompt = '', initialPromptPreferModel = false, onInitialPromptConsumed, expertId = 'general', expert = null, experts = [], onSelectExpert, onOpenExpertManager, onOpenSettings, workspaceIdentity = null }: AIAssistantPanelProps) {
  const sessionStorageKey = `${aiStorageKey(LAST_SESSION_KEY, workspaceIdentity)}:${expertId}`;
  const draftStorageKey = `${aiStorageKey(LAST_DRAFT_KEY, workspaceIdentity)}:${expertId}`;
  const storageNamespace = workspaceIdentity;
  const [messages, setMessages] = useState<AiMessage[]>([WELCOME_MESSAGE]);
  const [draft, setDraft] = useState(() => readStoredDraft(draftStorageKey));
  const [attachments, setAttachments] = useState<AiAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [digesting, setDigesting] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [activeTaskMode, setActiveTaskMode] = useState(false);
  // 推理模型的思维链（delta.reasoning_content）：流式滚动展示，完成后折叠进消息
  const [reasoningText, setReasoningText] = useState('');
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [settings, setSettings] = useState(() => loadAiSettings());
  const [composerMenu, setComposerMenu] = useState<'model' | 'approval' | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [personalizationName, setPersonalizationName] = useState('');
  const [personalizationInstruction, setPersonalizationInstruction] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [contextScopePreference, setContextScopePreference] = useState<ContextScopePreference>('auto');
  const [runConsoleOpen, setRunConsoleOpen] = useState(false);
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [sessionQuery, setSessionQuery] = useState('');
  const [sessionsReady, setSessionsReady] = useState(false);
  const [aiMemories, setAiMemories] = useState<MemoryRecord[]>([]);
  const [recoverableRuns, setRecoverableRuns] = useState<DurableRunRecovery[]>([]);
  const [recoveryBusyRunId, setRecoveryBusyRunId] = useState('');
  const [sessionBrowserOpen, setSessionBrowserOpen] = useState(false);
  const [sessionBrowserQuery, setSessionBrowserQuery] = useState('');
  const [sessionBrowserSearchContent, setSessionBrowserSearchContent] = useState(false);
  const [sessionBrowserPage, setSessionBrowserPage] = useState(0);
  const [sessionBrowserRows, setSessionBrowserRows] = useState<AiSessionSummary[]>([]);
  const [sessionBrowserMeta, setSessionBrowserMeta] = useState<{ total?: number; hasMore?: boolean }>({ total: 0, hasMore: false });
  const [sessionBrowserLoading, setSessionBrowserLoading] = useState(false);
  const [sessionBrowserDeleteId, setSessionBrowserDeleteId] = useState('');
  const [sessionBrowserReload, setSessionBrowserReload] = useState(0);
  const [sessionId, setSessionId] = useState(() => {
    if (initialSessionId?.trim()) return initialSessionId;
    try {
      const stored = localStorage.getItem(sessionStorageKey);
      return stored && stored.trim() ? stored : newSessionId();
    } catch {
      return newSessionId();
    }
  });
  const [preview, setPreview] = useState<OperationPreviewData | null>(null);
  const [undoBusyAll, setUndoBusyAll] = useState(false);
  const [execution, setExecution] = useState<ExecutionResult | null>(null);
  const [error, setError] = useState('');
  const [retryMessage, setRetryMessage] = useState('');
  const lastRunRequestRef = useRef<{ runId: string; message: string; sessionId: string; context?: Record<string, unknown>; mode: string } | null>(null);
  const retryRunIdRef = useRef<string | null>(null);
  const [related, setRelated] = useState<RelatedNote[]>([]);
  const [relatedOpen, setRelatedOpen] = useState(false);
  // 通用专家下发送消息后，按 routing 关键词给出的切换建议（服务端 /experts/route 打分）
  const [expertSuggestion, setExpertSuggestion] = useState<Expert | null>(null);
  // 会话重命名：Electron 不支持 window.prompt，改用面板内 Modal
  const [sessionRename, setSessionRename] = useState<SessionRenameState | null>(null);
  const [sessionRenameSaving, setSessionRenameSaving] = useState(false);
  const [routingClarification, setRoutingClarification] = useState<RoutingClarificationState | null>(null);
  const sessionRenameInputRef = useRef<HTMLInputElement | null>(null);
  // 任务模式消息的批量撤销：operationId 来自服务端 meta.executedOperations
  const [taskUndoBusyId, setTaskUndoBusyId] = useState('');
  const [undoneTaskMessages, setUndoneTaskMessages] = useState<Set<string>>(() => new Set());
  const abortRef = useRef<AbortController | null>(null);
  const notifiedRunIdsRef = useRef(new Set<string>());
  const activeRunIdRef = useRef<string | null>(null);
  const pendingToolCallsRef = useRef<NonNullable<AiStreamPayload['toolCalls']>>([]);
  const pendingReadToolResultsRef = useRef<ProviderReadExecutionResult[]>([]);
  const pendingContinuationRef = useRef<ProviderContinuation | null>(null);
  const sendInFlightRef = useRef(false);
  const toolCheckpointRef = useRef<AiToolCheckpoint | null>(null);
  const forceModelRef = useRef(false);
  const progressStepsRef = useRef<ProgressStep[]>([]);
  const loadedSessionRef = useRef<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const streamTextRef = useRef('');
  const streamStatusRef = useRef('');
  const reasoningRef = useRef('');
  // U2：思考流起点（首个 reasoning 事件），流式徽标实时显示已思考时长，done 时落 meta.reasoningMs
  const reasoningStartedAtRef = useRef(0);
  // U2 FileChangesCard：预览构建时统计 ±行数的文件变更，随执行后续跑的 done 挂到回答 meta
  const pendingFileChangesRef = useRef<AiFileChange[]>([]);
  // U3 变体切换：重新生成时被替换的回答（会话内存，不进持久化会话）
  const replacedAnswerRef = useRef<AiMessage | null>(null);
  // U3 虚拟列表：长会话窗口化（超过阈值才启用，常规会话行为零变化）
  const virtualScrollRef = useRef({ offset: 0, viewport: 0 });
  const [virtualScrollTick, setVirtualScrollTick] = useState(0);
  const measuredHeightsRef = useRef(new Map<number, number>());
  // U3 反馈：每条回答至多一次 👍/👎（会话内存）
  const [feedbackGivenMap, setFeedbackGivenMap] = useState<Record<string, 'up' | 'down'>>({});
  const runMetricsRef = useRef<AiRunMetrics | null>(null);
  const streamFrameRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const scrollPositionsRef = useRef(new Map<string, { scrollTop: number; stickToBottom: boolean }>());
  const toast = useToast();

  const persistToolCheckpoint = async (checkpoint: AiToolCheckpoint) => {
    toolCheckpointRef.current = checkpoint;
    const runId = activeRunIdRef.current;
    if (!runId || !isTauri()) return;
    try {
      await tauriAiRunClient.checkpoint(runId, checkpoint);
    } catch {
      // Checkpoint persistence is best effort; the operation result remains authoritative.
    }
  };

  const commitProgressSteps = (nextSteps: ProgressStep[] | ((current: ProgressStep[]) => ProgressStep[])) => {
    setProgressSteps((current) => {
      const next = typeof nextSteps === 'function' ? nextSteps(current) : nextSteps;
      progressStepsRef.current = next;
      return next;
    });
  };

  const activeProvider = getActiveAiProvider(settings);
  const connectionState = !hasExternalAi(settings) ? 'local' : activeProvider?.verified ? 'connected' : 'configured';
  const composerBusy = sending || digesting;
  // 头像状态：错误 > 生成中（任务模式算写入）> 待命。
  // 本地模式（未配置外部模型）不算"离线失败"，第一印象不该是睡觉的脸；
  // offline 状态留给设置页的连接诊断与真正断连。
  const avatarBase: GlimState = error
    ? 'error'
    : sending
      ? (activeTaskMode ? 'writing' : 'thinking')
      : 'idle';
  const avatarState = useGlimState(avatarBase);
  const workspaceLabel = useMemo(() => deriveWorkspaceLabel(workspaceIdentity), [workspaceIdentity]);
  const attachmentsRequireExternalModel = attachments.length > 0 && !hasExternalAi(settings);
  // W7c 能力协商：probe 实测 nativeTools=false 的模型不支持工具调用面，
  // 任务模式显式降级（置灰 + 原因），而不是静默失败。
  const taskModeUnsupported = activeProvider?.nativeTools === false;
  const taskModeEnabled = (settings.interactionMode === 'task' || settings.autoApprove === true) && !taskModeUnsupported;
  const approvalLabel = taskModeEnabled ? '自动' : '为我审核';
  const activeSessionTitle = safeSessionTitle(sessions.find((session) => session.id === sessionId)?.title, '新对话');

  useEffect(() => {
    if (open) onSessionChange?.(sessionId, sessions.find((session) => session.id === sessionId)?.title?.trim() || 'Lattice AI');
  }, [open, onSessionChange, sessionId, sessions]);

  const flushStream = () => {
    streamFrameRef.current = 0;
    setStreamText(streamTextRef.current);
    setStreamStatus(streamStatusRef.current);
    setReasoningText(reasoningRef.current);
  };
  const queueStreamFlush = () => {
    if (streamFrameRef.current) return;
    streamFrameRef.current = requestAnimationFrame(flushStream);
  };

  useEffect(() => () => {
    if (streamFrameRef.current) cancelAnimationFrame(streamFrameRef.current);
  }, []);

  useEffect(() => subscribeAiSettings(setSettings), []);
  useEffect(() => {
    hydrateAiSettingsFromServer();
  }, []);

  useEffect(() => {
    setExpertSuggestion(null);
  }, [expertId]);

  useEffect(() => {
    setDraft(readStoredDraft(draftStorageKey));
  }, [draftStorageKey]);

  useEffect(() => {
    loadedSessionRef.current = null;
    setMessages([WELCOME_MESSAGE]);
    setPreview(null);
    setExecution(null);
    setRoutingClarification(null);
     commitProgressSteps([]);
    setError('');
    setSessionId(() => {
      if (initialSessionId?.trim()) return initialSessionId;
      try {
        return localStorage.getItem(sessionStorageKey) || newSessionId();
      } catch {
        return newSessionId();
      }
    });
  }, [expertId, initialSessionId, sessionStorageKey]);

  const requestOptions = useMemo<RequestOptions>(() => {
    const accessToken = settings.accessToken?.trim();
    return accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};
  }, [settings.accessToken]);

  const sessionStore = useMemo(() => createAiSessionStore({
    list: async () => {
      const localRows = readLocalAiSessions(expertId, storageNamespace);
      let remoteRows: AiSessionSummary[] = [];
      try {
        const response = await aiApi.listSessions({ query: { expertId, limit: 8 }, ...requestOptions });
        const rows = response?.data ?? response ?? [];
        remoteRows = Array.isArray(rows) ? rows : [];
      } catch {
        // 桌面端当前没有服务端会话 API，使用本地索引保证历史仍可见。
      }
      const recentRows = [...remoteRows, ...localRows]
        .filter((session, index, rows) => rows.findIndex((item) => item.id === session.id) === index)
        .sort((left, right) => new Date(right.updatedAt ?? 0).getTime() - new Date(left.updatedAt ?? 0).getTime())
        .slice(0, 80);
      try {
        const storedId = localStorage.getItem(sessionStorageKey);
        if (storedId && !recentRows.some((session) => session.id === storedId)) {
          const selectedResponse = (await aiApi.sessionMessages(storedId, requestOptions)) as unknown as SessionMessagesResponse;
          const candidate = selectedResponse?.session ?? selectedResponse?.data?.session ?? null;
          if (candidate?.expertId === expertId) return [candidate, ...recentRows];
        }
      } catch {
        // 本地新会话可能尚未写入服务端，保留当前会话并等待首次发送创建。
      }
      return recentRows;
    },
    messages: async (id) => {
      const local = readLocalAiSessions(expertId, storageNamespace).find((session) => session.id === id);
      try {
        const response = (await aiApi.sessionMessages(id, requestOptions)) as unknown as SessionMessagesResponse;
        const payload = (response?.data ?? response ?? {}) as { messages?: SessionMessage[] | null };
        const remoteMessages = payload.messages ?? [];
        if (remoteMessages.length || !local?.messages?.length) return remoteMessages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          payload: message.payload ?? null,
        }));
      } catch {
        // 本地会话是桌面端的持久化兜底。
      }
      return local?.messages ?? [];
    },
    rename: async (id, title) => {
      const rows = readLocalAiSessions(expertId, storageNamespace);
      const next = rows.map((row) => row.id === id ? { ...row, title, updatedAt: new Date().toISOString() } : row);
      writeLocalAiSessions(expertId, next, storageNamespace);
      try {
        await aiApi.renameSession(id, title, requestOptions);
      } catch {
        // 服务端未接入时，本地重命名仍然生效。
      }
    },
    remove: async (id) => {
      writeLocalAiSessions(expertId, readLocalAiSessions(expertId, storageNamespace).filter((row) => row.id !== id), storageNamespace);
      try {
        await aiApi.deleteSession(id, requestOptions);
      } catch {
        // 服务端未接入时，本地删除仍然生效。
      }
    },
  }), [expertId, requestOptions, sessionStorageKey, storageNamespace]);

  useEffect(() => {
    const unsubscribe = sessionStore.subscribe((next) => setSessions(next.rows));
    return () => { unsubscribe(); };
  }, [sessionStore]);

  // 会话列表（服务端持久化，跨端可用）
  // stale 防护：快速切换 expertId 时两个请求并发，旧闭包的响应后到会覆盖
  // 新专家的会话列表（消息恢复的 effect 有 cancelled 守卫，这里补齐）
  const expertIdRef = useRef(expertId);
  useEffect(() => {
    expertIdRef.current = expertId;
  }, [expertId]);

  const refreshSessions = useCallback(async () => {
    const requestExpertId = expertId;
    try {
      const recentRows = await sessionStore.refresh();
      if (expertIdRef.current !== requestExpertId) return;
      setSessions(recentRows);
    } catch {
      // 会话列表加载失败不影响当前对话
    } finally {
      setSessionsReady(true);
    }
  }, [expertId, requestOptions, sessionStore]);

  useEffect(() => {
    if (!sessionBrowserOpen) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSessionBrowserLoading(true);
      try {
        const response = await aiApi.listSessions({
          query: {
            expertId,
            query: sessionBrowserQuery.trim(),
            searchContent: sessionBrowserSearchContent ? 'true' : 'false',
            limit: SESSION_PAGE_SIZE,
            offset: sessionBrowserPage * SESSION_PAGE_SIZE,
          },
          ...requestOptions,
        });
        if (cancelled) return;
        setSessionBrowserRows(Array.isArray(response?.data) ? response.data : []);
        setSessionBrowserMeta(response?.meta ?? { total: response?.data?.length ?? 0, hasMore: false });
      } catch (requestError: any) {
        try {
          const localRows = await sessionStore.refresh();
          if (cancelled) return;
          const query = sessionBrowserQuery.trim().toLowerCase();
          const filtered = localRows.filter((row) => !query || String(row.title ?? '').toLowerCase().includes(query));
          const offset = sessionBrowserPage * SESSION_PAGE_SIZE;
          setSessionBrowserRows(filtered.slice(offset, offset + SESSION_PAGE_SIZE));
          setSessionBrowserMeta({ total: filtered.length, hasMore: offset + SESSION_PAGE_SIZE < filtered.length });
        } catch {
          if (!cancelled) setError(requestError?.message ?? '会话历史加载失败');
        }
      } finally {
        if (!cancelled) setSessionBrowserLoading(false);
      }
    }, sessionBrowserQuery.trim() ? 220 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [expertId, requestOptions, sessionBrowserOpen, sessionBrowserPage, sessionBrowserQuery, sessionBrowserReload, sessionBrowserSearchContent, sessionStore]);

  useEffect(() => {
    if (!open) return;
    loadedSessionRef.current = null;
    setSessionsReady(false);
    refreshSessions();
  }, [open, refreshSessions]);

  useEffect(() => {
    if (!isTauri()) {
      setRecoverableRuns([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const found = await scanDurableRuns(tauriAiRunClient, storageNamespace);
      if (!cancelled) setRecoverableRuns(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, storageNamespace]);

  // 切换会话时从服务端拉取历史消息
  useEffect(() => {
    if (!open || !sessionId || !sessionsReady) return;
    // 刷新会话列表不等于切换会话；避免覆盖正在等待确认的文件预览。
    if (loadedSessionRef.current === sessionId) return;
    loadedSessionRef.current = sessionId;
    if (!sessions.some((session) => session.id === sessionId)) {
      setMessages((current) => restoreAiMessages(current, [], WELCOME_MESSAGE));
      setPreview(null);
      setExecution(null);
      setError('');
      return undefined;
    }
    try {
      localStorage.setItem(sessionStorageKey, sessionId);
    } catch {
      // 忽略持久化失败
    }
    let cancelled = false;
    (async () => {
      try {
        const restoredMessages = await sessionStore.select(sessionId);
        if (cancelled) return;
        const restored: AiMessage[] = restoredMessages.map((message) => ({
          id: message.id,
          role: message.role as AiMessageRole,
          content: message.content,
          suggestions: (message.payload?.suggestions ?? []) as AiMessageSuggestion[],
          references: (message.payload?.references ?? []) as AiReference[],
          reasoning: message.payload?.reasoning ?? '',
          meta: message.payload?.meta as AiMessageMeta | null ?? null,
        }));
        setMessages((current) => restoreAiMessages(current, restored, WELCOME_MESSAGE));
        setPreview(null);
        setExecution(null);
        setError('');
      } catch {
        if (!cancelled) setMessages((current) => restoreAiMessages(current, [], WELCOME_MESSAGE));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, requestOptions, sessionStore, sessions, sessionsReady]);

  // 相关笔记：语义索引就绪时，随当前笔记变化自动刷新（Reor 式「写作时浮现」）
  useEffect(() => {
    if (!open || !activeNote?.id) {
      setRelated([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = (await aiApi.relatedNotes(activeNote.id, 5, requestOptions)) as unknown as HttpEnvelope;
        if (!cancelled) setRelated((response?.data ?? response ?? []) as RelatedNote[]);
      } catch {
        if (!cancelled) setRelated([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeNote?.id, requestOptions]);

  // 新消息 / 流式输出时滚到最新
  useEffect(() => {
    const container = messagesRef.current;
    if (!container || !stickToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
    if (sessionId) {
      scrollPositionsRef.current.set(sessionId, {
        scrollTop: container.scrollTop,
        stickToBottom: true,
      });
    }
  }, [execution, messages, preview, sending, sessionId, streamText]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return undefined;
    const updateScrollIntent = () => {
      const stickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 96;
      stickToBottomRef.current = stickToBottom;
      if (sessionId) {
        scrollPositionsRef.current.set(sessionId, {
          scrollTop: container.scrollTop,
          stickToBottom,
        });
      }
    };
    container.addEventListener('scroll', updateScrollIntent, { passive: true });
    return () => container.removeEventListener('scroll', updateScrollIntent);
  }, [open, sessionId]);

  useLayoutEffect(() => {
    if (!open || !sessionId || !sessionsReady) return;
    const container = messagesRef.current;
    if (!container) return;
    const saved = scrollPositionsRef.current.get(sessionId);
    if (saved?.stickToBottom || !saved) {
      container.scrollTop = container.scrollHeight;
      stickToBottomRef.current = true;
      scrollPositionsRef.current.set(sessionId, {
        scrollTop: container.scrollTop,
        stickToBottom: true,
      });
      return;
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.min(Math.max(0, saved.scrollTop), maxScrollTop);
    stickToBottomRef.current = false;
  }, [messages.length, open, sessionId, sessionsReady]);

  // 输入框随内容自动增高，超过上限后内部滚动
  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`;
  }, [draft]);

  const folderEntries = useMemo(() => flattenFolders(folders), [folders]);
  const projectContext = useMemo(() => {
    const activeFolder = folderEntries.find((folder) => folder.id === activeNote?.folderId);
    if (!activeFolder) return null;
    const rootPath = activeFolder.path.split('/')[0];
    if (SYSTEM_ROOT_FOLDERS.has(rootPath.toLowerCase())) return null;
    const rootFolder = folderEntries.find((folder) => folder.path === rootPath);
    const projectFolderIds = new Set<string | null>(
      folderEntries
        .filter((folder) => folder.path === rootPath || folder.path.startsWith(`${rootPath}/`))
        .map((folder) => folder.id),
    );
    return {
      name: rootPath,
      path: rootPath,
      folderId: rootFolder?.id ?? null,
      folderIds: projectFolderIds,
    };
  }, [activeNote?.folderId, folderEntries]);

  const inboxItems = useMemo<PanelNote[]>(
    () => noteIndex.filter((note) => note.properties?.type === 'inbox'),
    [noteIndex],
  );
  const pendingInboxItems = useMemo(
    () => inboxItems.filter((note) => ['captured', 'processing'].includes((note.properties?.status as string | undefined) ?? 'captured')),
    [inboxItems],
  );

  const effectiveContextScope = useMemo(() => {
    return normalizeContextScope(expert, contextScopePreference, {
      activeNote,
      projectContext,
      hasInbox: inboxItems.length > 0,
    });
  }, [activeNote, contextScopePreference, expert, inboxItems.length, projectContext]);

  const contextScopeLabel = effectiveContextScope === 'current'
    ? '当前笔记'
    : effectiveContextScope === 'project'
      ? `项目：${projectContext!.name}`
      : effectiveContextScope === 'inbox'
        ? 'Inbox'
        : effectiveContextScope === 'all'
          ? '全库'
          : '无可用上下文';

  const scopedNoteIndex = useMemo<PanelNote[]>(() => {
    if (effectiveContextScope === 'current') return activeNote ? [activeNote] : [];
    if (effectiveContextScope === 'project' && projectContext) {
      return noteIndex.filter((note) => projectContext.folderIds.has(note.folderId));
    }
    if (effectiveContextScope === 'inbox') return inboxItems;
    if (effectiveContextScope === 'none') return [];
    return noteIndex;
  }, [activeNote, effectiveContextScope, inboxItems, noteIndex, projectContext]);

  const aiPermissionContext = useMemo<AiPermissionContext>(() => {
    const allowedPaths = scopedNoteIndex
      .map((note) => note.filePath ?? '')
      .filter(Boolean)
      .sort();
    return {
      actor: 'local-user',
      role: LOCAL_OWNER_ROLE,
      scopeId: `${effectiveContextScope}:${projectContext?.path ?? activeNote?.filePath ?? ''}`,
      allowedPaths,
      // The local desktop currently has no remote ACL service. Binding the
      // effective path set here still invalidates the cache when scope access
      // changes, while leaving a version slot for a future ACL provider.
      permissionVersion: `local-paths-${stablePanelFingerprint(allowedPaths.join('\n'))}`,
      contentVersion: buildPanelContentVersion(scopedNoteIndex),
    };
  }, [activeNote?.filePath, effectiveContextScope, projectContext?.path, scopedNoteIndex]);

  const expertSummary = useMemo(() => {
    const skillCount = Number.isFinite(expert?.skillCount)
      ? expert!.skillCount
      : (expert?.skills ?? []).filter((skill) => skill.enabled !== false).length;
    const writePolicy = expert?.capabilities?.writePolicy ?? 'confirm';
    return {
      kind: expertId === 'general' ? '通用助手' : '固定专家',
      skillCount,
      contexts: expertContextLabels(expert).join('、'),
      writePolicy: WRITE_POLICY_LABELS[writePolicy] ?? WRITE_POLICY_LABELS.confirm,
    };
  }, [expert, expertId]);

  const context = useMemo(() => ({
    activeFile: activeNote?.filePath ?? activeNote?.title ?? null,
    activeFileContent: typeof activeNote?.content === 'string' ? activeNote.content.slice(0, 12_000) : null,
    project: projectContext ? {
      name: projectContext.name,
      path: projectContext.path,
      folderId: projectContext.folderId,
      fileCount: scopedNoteIndex.length,
    } : null,
    inbox: {
      total: inboxItems.length,
      pending: pendingInboxItems.length,
    },
    files: scopedNoteIndex.slice(0, 100).map((note) => ({
      id: note.id,
      title: note.title,
      path: note.filePath ?? note.title,
      folderId: note.folderId,
      updatedAt: note.updatedAt,
      wordCount: note.wordCount,
      properties: note.properties ?? {},
    })),
    inboxFiles: inboxItems.slice(0, 80).map((note) => ({
      id: note.id,
      title: note.title,
      path: note.filePath ?? note.title,
      folderId: note.folderId,
      updatedAt: note.updatedAt,
      wordCount: note.wordCount,
      properties: note.properties ?? {},
    })),
    folders: folderEntries.slice(0, 80).map((folder) => ({ id: folder.id, name: folder.name, path: folder.path })),
    memory: aiMemories.map((item) => `[${item.kind === 'preference' ? '用户偏好' : '工作区知识'} · 来源：${item.source}]\n${item.content}`),
    scope: effectiveContextScope,
    scopeLabel: contextScopeLabel,
    requestedScope: contextScopePreference,
    permissionContext: aiPermissionContext,
  }), [activeNote, aiMemories, aiPermissionContext, contextScopeLabel, contextScopePreference, effectiveContextScope, folderEntries, inboxItems, pendingInboxItems, projectContext, scopedNoteIndex]);

  const appendMessage = (message: AiMessage) => setMessages((current) => {
    const next = appendAiMessage(current, message, WELCOME_MESSAGE.id);
    const persistedMessages = next
      .filter((item) => item.id !== WELCOME_MESSAGE.id && item.content.trim())
      .map((item) => {
        const { attachments: itemAttachments, ...messageWithoutAttachments } = item;
        return {
          ...messageWithoutAttachments,
          ...(itemAttachments?.length ? {
            attachmentMeta: itemAttachments.map(({ id, name, type, size, kind }) => ({ id, name, type, size, kind })),
          } : {}),
        payload: {
          suggestions: item.suggestions ?? [],
          references: item.references ?? [],
          reasoning: item.reasoning ?? '',
          meta: item.meta ?? null,
        },
        };
      }) as SessionMessage[];
    if (persistedMessages.length) {
      const id = sessionIdRef.current;
      const rows = readLocalAiSessions(expertId, storageNamespace);
      const existing = rows.find((row) => row.id === id);
      const firstUserMessage = persistedMessages.find((item) => item.role === 'user');
      const nextRow: LocalAiSession = {
        id,
        expertId,
        title: safeSessionTitle(existing?.title, localAiSessionTitle(String(firstUserMessage?.content ?? message.content))),
        updatedAt: new Date().toISOString(),
        messages: persistedMessages,
      };
      writeLocalAiSessions(expertId, [nextRow, ...rows.filter((row) => row.id !== id)], storageNamespace);
      setSessions((currentSessions) => [
        nextRow,
        ...currentSessions.filter((row) => row.id !== id),
      ]);
    }
    return next;
  });

  // 流式请求跨会话保护：请求期间用户切换/新建会话时，旧请求的
  // 流式增量、最终回复与预览面板不得写入新会话
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // 项目级 MCP Server（.lattice/mcp.json）缓存：打开面板时重取，发送时直接用。
  // 读取失败不阻断发送——只降级为用户级配置。
  const projectServersRef = useRef<McpServerEntry[] | null>(null);
  useEffect(() => {
    if (open) projectServersRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open || !isTauri()) {
      setAiMemories([]);
      return undefined;
    }
    let cancelled = false;
    memoryApi.list(false)
      .then((items) => { if (!cancelled) setAiMemories(Array.isArray(items) ? items : []); })
      .catch(() => { if (!cancelled) setAiMemories([]); });
    return () => { cancelled = true; };
  }, [open]);

  const resolveMcpServers = async () => {
    let servers = collectActiveMcpServers();
    if (loadMcpSettings().projectEnabled) {
      let projectServers = projectServersRef.current;
      if (!projectServers) {
        try {
          const data = await mcpApi.project();
          projectServers = Array.isArray(data?.servers) ? data.servers : [];
          projectServersRef.current = projectServers;
        } catch {
          projectServers = [];
        }
      }
      servers = mergeProjectServers(servers, projectServers);
    }
    return servers;
  };

  const addAiFiles = async (files: File[]) => {
    if (!files.length || composerBusy) return;
    setAttachmentMenuOpen(false);
    setAttachmentError('');
    const next = [...attachments];
    for (const file of files) {
      const validationError = validateAiAttachment(file, next);
      if (validationError) {
        setAttachmentError(validationError);
        continue;
      }
      try {
        next.push(await createAiAttachment(file, next.length));
      } catch {
        setAttachmentError(`读取「${file.name}」失败，请重新选择`);
      }
    }
    setAttachments(next);
  };

  const removeAiFile = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    setAttachmentError('');
  };

  const send = async (value: string = draft, options: SendOptions = {}) => {
    const requestAttachments = options.attachments ?? (options.resumeRun ? [] : attachments);
    const message = String(value).trim() || (requestAttachments.length ? '请识别并分析我上传的附件。' : '');
    if (!message || (composerBusy && !options.continuation) || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    // U2：全新发送时清掉上一轮预览遗留的文件变更（续跑/确认通道保留，供执行后挂卡）
    if (!options.resumeRun && !options.continuation) pendingFileChangesRef.current = [];
    reasoningStartedAtRef.current = 0;
    const preferModel = options.preferModel ?? (forceModelRef.current || settings.preferModel === true || requestAttachments.length > 0);
    if (requestAttachments.length > 0 && !hasExternalAi(settings)) {
      setAttachmentError('图片识别需要已配置的外部视觉模型。请先在模型设置中配置支持图片的模型。');
      sendInFlightRef.current = false;
      return;
    }
    const requestMode = options.mode ?? (taskModeEnabled ? 'task' : (settings.interactionMode || 'quick'));
    const taskMode = requestMode === 'task';
    const remoteRouting = !options.resumeRun && !options.continuation
      ? await smallModelClient.classifyIntent(settings, message, requestMode, requestAttachments.length > 0).catch(() => null)
      : null;
    const routeDecision = remoteRouting ?? routeAiRequest(message, { mode: requestMode, hasAttachments: requestAttachments.length > 0 });
    if (!options.resumeRun && !options.continuation && routeDecision.requiresClarification) {
      setRoutingClarification({ message, route: routeDecision });
      appendMessage({ id: `user-${Date.now()}`, role: 'user', content: message, attachments: requestAttachments });
      setDraft('');
      writeStoredDraft(draftStorageKey, '');
      setError('');
      sendInFlightRef.current = false;
      return;
    }
    forceModelRef.current = false;
    const requestSessionId = options.sessionId ?? sessionId;
    const runId = options.runId ?? createRunId();
    retryRunIdRef.current = null;
    activeRunIdRef.current = runId;
    pendingToolCallsRef.current = [];
    toolCheckpointRef.current = options.toolCheckpoint ?? null;
    const stale = () => sessionIdRef.current !== requestSessionId;
    const taskType: AiMetricTaskType = taskMode ? 'agent' : planAiQueries(message).requiresRetrieval ? 'retrieval' : 'quick';
    let traceSequence = 0;
    let traceModel = isTauri() && preferModel ? getActiveAiProviderRuntime(settings)?.model : undefined;
    let traceFinishMetadata: Record<string, unknown> = { status: 'failed', terminationReason: 'error' };
    const trace = (eventType: AiTraceEventType, metadata?: Record<string, unknown>) => recordAiRunTraceEvent({
      runId,
      sequence: ++traceSequence,
      eventType,
      taskType,
      model: traceModel,
      metadata,
      storageNamespace,
    });
    const traceMetrics = (metrics: AiRunMetrics | null): Record<string, unknown> => metrics ? {
      durationMs: metrics.durationMs,
      timeToFirstTokenMs: metrics.timeToFirstTokenMs,
      toolDurationMs: metrics.toolDurationMs,
      toolCalls: metrics.toolCalls,
      promptTokens: metrics.promptTokens,
      completionTokens: metrics.completionTokens,
      totalTokens: metrics.totalTokens,
      terminationReason: metrics.terminationReason,
    } : {};
    trace('run_started', { status: options.resumeRun ? 'resumed' : 'queued' });
    // 发送时取一次当前配置：设置页改动对下一条消息生效，不打断进行中的对话
    const mcpServers = options.resumeRun ? [] : (requestMode === 'task' ? await resolveMcpServers().catch(() => []) : []);
    const queryPlan = planAiQueries(message, remoteRouting?.intents ?? []);
    setRoutingClarification(null);
    setDraft('');
    writeStoredDraft(draftStorageKey, '');
    setError('');
    setRetryMessage('');
    setExecution(null);
    setPreview(null);
    setExpertSuggestion(null);
    setActiveTaskMode(taskMode);
    commitProgressSteps(taskMode ? createInitialProgress() : []);
    streamTextRef.current = '';
    streamStatusRef.current = '';
    reasoningRef.current = '';
    runMetricsRef.current = null;
    setStreamText('');
    setStreamStatus('');
    setReasoningText('');
    setReasoningOpen(true);
    // 重新生成时上一条 user 消息已在列表里（仅移除了旧回答），不再重复追加
    if (options.skipUserMessage !== true) {
      appendMessage({ id: `user-${Date.now()}`, role: 'user', content: options.displayMessage ?? message, attachments: requestAttachments });
    }
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // 通用专家下顺带问一次路由建议：不阻塞发送、失败静默，仅在有候选时提示切换
    if (expertId === 'general' && experts.length > 1) {
      expertsApi.route({ message, excludeId: expertId })
        .then((data) => {
          const candidates = Array.isArray(data) ? data : [];
          if (!stale() && candidates.length) setExpertSuggestion(candidates[0]);
        })
        .catch(() => {});
    }

      let durableRunCompleted = false;
      try {
        let requestContext: Record<string, unknown> = options.context ?? context;
        let retrievedReferences: AiReference[] = [];
        if (!options.resumeRun && isTauri() && preferModel && queryPlan.requiresRetrieval) {
          setStreamStatus('正在检索知识库…');
          try {
            const allowedPaths = scopedNoteIndex
              .map((note) => note.filePath ?? '')
              .filter((path): path is string => Boolean(path.trim()));
            const retrievalRequest = {
              query: queryPlan.rewrittenQuery,
              queries: queryPlan.subqueries,
              limit: 16,
              allowedPaths,
              permissionContext: aiPermissionContext,
            };
            const rawRetrieval = await aiRetrievalCache.run(retrievalRequest, () => aiApi.retrievalPreview({
              query: retrievalRequest.query,
              queries: retrievalRequest.queries,
              limit: retrievalRequest.limit,
              allowedPaths: retrievalRequest.allowedPaths,
            }, requestOptions));
            const retrieval = (rawRetrieval as HttpEnvelope)?.data ?? rawRetrieval;
            let blocks = Array.isArray((retrieval as { blocks?: unknown[] } | null)?.blocks)
              ? (retrieval as { blocks: Array<Record<string, unknown>> }).blocks
              : [];
            if (blocks.length) {
              const rankedIds = await smallModelClient.rerank(settings, queryPlan.rewrittenQuery, blocks.map((block, index) => ({
                id: String(block.citationId ?? `cite-${index + 1}`),
                title: String(block.title ?? block.path ?? '来源笔记').slice(0, 200),
                excerpt: String(block.excerpt ?? '').slice(0, 300),
                score: Number(block.score ?? 0),
              })));
              if (rankedIds?.length) {
                const rank = new Map(rankedIds.map((id, index) => [id, index]));
                blocks = [...blocks].sort((left, right) => {
                  const leftRank = rank.get(String(left.citationId ?? '')) ?? rankedIds.length;
                  const rightRank = rank.get(String(right.citationId ?? '')) ?? rankedIds.length;
                  return leftRank - rightRank;
                });
              }
              requestContext = {
                ...context,
                retrieval: blocks.map((block, index) => {
                  const citationId = String(block.citationId ?? `cite-${index + 1}`);
                  const title = String(block.title ?? block.path ?? '来源笔记');
                  const anchor = String(block.anchor ?? '');
                  const excerpt = String(block.excerpt ?? block.content ?? '');
                  return {
                    id: citationId,
                    citationId,
                    content: `[${index + 1}] ${title}${anchor ? ` · ${anchor}` : ''}\n来源：${String(block.path ?? '')}\n${String(block.content ?? excerpt)}`,
                    metadata: {
                      noteId: String(block.noteId ?? ''),
                      title,
                      path: String(block.path ?? ''),
                      anchor,
                      excerpt,
                    },
                  };
                }),
              };
              retrievedReferences = blocks.map((block, index) => ({
                id: String(block.noteId ?? ''),
                number: index + 1,
                title: String(block.title ?? block.path ?? '来源笔记'),
                excerpt: String(block.excerpt ?? block.content ?? ''),
                path: String(block.path ?? ''),
                anchor: String(block.anchor ?? ''),
              }));
            }
          } catch {
            // Retrieval is an enrichment step. A provider request must still
            // proceed when the local index is unavailable or empty.
          }
        }
        setStreamStatus('正在连接模型…');
        const providerCandidates = isTauri() && preferModel ? getAiProviderRouteRuntime(settings) : [];
        const provider = providerCandidates[0] ?? (isTauri() && preferModel ? getActiveAiProviderRuntime(settings) : null);
        traceModel = provider?.model ?? traceModel;
        const requestController = isTauri() ? tauriAiController : aiController;
        lastRunRequestRef.current = { runId, message, sessionId: requestSessionId, context: requestContext, mode: requestMode };
        if (isTauri()) {
          rememberDurableRun({
            runId,
            sessionId: requestSessionId,
            createdAt: new Date().toISOString(),
            expertId,
            workspaceId: workspaceIdentity ?? undefined,
            permissionScopeId: aiPermissionContext.scopeId,
            permissionVersion: aiPermissionContext.permissionVersion,
          }, storageNamespace);
        }
        const { payload: rawPayload } = await requestController.run({
          runId,
          message,
          ...(options.resumeRun ? { resumeRun: true } : {}),
          context: requestContext,
          sessionId: requestSessionId,
          mode: requestMode as 'quick' | 'task',
          expertId,
          preferModel,
          ...(remoteRouting ? { routingOverride: remoteRouting } : {}),
          autoApprove: taskMode,
          ...(webSearchEnabled ? { webSearch: true } : {}),
          actor: 'local-user',
          role: LOCAL_OWNER_ROLE,
          ...(options.regenerate ? { regenerate: true } : {}),
          ...(mcpServers.length ? { mcpServers } : {}),
          ...(provider ? { provider } : {}),
          ...(providerCandidates.length > 1 ? { providerCandidates } : {}),
          attachments: requestAttachments,
          ...(options.toolCalls?.length ? { toolCalls: options.toolCalls } : {}),
          ...(options.toolResults?.length ? { toolResults: options.toolResults } : {}),
          ...((taskMode || preferModel) ? {
            tools: [
              ...createProviderReadTools({
                allowedPaths: aiPermissionContext.allowedPaths ?? [],
                requestOptions,
              }),
              ...(taskMode ? [LATTICE_FILE_OPERATION_TOOL] : []),
            ],
          } : {}),
        }, {
        requestOptions,
        signal: controller.signal,
        onEvent: (event) => {
          const rawType = String(event.type ?? 'status');
          if (rawType === 'delta' || rawType === 'reasoning' || rawType === 'error' || rawType === 'done') {
            trace(rawType as AiTraceEventType, {
              status: rawType === 'done' ? 'completed' : undefined,
              terminationReason: rawType === 'done' ? (event.payload as Record<string, unknown> | undefined)?.terminationReason : undefined,
              citationCount: rawType === 'done' && Array.isArray((event.payload as Record<string, unknown> | undefined)?.references)
                ? ((event.payload as Record<string, unknown>).references as unknown[]).length
                : undefined,
              errorKind: rawType === 'error' ? 'provider_error' : undefined,
            });
          } else {
            trace('status', { status: rawType });
          }
          if (stale()) return;
          if (event.type === 'meta') {
            if (event.model) traceModel = String(event.model);
            const meta = event.meta && typeof event.meta === 'object' ? event.meta as Record<string, unknown> : null;
            if (meta?.fallback === true) {
              trace('status', {
                status: 'provider_fallback',
                provider: meta.providerId,
                fallbackFrom: meta.fallbackFrom,
                attempt: meta.attempt,
                errorKind: meta.errorKind,
              });
            }
            streamStatusRef.current = `模型 ${event.model ?? ''} 生成中…`;
            queueStreamFlush();
          }
          else if (event.type === 'delta') {
            streamTextRef.current += String(event.text ?? '');
            setReasoningOpen(false);
            queueStreamFlush();
          }
          else if (event.type === 'reasoning') {
            reasoningRef.current += String(event.text ?? '');
            if (!reasoningStartedAtRef.current) reasoningStartedAtRef.current = Date.now();
            queueStreamFlush();
          }
          else if (event.type === 'round') {
            streamTextRef.current = '';
            reasoningRef.current = '';
            setReasoningOpen(true);
            streamStatusRef.current = `第 ${event.round} 轮 · 继续执行任务…`;
            queueStreamFlush();
          } else if (event.type === 'status') {
            streamStatusRef.current = event.text ?? '';
             commitProgressSteps((current) => updateProgressDetail(current, event.text));
            queueStreamFlush();
          } else if (event.type === 'progress') {
             commitProgressSteps((current) => mergeProgressStep(current, event));
          } else if (event.type === 'done') {
            streamStatusRef.current = '';
            const finalProgress = (event.payload?.meta as AiMessageMeta | undefined)?.progress;
             if (Array.isArray(finalProgress) && finalProgress.length) commitProgressSteps(finalProgress);
            queueStreamFlush();
          }
        },
        onRuntimeEvent: (event) => {
          trace(event.type, {
            status: event.status,
            durationMs: event.payload?.durationMs,
            ok: event.payload?.ok,
            tool: event.payload?.toolName ?? event.payload?.tool ?? event.tool?.name,
            server: event.payload?.server ?? event.payload?.serverName,
            terminationReason: event.payload?.terminationReason,
            citationCount: event.type === 'citation' ? 1 : undefined,
          });
          if (stale()) return;
          runMetricsRef.current = event.metrics ?? runMetricsRef.current;
          if (taskMode) commitProgressSteps((current) => mergeRuntimeToolProgress(current, event));
        },
        });
      const payload = rawPayload as AiStreamPayload;
      traceFinishMetadata = {
        status: payload?.cancelled ? 'cancelled' : 'completed',
        terminationReason: payload?.cancelled ? 'cancelled' : payload?.meta?.completionStatus === 'budget_exceeded' ? 'budget_exceeded' : 'completed',
      };
      const currentMetrics = runMetricsRef.current;
      if (currentMetrics) {
        const metrics = Object.assign({}, currentMetrics) as AiRunMetrics;
        const metricsProvider = providerCandidates.find((candidate) => candidate.model === String(payload?.meta?.model ?? '')) ?? provider;
        const promptRate = Number(metricsProvider?.promptCostPer1kUsd);
        const completionRate = Number(metricsProvider?.completionCostPer1kUsd);
        if (Number.isFinite(promptRate) && promptRate >= 0 && Number.isFinite(completionRate) && completionRate >= 0
          && metrics.promptTokens !== undefined && metrics.completionTokens !== undefined) {
          metrics.estimatedCostUsd = (metrics.promptTokens / 1000) * promptRate + (metrics.completionTokens / 1000) * completionRate;
        }
        const taskType: AiMetricTaskType = taskMode ? 'agent' : queryPlan.requiresRetrieval ? 'retrieval' : 'quick';
        recordAiRunMetric({
          runId,
          taskType,
          model: String(payload?.meta?.model ?? metricsProvider?.model ?? 'local'),
          provider: String(payload?.meta?.provider ?? metricsProvider?.name ?? 'local'),
          metrics,
          storageNamespace,
        });
      }
      durableRunCompleted = payload?.cancelled !== true;
      retryRunIdRef.current = null;
      // W7c：写轮终态由内核托管（meta.kernelManaged）——待确认写以 meta.writeRequests
      // 为准，内核已执行/已拒绝的调用不再进入前端预览与执行；读轮交回行为不变。
      const kernelManaged = payload?.meta?.kernelManaged === true;
      const kernelWriteExecuted = Array.isArray(payload?.meta?.kernelWriteExecuted)
        ? (payload.meta.kernelWriteExecuted as unknown[]).map((id) => String(id))
        : [];
      const writeRequestIds = Array.isArray(payload?.meta?.writeRequests)
        ? (payload.meta.writeRequests as Array<{ id?: unknown }>)
          .map((item) => String(item?.id ?? ''))
          .filter(Boolean)
        : [];
      const providerActions = kernelManaged
        ? actionsFromProviderToolCalls(payload?.toolCalls).filter((action) => writeRequestIds.includes(String(action.id)))
        : actionsFromProviderToolCalls(payload?.toolCalls).filter((action) => !kernelWriteExecuted.includes(String(action.id)));
      const providerReadCalls = kernelManaged
        ? []
        : (payload?.toolCalls ?? []).filter((call) => isProviderReadToolCall(call));
      if (kernelManaged && !writeRequestIds.length) pendingToolCallsRef.current = [];
      else if (payload?.toolCalls?.length) pendingToolCallsRef.current = payload.toolCalls;
      pendingReadToolResultsRef.current = [];
      const plannedActions = payload?.actions?.length ? payload.actions : providerActions;
      const pendingWrites = Array.isArray(plannedActions) && plannedActions.some((action) => (
        ['create', 'update', 'delete', 'move', 'copy', 'archive'].includes(String(action?.type ?? '').toLowerCase())
      ));
      const awaitingConfirmation = payload?.meta?.awaitingConfirmation === true
        || payload?.meta?.completionStatus === 'waiting_confirmation'
        || providerReadCalls.length > 0
        || pendingWrites;
      if (!payload?.cancelled && !awaitingConfirmation) {
        notifyAiRunCompletion({
          runId,
          status: 'completed',
          panelVisible: open && typeof document !== 'undefined' && document.visibilityState === 'visible',
          toast,
          notifiedRunIds: notifiedRunIdsRef.current,
        });
      }
      if (stale()) return;
      if (payload?.cancelled) {
        appendMessage({ id: `system-${Date.now()}`, role: 'system', content: '已停止生成。' });
        return;
      }
      if (providerReadCalls.length) {
        let readCheckpoint = toolCheckpointRef.current ?? createToolCheckpoint();
        for (const call of providerReadCalls) {
          const descriptor = providerReadCheckpointDescriptor(call);
          if (descriptor) readCheckpoint = recordToolCheckpointStep(readCheckpoint, descriptor, 'pending');
        }
        await persistToolCheckpoint({ ...readCheckpoint, stage: 'tool_execution' });
        pendingReadToolResultsRef.current = await executeProviderReadToolCalls(providerReadCalls, {
          allowedPaths: aiPermissionContext.allowedPaths ?? [],
          requestOptions,
          runId,
          signal: controller.signal,
        });
        for (const result of pendingReadToolResultsRef.current) {
          const call = providerReadCalls.find((item) => item.id === result.id);
          const descriptor = call ? providerReadCheckpointDescriptor(call) : null;
          if (descriptor) readCheckpoint = recordToolCheckpointStep(readCheckpoint, descriptor, result.status);
        }
        const failedRead = pendingReadToolResultsRef.current.find((item) => item.status === 'failed');
        await persistToolCheckpoint({
          ...readCheckpoint,
          stage: failedRead ? 'tool_failed' : 'tool_completed',
          ...(failedRead?.error ? { lastError: failedRead.error.slice(0, 500) } : {}),
        });
      }

       const persistedProgress = taskMode
         ? (Array.isArray(payload?.meta?.progress) && payload.meta.progress.length
           ? payload.meta.progress
           : completeProgress(progressStepsRef.current, { awaitingConfirmation }))
         : [];
       const { progress: _serverProgress, ...metaWithoutProgress } = payload?.meta ?? {};
       // 成本与出处：按 done 载荷的模型名回查本次路由里的供应商配置（覆盖降级命中的候选），
       // 价格未配置时 costUsd 为 null（界面只显示 token，不估算金额）
       const servedUsage = (payload?.meta?.usage ?? null) as { prompt_tokens?: number; completion_tokens?: number } | null;
       const servedModel = String(payload?.meta?.model ?? '');
       const servedProvider = getAiProviderRouteRuntime(settings).find((item) => item.model === servedModel) ?? null;
       const modelLocal = servedProvider ? isLoopbackEndpoint(servedProvider.endpoint) : false;
       const costUsd = servedProvider && servedUsage ? estimateCostUsd(servedUsage, servedProvider) : null;
       const assistantMeta = {
         ...metaWithoutProgress,
         taskMode,
         completionStatus: payload?.meta?.completionStatus ?? (awaitingConfirmation ? 'waiting_confirmation' : 'completed'),
         awaitingConfirmation,
         ...(runMetricsRef.current ? { metrics: runMetricsRef.current } : {}),
         ...(taskMode && persistedProgress.length ? { progress: persistedProgress } : {}),
         ...(modelLocal ? { modelLocal: true } : {}),
         ...(costUsd !== null ? { costUsd } : {}),
         // U2：思考流时长（首个 reasoning 事件起算；本轮无思考流则缺省）
         ...(reasoningStartedAtRef.current ? { reasoningMs: Date.now() - reasoningStartedAtRef.current } : {}),
         // U2 FileChangesCard：预览/执行阶段统计的文件变更挂到本轮回答
         ...(pendingFileChangesRef.current.length ? { fileChanges: pendingFileChangesRef.current } : {}),
       };
      pendingFileChangesRef.current = [];
      commitProgressSteps(persistedProgress);
      // 引用兜底只在回答真的用了来源时挂载：检索注入过上下文但正文没有 [n] 标记、
      // 模型也没显式返回 references 时，来源清单不显示（避免身份类问题挂无关引用）。
      const assistantContent = String(payload?.reply ?? payload?.text ?? payload?.content ?? '').trim() || '未收到有效回答，请重试。';
      const answerCitesSources = /\[\d{1,2}\]/.test(assistantContent);
      let assistant: AiMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        // 服务端 SSE 使用 text，旧 HTTP 接口才可能返回 reply；桌面端一直走 text。
        content: assistantContent,
        suggestions: payload?.suggestions ?? [],
        references: Array.isArray(payload?.references) && payload.references.length
          ? payload.references
          : answerCitesSources
            ? retrievedReferences
            : [],
        reasoning: payload?.reasoning ?? '',
        meta: { ...assistantMeta, ...(isTauri() ? { runId } : {}) },
      };
      // U3 变体切换：重新生成的回答并入被替换回答的变体组（会话内存）
      if (options.regenerate && replacedAnswerRef.current) {
        const group = attachRegenerateVariant(replacedAnswerRef.current.variants, replacedAnswerRef.current, assistant);
        assistant = { ...assistant, variants: group.variants, variantIndex: group.variantIndex };
        replacedAnswerRef.current = null;
      }
      setAttachments([]);
      setAttachmentError('');
      if (providerReadCalls.length && !plannedActions?.length) {
        const readResults = pendingReadToolResultsRef.current;
        pendingReadToolResultsRef.current = [];
        pendingToolCallsRef.current = [];
        durableRunCompleted = false;
        queueProviderContinuationWithResults(providerReadCalls, readResults);
        refreshSessions();
        return;
      }
      if (plannedActions?.length) {
        const previewResponse = await aiOperationPlanner.build(plannedActions, requestOptions, LOCAL_OWNER_ROLE, aiPermissionContext.allowedPaths);
        if (stale()) return;
        // U2：预览构建时统计每个文件操作的 ±行数；执行后续跑的 done 挂到回答的 FileChangesCard
        collectFileChanges(previewResponse);
        const toolCheckpoint = checkpointForPlan(toolCheckpointRef.current, previewResponse?.aiPlanHash);
        await persistToolCheckpoint({
          ...toolCheckpoint,
          stage: 'tool_execution',
          ...(previewResponse?.aiPlanHash ? { planHash: previewResponse.aiPlanHash } : {}),
        });
        if (previewResponse && isAutoExecutableL1Plan(previewResponse)) {
          const autoResults: OperationResult[] = [];
          for (const operation of previewResponse.fileOperations) {
            const step = {
              id: operation.id,
              type: operation.action.type,
              path: operation.action.path,
              targetPath: operation.action.targetPath,
            };
            const resumedStep = completedToolStep(toolCheckpointRef.current, operation.id);
            if (resumedStep) {
              autoResults.push({
                id: operation.id,
                type: operation.action.type,
                path: operation.action.path,
                targetPath: operation.action.targetPath,
                status: 'completed',
                result: resumedStep.operationId ? { operationId: resumedStep.operationId, resumed: true } : { resumed: true },
              });
              continue;
            }
            await persistToolCheckpoint(recordToolCheckpointStep(toolCheckpointRef.current ?? toolCheckpoint, step, 'pending'));
            try {
              const response = await aiOperationAdapter.execute({
                actions: [operation.action],
                actor: 'local-user',
                role: LOCAL_OWNER_ROLE,
                source: 'ai-chat',
                allowedPaths: aiPermissionContext.allowedPaths,
                idempotencyKey: `${runId}:${operation.id}`,
                confirmed: true,
                additionalConfirmed: false,
                sensitiveConfirmed: false,
                planId: operation.planId,
                planHash: operation.planHash,
              }, requestOptions);
              const result = ((response as HttpEnvelope)?.data ?? response) as AiExecuteResult;
              const operationResults = result.results ?? [{
                id: operation.id,
                type: operation.action.type,
                path: operation.action.path,
                targetPath: operation.action.targetPath,
                status: 'completed',
                result,
              }];
              autoResults.push(...operationResults);
              const completed = operationResults.every((item) => item.status !== 'failed');
              const operationId = operationResults.find((item) => item.result?.operationId)?.result?.operationId ?? result.operationId ?? undefined;
              await persistToolCheckpoint(recordToolCheckpointStep(
                toolCheckpointRef.current ?? toolCheckpoint,
                { ...step, ...(operationId ? { operationId } : {}) },
                completed ? 'completed' : 'failed',
              ));
            } catch (requestError: any) {
              autoResults.push({
                id: operation.id,
                type: operation.action.type,
                path: operation.action.path,
                targetPath: operation.action.targetPath,
                status: 'failed',
                error: requestError?.message ?? 'L1 自动执行失败',
              });
              await persistToolCheckpoint(recordToolCheckpointStep(
                toolCheckpointRef.current ?? toolCheckpoint,
                step,
                'failed',
              ));
            }
          }
          const autoExecution: ExecutionResult = {
            results: autoResults,
            completed: autoResults.filter((item) => item.status === 'completed').length,
            failed: autoResults.filter((item) => item.status === 'failed').length,
            skipped: autoResults.filter((item) => item.status === 'skipped').length,
          };
          if (autoExecution.failed) {
            pendingToolCallsRef.current = [];
            durableRunCompleted = false;
            retryRunIdRef.current = null;
            setRetryMessage('');
            await persistToolCheckpoint({
              ...(toolCheckpointRef.current ?? toolCheckpoint),
              stage: 'tool_failed',
              lastError: `${autoExecution.failed} 项低风险操作执行失败`,
            });
            notifyAiRunCompletion({
              runId,
              status: 'failed',
              panelVisible: open && typeof document !== 'undefined' && document.visibilityState === 'visible',
              error: `${autoExecution.failed} 项低风险操作执行失败，请返回查看详情。`,
              toast,
              notifiedRunIds: notifiedRunIdsRef.current,
            });
            setPreview(previewResponse);
          } else {
            await persistToolCheckpoint({
              ...(toolCheckpointRef.current ?? toolCheckpoint),
              stage: 'tool_completed',
            });
            const executedOperations = autoResults
              .map((item) => item.result?.operationId ?? (item as OperationResult & { operationId?: string }).operationId)
              .filter((operationId): operationId is string => Boolean(operationId))
              .map((operationId) => ({ operationId }));
            const executed = autoResults
              .filter((item) => item.status === 'completed')
              .map((item) => `${item.type ?? '写入'} ${item.path ?? ''}`.trim());
            const executedFailed = autoResults
              .filter((item) => item.status === 'failed')
              .map((item) => `${item.type ?? '写入'} ${item.path ?? ''}：${item.error ?? '执行失败'}`.trim());
            assistant = {
              ...assistant,
              meta: {
                ...assistant.meta,
                executed,
                executedFailed,
                executedOperations,
                autoExecuted: true,
              },
            };
            setExecution(autoExecution);
            appendMessage(assistant);
            appendMessage({
              id: `system-${Date.now()}`,
              role: 'system',
              content: `已自动完成 ${autoExecution.completed ?? 0} 项低风险操作，可随时撤销。`,
            });
            notifyAiRunCompletion({
              runId,
              status: 'completed',
              panelVisible: open && typeof document !== 'undefined' && document.visibilityState === 'visible',
              toast,
              notifiedRunIds: notifiedRunIdsRef.current,
            });
            await onOperationComplete?.();
            if (pendingToolCallsRef.current.length && autoExecution.failed === 0) {
              queueProviderContinuation(pendingToolCallsRef.current, autoResults, pendingReadToolResultsRef.current);
              pendingReadToolResultsRef.current = [];
            }
             forgetDurableRun(runId, storageNamespace);
            refreshSessions();
            return;
          }
        } else {
          if (previewResponse) {
            durableRunCompleted = false;
            await persistToolCheckpoint({
              ...toolCheckpoint,
              stage: 'waiting_confirmation',
              ...(previewResponse.aiPlanHash ? { planHash: previewResponse.aiPlanHash } : {}),
            });
          }
          setPreview(previewResponse);
        }
      }
      if (durableRunCompleted) forgetDurableRun(runId, storageNamespace);
      appendMessage(assistant);
      refreshSessions();
    } catch (requestError: any) {
      if (requestError?.name === 'AbortError') {
        traceFinishMetadata = { status: 'cancelled', terminationReason: 'cancelled', errorKind: 'abort' };
        if (stale()) return;
        appendMessage({ id: `system-${Date.now()}`, role: 'system', content: '已停止生成。' });
      } else {
        traceFinishMetadata = { status: 'failed', terminationReason: 'error', errorKind: requestError?.name ?? 'request_error' };
        // 失败透明：展示上游原因 + 重试入口，不再静默回落本地助手
        notifyAiRunCompletion({
          runId,
          status: 'failed',
          panelVisible: open && typeof document !== 'undefined' && document.visibilityState === 'visible',
          error: requestError?.message,
          toast,
          notifiedRunIds: notifiedRunIdsRef.current,
        });
        if (stale()) return;
        setError(requestError?.message ?? 'AI 请求失败，请稍后重试');
        setRetryMessage(message);
        retryRunIdRef.current = isTauri() ? runId : null;
         commitProgressSteps((current) => failProgress(current, requestError?.message));
      }
    } finally {
      trace('run_finished', { ...traceFinishMetadata, ...traceMetrics(runMetricsRef.current) });
      // 清理必须无条件执行：切换会话会 abort 旧请求，若在这里跳过 setSending，
      // composerBusy 会永久卡住。内容写入（消息/预览/报错）才需要 stale 守卫。
      abortRef.current = null;
      sendInFlightRef.current = false;
      setSending(false);
      setActiveTaskMode(false);
      streamTextRef.current = '';
      streamStatusRef.current = '';
      setStreamText('');
      setStreamStatus('');
      const continuation = pendingContinuationRef.current;
      pendingContinuationRef.current = null;
      if (continuation) {
        globalThis.queueMicrotask(() => startProviderContinuation(continuation));
      }
    }
  };

  const queueProviderContinuation = (calls: NonNullable<AiStreamPayload['toolCalls']>, results: OperationResult[], readResults: ProviderReadExecutionResult[] = []): ProviderContinuation => {
    const continuation = {
      calls,
      results: toolResultsFromExecution(calls, results, readResults),
      context: lastRunRequestRef.current?.context,
      sourceRunId: activeRunIdRef.current ?? undefined,
    };
    pendingContinuationRef.current = continuation;
    return continuation;
  };

  const queueProviderContinuationWithResults = (calls: NonNullable<AiStreamPayload['toolCalls']>, readResults: ProviderReadExecutionResult[]): ProviderContinuation => {
    const continuation = {
      calls,
      results: readResults.map((item) => ({ callId: item.id, result: item.result })),
      context: lastRunRequestRef.current?.context,
      sourceRunId: activeRunIdRef.current ?? undefined,
    };
    pendingContinuationRef.current = continuation;
    return continuation;
  };

  const startProviderContinuation = (continuation: ProviderContinuation) => {
    void send('请根据工具执行结果继续完成任务。', {
      mode: 'task',
      preferModel: true,
      skipUserMessage: true,
      attachments: [],
      context: continuation.context,
      toolCalls: continuation.calls,
      toolResults: continuation.results,
      continuation: true,
    });
    if (continuation.sourceRunId) forgetDurableRun(continuation.sourceRunId, storageNamespace);
  };

  const chooseRoutingClarification = (prompt: string) => {
    if (!routingClarification || composerBusy) return;
    const originalMessage = routingClarification.message;
    setRoutingClarification(null);
    void send(`${originalMessage}\n\n用户补充：${prompt}`, { displayMessage: prompt });
  };

  const recoverDurableRun = async (candidate: DurableRunRecovery) => {
    if (composerBusy || recoveryBusyRunId) return;
    const identityMismatch = (candidate.workspaceId ?? null) !== (workspaceIdentity ?? null)
      || (candidate.expertId && candidate.expertId !== expertId)
      || (candidate.permissionScopeId && candidate.permissionScopeId !== aiPermissionContext.scopeId)
      || (candidate.permissionVersion && candidate.permissionVersion !== aiPermissionContext.permissionVersion);
    if (identityMismatch) {
      setError('该任务属于其他知识库、专家或权限范围，无法在当前环境恢复。');
      return;
    }
    const payload = asDurableRunPayload(candidate.run.payload);
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const requestSessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
      ? payload.sessionId
      : candidate.sessionId;
    const requestContext = payload.context && typeof payload.context === 'object'
      ? payload.context as Record<string, unknown>
      : undefined;
    const provider = getActiveAiProviderRuntime(settings);
    const localEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\b/i.test(provider?.endpoint ?? '');
    if (!message) {
      setError('该任务缺少可恢复的请求内容，请忽略后重新提交。');
      return;
    }
    if (!provider?.endpoint?.trim() || !provider.model?.trim() || (!provider.apiKey?.trim() && !localEndpoint)) {
      setError('恢复任务需要当前页面中的模型配置，请先打开模型设置并配置可用模型。');
      return;
    }
    const requiresWriteRegeneration = candidate.recoveryKind === 'write_confirmation_required'
      || candidate.recoveryKind === 'write_payload_unavailable'
      || candidate.recoveryKind === 'tool_replay_unavailable';
    if (requiresWriteRegeneration) {
      // Write bodies are deliberately not persisted. A user-triggered new Run
      // regenerates a plan and therefore reaches the normal preview/confirm gate.
      setRecoveryBusyRunId(candidate.runId);
      forgetDurableRun(candidate.runId, storageNamespace);
      setRecoverableRuns((current) => current.filter((item) => item.runId !== candidate.runId));
      try {
        await send(message, {
          mode: payload.mode === 'task' ? 'task' : 'quick',
          sessionId: requestSessionId,
          preferModel: true,
          skipUserMessage: true,
          attachments: [],
          ...(requestContext ? { context: requestContext } : {}),
        });
      } finally {
        setRecoveryBusyRunId('');
      }
      return;
    }
    setRecoveryBusyRunId(candidate.runId);
    sessionIdRef.current = requestSessionId;
    loadedSessionRef.current = null;
    setSessionId(requestSessionId);
    setSessions((current) => current.some((session) => session.id === requestSessionId)
      ? current
      : [{ id: requestSessionId, title: '恢复中的 AI 任务' }, ...current]);
    try {
      localStorage.setItem(sessionStorageKey, requestSessionId);
    } catch {
      // 会话索引持久化失败不应阻止本次恢复。
    }
    try {
      const checkpoint = normalizeToolCheckpoint(candidate.run.checkpoint);
      const recoveredReadCalls = checkpoint?.completedSteps
        .flatMap((step) => {
          const call = providerReadCallFromCheckpoint(step);
          return call ? [call] : [];
        })
        .filter((call, index, calls) => calls.findIndex((item) => item.id === call.id) === index) ?? [];
      if (recoveredReadCalls.length) {
        const controller = new AbortController();
        activeRunIdRef.current = candidate.runId;
        toolCheckpointRef.current = checkpoint;
        abortRef.current = controller;
        setSending(true);
        setStreamStatus('正在恢复只读工具…');
        try {
          const readResults = await executeProviderReadToolCalls(recoveredReadCalls, {
            allowedPaths: aiPermissionContext.allowedPaths ?? [],
            requestOptions,
            runId: candidate.runId,
            signal: controller.signal,
          });
          let nextCheckpoint = checkpoint ?? createToolCheckpoint();
          for (const result of readResults) {
            const call = recoveredReadCalls.find((item) => item.id === result.id);
            const descriptor = call ? providerReadCheckpointDescriptor(call) : null;
            if (descriptor) nextCheckpoint = recordToolCheckpointStep(nextCheckpoint, descriptor, result.status);
          }
          const failedRead = readResults.find((item) => item.status === 'failed');
          await persistToolCheckpoint({
            ...nextCheckpoint,
            stage: failedRead ? 'tool_failed' : 'tool_completed',
            ...(failedRead?.error ? { lastError: failedRead.error.slice(0, 500) } : {}),
          });
          setSending(false);
          setStreamStatus('');
          startProviderContinuation({
            calls: recoveredReadCalls,
            results: readResults.map((item) => ({ callId: item.id, result: item.result })),
            context: requestContext,
            sourceRunId: candidate.runId,
          });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await persistToolCheckpoint({
            ...(toolCheckpointRef.current ?? createToolCheckpoint()),
            stage: 'tool_failed',
            lastError: message.slice(0, 500),
          });
          setError(message || '恢复只读工具失败，请重新提交任务');
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
          if (sendInFlightRef.current === false) setSending(false);
          setStreamStatus('');
        }
      }
      await send(message, {
        runId: candidate.runId,
        resumeRun: true,
        sessionId: requestSessionId,
        ...(requestContext ? { context: requestContext } : {}),
        mode: payload.mode === 'task' ? 'task' : 'quick',
        preferModel: true,
        skipUserMessage: true,
        attachments: [],
        toolCheckpoint: normalizeToolCheckpoint(candidate.run.checkpoint),
      });
      if (isTauri()) setRecoverableRuns(await scanDurableRuns(tauriAiRunClient, storageNamespace));
    } finally {
      setRecoveryBusyRunId('');
    }
  };

  const ignoreDurableRun = (runId: string) => {
    forgetDurableRun(runId, storageNamespace);
    setRecoverableRuns((current) => current.filter((candidate) => candidate.runId !== runId));
  };

  // W7c 确认下沉：对内核挂起的写批次发送裁决。内核执行（或记录拒绝）后注册续跑
  // 请求并重新入队，这里走 resumeRun 通道回放后续事件（ai_run_resume 会跳过
  // 重复注册与重复入队，直接续播内核续跑）。
  const confirmProviderRun = async (approved: boolean, additionalConfirmed: boolean, approvedCallIds?: string[]) => {
    const runId = activeRunIdRef.current;
    if (!runId || !isTauri() || sendInFlightRef.current) return;
    setSending(true);
    setStreamStatus(approved ? '正在执行已确认的写操作…' : '已拒绝写操作，正在告知模型…');
    setError('');
    if (!approved) pendingFileChangesRef.current = [];
    try {
      await tauriAiRunClient.confirm(runId, approved, additionalConfirmed, approvedCallIds);
    } catch (confirmError: any) {
      setSending(false);
      setStreamStatus('');
      setError(confirmError?.message ?? '写操作确认失败，请重试');
      return;
    }
    pendingToolCallsRef.current = [];
    setPreview(null);
    await send(approved ? '已确认写操作，请继续。' : '用户拒绝了该写操作，请调整方案。', {
      runId,
      resumeRun: true,
      mode: 'task',
      preferModel: true,
      skipUserMessage: true,
      attachments: [],
      context: lastRunRequestRef.current?.context,
    });
  };

  const cancelOperationPreview = () => {
    if (isTauri() && pendingToolCallsRef.current.length) {
      // W7c：挂起的写批次「取消预览」改为拒绝语义——告知模型由内核续跑收尾，
      // 不再把任务遗留成可恢复的悬挂状态。
      pendingFileChangesRef.current = [];
      void confirmProviderRun(false, false);
      setPreview(null);
      return;
    }
    pendingFileChangesRef.current = [];
    const runId = activeRunIdRef.current;
    if (runId) forgetDurableRun(runId, storageNamespace);
    setPreview(null);
  };

  // 重新生成最后一条回答：移除旧回答（保留 user 消息），带 regenerate 标记重发，
  // 服务端会同步移除会话里的上一轮，避免同一问题在模型上下文里出现两遍
  // U3 虚拟列表：长会话（>60 条）窗口化渲染——只挂载可见区 ± 缓冲，其余用占位高度。
  // 常规会话行为零变化；高度模型 = 实测回填 + 估计兜底（流式面板场景足够稳定）。
  const VIRTUAL_THRESHOLD = 60;
  const virtualEnabled = messages.length > VIRTUAL_THRESHOLD;
  const virtualRange = virtualEnabled
    ? computeVirtualRange({
      itemCount: messages.length,
      scrollOffset: virtualScrollRef.current.offset,
      viewportHeight: virtualScrollRef.current.viewport || messagesRef.current?.clientHeight || 640,
      estimatedItemHeight: 160,
      measuredHeights: measuredHeightsRef.current,
    })
    : null;
  const visibleMessages = virtualRange ? messages.slice(virtualRange.start, virtualRange.end) : messages;
  const handleMessagesScroll = () => {
    const container = messagesRef.current;
    if (!container) return;
    virtualScrollRef.current = { offset: container.scrollTop, viewport: container.clientHeight };
    setVirtualScrollTick((tick) => tick + 1);
  };
  // 渲染后回填实测高度（下一帧窗口计算用）
  useEffect(() => {
    if (!virtualEnabled) return;
    const container = messagesRef.current;
    if (!container) return;
    container.querySelectorAll<HTMLElement>('[data-message-index]').forEach((node) => {
      const index = Number(node.dataset.messageIndex);
      if (Number.isFinite(index) && node.offsetHeight > 0) measuredHeightsRef.current.set(index, node.offsetHeight);
    });
  });
  void virtualScrollTick;

  const lastAssistantIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant' && messages[index].id !== WELCOME_MESSAGE.id) return index;
    }
    return -1;
  }, [messages]);

  const regenerateLast = () => {
    if (composerBusy || lastAssistantIndex <= 0) return;
    let lastUser = null;
    for (let index = lastAssistantIndex - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') { lastUser = messages[index]; break; }
    }
    if (!lastUser) return;
    // U3 变体切换：旧回答不丢弃，待新回答完成后并入变体组（会话内存）
    replacedAnswerRef.current = messages[lastAssistantIndex];
    setMessages(messages.slice(0, lastAssistantIndex));
    send(lastUser.content, { regenerate: true, skipUserMessage: true });
  };

  // U3 变体切换：在版本组内切换显示版本（组对象共享，O(1)）
  const switchVariant = (messageId: string, index: number) => {
    setMessages((current) => current.map((item) => {
      if (item.id !== messageId || !item.variants) return item;
      const switched = switchMessageVariant(item.variants, index);
      return switched ? { ...switched } as AiMessage : item;
    }));
  };

  // U3 反馈进 trace：👍/👎 落为 run 的 feedback 事件（每条回答至多一次）
  const sendFeedback = async (message: AiMessage, rating: 'up' | 'down') => {
    const runId = typeof message.meta?.runId === 'string' ? message.meta.runId : '';
    if (!runId || !isTauri() || feedbackGivenMap[message.id]) return;
    setFeedbackGivenMap((current) => ({ ...current, [message.id]: rating }));
    try {
      await tauriAiRunClient.feedback(runId, rating);
    } catch (feedbackError: any) {
      setFeedbackGivenMap((current) => {
        const next = { ...current };
        delete next[message.id];
        return next;
      });
      toast.info?.(feedbackError?.message ?? '反馈发送失败');
    }
  };

  const retryFailedRun = () => {
    const request = lastRunRequestRef.current;
    const runId = retryRunIdRef.current;
    if (!request || !runId) {
      void send(retryMessage);
      return;
    }
    void send(request.message, {
      runId,
      resumeRun: true,
      sessionId: request.sessionId,
      context: request.context,
      mode: request.mode,
      preferModel: true,
      skipUserMessage: true,
      attachments: [],
    });
  };

  useEffect(() => {
    if (!open || !initialPrompt.trim()) return;
    const nextDraft = initialPrompt.trim();
    setDraft(nextDraft);
    writeStoredDraft(draftStorageKey, nextDraft);
    forceModelRef.current = initialPromptPreferModel === true;
    setError('');
    setRetryMessage('');
    onInitialPromptConsumed?.();
  }, [initialPrompt, initialPromptPreferModel, onInitialPromptConsumed, open]);

  // 桌面端 Run 已进入持久化队列，关闭面板只停止实时渲染，不取消后台任务。
  // 浏览器端没有 durable queue，仍在关闭面板时中止网络请求。
  useEffect(() => {
    if (open || isTauri()) return;
    abortRef.current?.abort();
  }, [open]);

  if (!open) return null;

  const visibleSessionGroups = groupSessionsByDate(sessions).map(([group, rows]) => [
    group,
    rows.filter((row) => !sessionQuery.trim() || safeSessionTitle(row.title).toLowerCase().includes(sessionQuery.trim().toLowerCase())),
  ] as [string, AiSessionSummary[]]).filter(([, rows]) => rows.length);

  const stopGenerating = () => abortRef.current?.abort();

  const startNewSession = () => {
    if (sending) stopGenerating();
    const id = newSessionId();
    setSessionId(id);
    setMessages([WELCOME_MESSAGE]);
    setDraft('');
    writeStoredDraft(draftStorageKey, '');
    setAttachments([]);
    setAttachmentError('');
    setAttachmentMenuOpen(false);
    setComposerMenu(null);
    setPreview(null);
    setExecution(null);
    setError('');
    setRetryMessage('');
    setExpertSuggestion(null);
    setRoutingClarification(null);
    setSessionBrowserOpen(false);
    try {
      localStorage.setItem(sessionStorageKey, id);
    } catch {
      // 忽略
    }
  };

  const openSessionBrowser = () => {
    setSessionBrowserPage(0);
    setSessionBrowserOpen(true);
    setSessionBrowserReload((value) => value + 1);
  };

  const selectSession = (session: AiSessionSummary) => {
    // 生成中切走：先中止旧请求（其 finally 会复位 sending/流式状态），
    // 否则旧会话的半截流文本与输入框锁定会"占用"新会话
    if (sending) stopGenerating();
    setSessions((current) => current.some((item) => item.id === session.id) ? current : [session, ...current]);
    setSessionId(session.id);
    if (session.id !== sessionId) setMessages([WELCOME_MESSAGE]);
    setPreview(null);
    setError('');
    setRetryMessage('');
    setSessionBrowserOpen(false);
  };

  const deleteCurrentSession = async () => {
    const current = sessionId;
    startNewSession();
    try {
      await sessionStore.remove(current);
    } catch {
      // 会话可能尚不存在，忽略
    }
    refreshSessions();
  };

  const deleteSessionFromBrowser = async (session: AiSessionSummary) => {
    if (sessionBrowserDeleteId) return;
    const title = safeSessionTitle(session.title, '未命名会话');
    if (!window.confirm(`删除“${title}”？会话消息也会一并删除。`)) return;
    setSessionBrowserDeleteId(session.id);
    try {
      await sessionStore.remove(session.id);
      setSessionBrowserRows((current) => current.filter((item) => item.id !== session.id));
      setSessionBrowserMeta((current) => ({
        ...current,
        total: Math.max(Number(current.total ?? 0) - 1, 0),
      }));
      if (session.id === sessionId) startNewSession();
      await refreshSessions();
      if (sessionBrowserRows.length <= 1 && sessionBrowserPage > 0) setSessionBrowserPage((page) => page - 1);
      else setSessionBrowserReload((value) => value + 1);
    } catch (requestError: any) {
      setError(requestError?.message ?? '会话删除失败，请稍后再试');
    } finally {
      setSessionBrowserDeleteId('');
    }
  };

  const renameCurrentSession = () => {
    const current = sessions.find((session) => session.id === sessionId);
    setSessionRename({ id: sessionId, title: current?.title ?? '' });
  };

  const submitSessionRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!sessionRename || sessionRenameSaving) return;
    const title = sessionRename.title.trim();
    if (!title) return;
    setSessionRenameSaving(true);
    try {
      await sessionStore.rename(sessionRename.id, title);
      setSessionRename(null);
      await refreshSessions();
    } catch {
      setError('会话重命名失败，请稍后再试');
    } finally {
      setSessionRenameSaving(false);
    }
  };

  // 任务模式整批撤销：后执行的先撤（后续动作可能依赖前面的结果），与 undoExecution 同口径
  const undoTaskModeOperations = async (message: AiMessage) => {
    const operations = Array.isArray(message?.meta?.executedOperations) ? message.meta.executedOperations : [];
    if (!operations.length || taskUndoBusyId) return;
    setTaskUndoBusyId(message.id);
    setError('');
    try {
      let undoneCount = 0;
      let firstFailure = '';
      const undoneOperationIds: string[] = [];
      for (const operation of [...operations].reverse()) {
        try {
          await filesApi.undo(operation.operationId, requestOptions);
          undoneCount += 1;
          undoneOperationIds.push(operation.operationId);
        } catch (requestError: any) {
          firstFailure = requestError?.message ?? '撤销失败';
          break;
        }
      }
      if (undoneCount) {
        const remainingOperations = operations.filter((operation) => !undoneOperationIds.includes(operation.operationId));
        setMessages((current) => current.map((item) => item.id === message.id
          ? { ...item, meta: { ...item.meta, executedOperations: remainingOperations } }
          : item));
        if (!remainingOperations.length) setUndoneTaskMessages((current) => new Set(current).add(message.id));
        appendMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: `已撤销 ${undoneCount} 项操作${firstFailure ? `，另有未撤销的失败项：${firstFailure}` : ''}。`,
        });
        await onOperationComplete?.();
      } else if (firstFailure) {
        setError(firstFailure);
      }
    } finally {
      setTaskUndoBusyId('');
    }
  };

  // U2 FileChangesCard：把预览的文件操作映射为变更卡数据（±行数按内核 diff 统计）
  const collectFileChanges = (previewResponse: OperationPreviewData | null | undefined) => {
    pendingFileChangesRef.current = (previewResponse?.fileOperations ?? [])
      .map((operation) => ({
        id: operation.id,
        type: String(operation.originalType ?? operation.type ?? 'update'),
        path: String(operation.path ?? operation.action?.path ?? ''),
        targetPath: operation.targetPath ?? operation.action?.targetPath ?? null,
        diff: operation.diff || undefined,
        ...countDiffLines(operation.diff),
      }))
      .filter((change) => change.path);
  };

  const executePreview = async ({ additionalConfirmed = false, actions }: { additionalConfirmed?: boolean; actions?: AiAction[] } = {}) => {
    if (!preview || preview.blocked || sending || (actions && !actions.length)) return;
    if (isTauri() && pendingToolCallsRef.current.length) {
      // W7c：provider run 的写执行已下沉内核——前端只发送裁决（含部分接受的调用
      // 白名单），由 ai_run_confirm 执行并续跑；本地不再重复执行文件操作。
      const approvedCallIds = actions
        ? actions.map((action) => String(action.id ?? '')).filter(Boolean)
        : undefined;
      await confirmProviderRun(true, additionalConfirmed, approvedCallIds);
      return;
    }
    const executionRunId = activeRunIdRef.current ?? `operation-${Date.now()}`;
    let continuationStarted = false;
    setSending(true);
    setStreamStatus(actions ? '正在校验已接受的操作…' : '正在执行文件操作…');
    setError('');
    try {
      const executionPreview = actions
        ? await aiOperationPlanner.build(actions, requestOptions, LOCAL_OWNER_ROLE, aiPermissionContext.allowedPaths)
        : preview;
      if (!executionPreview) throw new Error('没有可执行的操作');
      if (executionPreview.blocked || executionPreview.quality.blocked) {
        setPreview(executionPreview);
        throw new Error('已接受的操作当前不可执行，请更新预览');
      }
      collectFileChanges(executionPreview);
      const toolCheckpoint = checkpointForPlan(toolCheckpointRef.current, executionPreview.aiPlanHash);
      await persistToolCheckpoint({
        ...toolCheckpoint,
        ...(executionPreview.aiPlanHash ? { planHash: executionPreview.aiPlanHash } : {}),
        stage: 'tool_execution',
      });
      const results = [];
      // 预览阶段就失败的动作（如模型给出非法路径）不提交执行，直接记为失败
      for (const operation of executionPreview.failedOperations ?? []) {
        results.push({
          id: operation.id,
          type: operation.originalType ?? operation.type,
          path: operation.path,
          targetPath: operation.targetPath,
          status: 'failed',
          error: operation.error ?? '预览失败',
        });
        await persistToolCheckpoint(recordToolCheckpointStep(
          toolCheckpointRef.current ?? toolCheckpoint,
          { id: operation.id, type: operation.type, path: operation.path, targetPath: operation.targetPath },
          'failed',
        ));
      }
      // 所有 AI 文件动作都走服务端 AI 预览/确认协议，避免文件内核接口绕过
      // 敏感路径策略和计划哈希。
      for (const operation of executionPreview.fileOperations ?? []) {
        const step = {
          id: operation.id,
          type: operation.action.type,
          path: operation.action.path,
          targetPath: operation.action.targetPath,
        };
        const resumedStep = completedToolStep(toolCheckpointRef.current, operation.id);
        if (resumedStep) {
          results.push({
            id: operation.id,
            type: operation.action.type,
            path: operation.action.path,
            targetPath: operation.action.targetPath,
            status: 'completed',
            result: resumedStep.operationId ? { operationId: resumedStep.operationId, resumed: true } : { resumed: true },
          });
          continue;
        }
        await persistToolCheckpoint(recordToolCheckpointStep(toolCheckpointRef.current ?? toolCheckpoint, step, 'pending'));
        try {
          const response = await aiOperationAdapter.execute({
            actions: [operation.action],
             actor: 'local-user',
             role: LOCAL_OWNER_ROLE,
             source: 'ai-chat',
             allowedPaths: aiPermissionContext.allowedPaths,
             idempotencyKey: `${executionRunId}:${operation.id}`,
             confirmed: true,
             additionalConfirmed,
             sensitiveConfirmed: operation.sensitive ? additionalConfirmed : false,
             planId: operation.planId,
            planHash: operation.planHash,
          }, requestOptions);
          const result = ((response as HttpEnvelope)?.data ?? response) as AiExecuteResult;
          const operationResults = result.results ?? [{
            id: operation.id,
            type: operation.action.type,
            path: operation.action.path,
            targetPath: operation.action.targetPath,
            status: 'completed',
            result,
          }];
          results.push(...operationResults);
          const completed = operationResults.every((item) => item.status !== 'failed');
          const operationId = operationResults.find((item) => item.result?.operationId)?.result?.operationId ?? result.operationId ?? undefined;
          await persistToolCheckpoint(recordToolCheckpointStep(
            toolCheckpointRef.current ?? toolCheckpoint,
            { ...step, ...(operationId ? { operationId } : {}) },
            completed ? 'completed' : 'failed',
          ));
        } catch (requestError: any) {
          results.push({
            id: operation.id,
            type: operation.action.type,
            path: operation.action.path,
            targetPath: operation.action.targetPath,
            status: 'failed',
            error: requestError?.message ?? '操作失败',
          });
          await persistToolCheckpoint(recordToolCheckpointStep(
            toolCheckpointRef.current ?? toolCheckpoint,
            step,
            'failed',
          ));
        }
      }
      if (executionPreview.aiOperations?.length) {
        const aiStep = { id: 'ai-operation-batch', type: 'ai-operation' };
        const resumedAiStep = completedToolStep(toolCheckpointRef.current, aiStep.id);
        if (resumedAiStep) {
          results.push({ id: aiStep.id, type: aiStep.type, status: 'completed', result: { resumed: true } });
        } else {
          await persistToolCheckpoint(recordToolCheckpointStep(toolCheckpointRef.current ?? toolCheckpoint, aiStep, 'pending'));
        const response = await aiOperationAdapter.execute({
          actions: executionPreview.aiOperations,
           actor: 'local-user',
           role: LOCAL_OWNER_ROLE,
           source: 'ai-chat',
           allowedPaths: aiPermissionContext.allowedPaths,
           idempotencyKey: `${executionRunId}:ai-operation-batch`,
           confirmed: true,
           additionalConfirmed,
           sensitiveConfirmed: executionPreview.requiresSensitiveConfirmation === true ? additionalConfirmed : false,
           planId: executionPreview.aiPlanId,
          planHash: executionPreview.aiPlanHash,
        }, requestOptions);
        const legacyResult = ((response as HttpEnvelope)?.data ?? response) as AiExecuteResult;
        const batchResults = legacyResult.results ?? [];
        const batchOperationIds = [
          ...(Array.isArray(legacyResult.operationIds) ? legacyResult.operationIds : []),
          ...(Array.isArray(legacyResult.compensation?.operationIds) ? legacyResult.compensation.operationIds : []),
          ...batchResults.flatMap((item) => [
            ...(typeof item.result?.operationId === 'string' ? [item.result.operationId] : []),
            ...(Array.isArray(item.result?.operationIds) ? item.result.operationIds : []),
          ]),
        ].filter((value): value is string => typeof value === 'string');
        const uniqueBatchOperationIds = [...new Set(batchOperationIds)];
        if (batchResults.length) results.push(...batchResults);
        else if (legacyResult.partialFailure || uniqueBatchOperationIds.length) {
          results.push({
            id: aiStep.id,
            type: aiStep.type,
            status: legacyResult.partialFailure ? 'failed' : 'completed',
            operationIds: uniqueBatchOperationIds,
            result: legacyResult,
            error: typeof legacyResult.failure?.message === 'string' ? legacyResult.failure.message : undefined,
          });
        }
        await persistToolCheckpoint(recordToolCheckpointStep(
          toolCheckpointRef.current ?? toolCheckpoint,
          { ...aiStep, ...(uniqueBatchOperationIds.length ? { operationIds: uniqueBatchOperationIds } : {}) },
          legacyResult.partialFailure ? 'failed' : 'completed',
        ));
        }
      }

      const result = {
        results,
        completed: results.filter((item) => item.status === 'completed').length,
        failed: results.filter((item) => item.status === 'failed').length,
        skipped: results.filter((item) => item.status === 'skipped').length,
      };
      await persistToolCheckpoint({
        ...(toolCheckpointRef.current ?? toolCheckpoint),
        stage: result.failed ? 'tool_failed' : 'tool_completed',
        ...(result.failed ? { lastError: `${result.failed} 项操作失败` } : {}),
      });
      setExecution(result);
      setPreview(result.failed ? executionPreview : null);
      appendMessage({
        id: `system-${Date.now()}`,
        role: 'system',
        content: `已完成 ${result.completed ?? 0} 项操作${result.failed ? `，${result.failed} 项失败` : ''}。`,
      });
      await onOperationComplete?.();
      const providerCalls = pendingToolCallsRef.current;
      if (providerCalls.length && !result.failed) {
        pendingToolCallsRef.current = [];
        continuationStarted = true;
        setSending(false);
        setStreamStatus('');
        const continuation = queueProviderContinuation(providerCalls, results, pendingReadToolResultsRef.current);
        pendingReadToolResultsRef.current = [];
        globalThis.queueMicrotask(() => {
          if (pendingContinuationRef.current === continuation) pendingContinuationRef.current = null;
          startProviderContinuation(continuation);
        });
      } else if (providerCalls.length) {
        pendingToolCallsRef.current = [];
      }
    } catch (requestError: any) {
      await persistToolCheckpoint({
        ...(toolCheckpointRef.current ?? createToolCheckpoint()),
        stage: 'tool_failed',
        lastError: requestError?.message ?? '操作执行失败',
      });
      setError(requestError?.message ?? '执行失败，请检查权限或文件状态');
    } finally {
      if (!continuationStarted) {
        setSending(false);
        setStreamStatus('');
      }
    }
  };

  // U2：按路径打开 Vault 内笔记（FileChangesCard「打开」与执行摘要共用）
  const openPathInVault = (path: string) => {
    const note = noteIndex.find((item) => item.filePath === path || item.title === path);
    if (note) onOpenNote?.(note.id);
    else setError(`未找到目标笔记：${path}`);
  };

  const refreshOperationPreview = async (actions: AiAction[]) => {
    if (!Array.isArray(actions) || !actions.length || sending) return null;
    setSending(true);
    setStreamStatus('正在更新操作预览…');
    setError('');
    try {
      const next = await aiOperationPlanner.build(actions, requestOptions, LOCAL_OWNER_ROLE, aiPermissionContext.allowedPaths);
      collectFileChanges(next);
      setPreview(next);
      return next;
    } catch (requestError: any) {
      setError(requestError?.message ?? '更新操作预览失败');
      return null;
    } finally {
      setSending(false);
      setStreamStatus('');
    }
  };

  // 整批撤销刚确认执行的操作：后执行的动作先撤销（后续动作可能依赖前面的结果）
  const undoExecution = async () => {
    if (!execution || undoBusyAll) return;
    setUndoBusyAll(true);
    setError('');
    try {
      const executionOperationIds = (execution.results ?? []).flatMap((item) => [
        ...(item.status !== 'undone' && typeof item.result?.operationId === 'string' ? [item.result.operationId] : []),
        ...(item.status !== 'undone' && Array.isArray(item.operationIds) ? item.operationIds : []),
        ...(item.status !== 'undone' && Array.isArray(item.result?.operationIds) ? item.result.operationIds : []),
      ].filter((value): value is string => typeof value === 'string'));
      const operationIds = [...new Set(executionOperationIds)].reverse();
      let undoneCount = 0;
      let firstFailure = '';
      const undoneOperationIds: string[] = [];
      for (const operationId of operationIds) {
        try {
          await filesApi.undo(operationId, requestOptions);
          undoneCount += 1;
          undoneOperationIds.push(operationId);
        } catch (requestError: any) {
          // 前一个动作未撤销时继续撤后面的会让状态不一致，停在第一个失败
          firstFailure = requestError?.message ?? '撤销失败';
          break;
        }
      }
      if (undoneCount) {
        const remainingResults = (execution.results ?? []).map((item) => {
          const operationId = item.result?.operationId;
          const operationIds = [
            ...(typeof operationId === 'string' ? [operationId] : []),
            ...(Array.isArray(item.operationIds) ? item.operationIds : []),
            ...(Array.isArray(item.result?.operationIds) ? item.result.operationIds : []),
          ];
          const remainingItemOperationIds = operationIds.filter((id) => !undoneOperationIds.includes(id));
          if (!remainingItemOperationIds.length && operationIds.length) return { ...item, status: 'undone' };
          if (remainingItemOperationIds.length !== operationIds.length) {
            return { ...item, operationIds: remainingItemOperationIds, status: item.status === 'completed' ? 'partial' : item.status };
          }
          return item;
        });
        const remainingUndoable = remainingResults.some((item) => item.status !== 'undone' && (
          typeof item.result?.operationId === 'string'
          || (Array.isArray(item.operationIds) && item.operationIds.length > 0)
          || (Array.isArray(item.result?.operationIds) && item.result.operationIds.length > 0)
        ));
        setExecution(remainingUndoable ? {
          ...execution,
          results: remainingResults,
          completed: remainingResults.filter((item) => item.status === 'completed').length,
        } : null);
        appendMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: `已撤销 ${undoneCount} 项操作${firstFailure ? `，另有未撤销的失败项：${firstFailure}` : ''}。`,
        });
        await onOperationComplete?.();
      } else if (firstFailure) {
        setError(firstFailure);
      }
    } finally {
      setUndoBusyAll(false);
    }
  };

  // 每日摘要：生成/更新今天的 Journal 摘要笔记并打开
  const runDigest = async () => {
    if (composerBusy) return;
    setError('');
    setDigesting(true);
    try {
      const response = await aiApi.digest(requestOptions);
      const result = ((response as HttpEnvelope)?.data ?? response ?? {}) as AiDigestResult;
      const digestTitle = safeSessionTitle(result.title ?? result.noteTitle ?? result.name, '今日摘要');
      const rawModifiedCount = result.modifiedCount ?? result.modified_count ?? result.count;
      const modifiedCount = Number.isFinite(Number(rawModifiedCount)) ? Number(rawModifiedCount) : 0;
      appendMessage({
        id: `system-${Date.now()}`,
        role: 'system',
        content: `${result.created ? '已创建' : '已更新'}「${digestTitle}」：汇总了 ${modifiedCount} 篇今日修改的笔记${result.aiOverview ? '，含 AI 总览' : ''}。`,
      });
      if (result.noteId) onOpenNote?.(result.noteId);
      await onOperationComplete?.();
    } catch (requestError: any) {
      setError(requestError?.message ?? '每日摘要生成失败');
    } finally {
      setDigesting(false);
    }
  };

  const togglePreferModel = () => setSettings((current) => saveAiSettings({ ...current, preferModel: current.preferModel !== true }));
  const openPersonalization = () => {
    setAttachmentMenuOpen(false);
    setComposerMenu(null);
    setHeaderMenuOpen(false);
    setPersonalizationOpen(true);
  };
  return (
    <div className="ai-assistant-layer ai-assistant-layer--workspace" role="presentation">
      <SessionRenameDialog
        open={Boolean(sessionRename)}
        title={sessionRename?.title ?? ''}
        saving={sessionRenameSaving}
        inputRef={sessionRenameInputRef}
        onChange={(title) => setSessionRename((current) => (current ? { ...current, title } : current))}
        onClose={() => { if (!sessionRenameSaving) setSessionRename(null); }}
        onSubmit={submitSessionRename}
      />
      {personalizationOpen ? (
        <div className="notion-personalization__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPersonalizationOpen(false); }}>
            <section className="notion-personalization" role="dialog" aria-modal="true" aria-labelledby="lattice-personalization-title">
            <button type="button" className="notion-personalization__close" onClick={() => setPersonalizationOpen(false)} aria-label="关闭个性化"><X size={18} /></button>
            <h2 id="lattice-personalization-title">个性化你的 Lattice AI</h2>
            <div className="notion-personalization__avatar-row">
              <button type="button" className="notion-personalization__arrow" aria-label="上一个形象" onClick={() => setSelectedAvatar((value) => (value + GLIM_STATES.length - 1) % GLIM_STATES.length)}><ChevronLeft size={18} /></button>
              <div className="notion-personalization__avatar-stage">
                <GlimMascot size="hero" state={GLIM_STATES[selectedAvatar % GLIM_STATES.length]?.state ?? 'idle'} title={GLIM_STATES[selectedAvatar % GLIM_STATES.length]?.label} />
                <div className="notion-personalization__avatar-caption">
                  <strong>{GLIM_STATES[selectedAvatar % GLIM_STATES.length]?.label}</strong>
                  <span>{GLIM_STATES[selectedAvatar % GLIM_STATES.length]?.note}</span>
                </div>
              </div>
              <button type="button" className="notion-personalization__arrow" aria-label="下一个形象" onClick={() => setSelectedAvatar((value) => (value + 1) % GLIM_STATES.length)}><ChevronRight size={18} /></button>
            </div>
            <input className="notion-personalization__name" value={personalizationName} onChange={(event) => setPersonalizationName(event.target.value)} placeholder="输入名称" aria-label="代理名称" />
            <div className="notion-personalization__instructions-head"><span>说明</span></div>
            <div className="notion-personalization__instructions">
              <textarea value={personalizationInstruction} onChange={(event) => setPersonalizationInstruction(event.target.value)} placeholder="使用页面为 Lattice AI 提供指令并指导其行为" aria-label="代理说明" rows={2} />
              <button type="button" onClick={() => setPersonalizationInstruction((value) => value ? `${value}\n请始终先理解上下文，再给出清晰、可执行的结果。` : '请始终先理解上下文，再给出清晰、可执行的结果。')}><Plus size={15} />添加指令</button>
            </div>
            <div className="notion-personalization__avatar-grid" aria-label="选择形象">
              {GLIM_STATES.map((entry, index) => (
                <button type="button" key={entry.state} className={selectedAvatar === index ? 'is-selected' : ''} onClick={() => setSelectedAvatar(index)} aria-label={`形象：${entry.label}`} title={entry.label}>
                  <GlimMascot size="small" state={entry.state} />
                </button>
              ))}
            </div>
            <footer className="notion-personalization__actions">
              <button type="button" onClick={() => { setPersonalizationName(''); setPersonalizationInstruction(''); setSelectedAvatar(0); }}>重置</button>
              <button type="button" className="notion-personalization__done" onClick={() => { setPersonalizationOpen(false); toast.success('Lattice AI 个性化设置已保存'); }}>完成</button>
            </footer>
          </section>
        </div>
      ) : null}
      <aside className="ai-workspace__sidebar" aria-label="AI 会话">
        <div className="notion-workspace__head">
          <button type="button" className="notion-workspace__identity" onClick={onClose} title="返回知识库">
            <span className="notion-workspace__icon" aria-hidden="true">N</span>
            <strong>{workspaceLabel}</strong>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
        <section className="notion-workspace__agents" aria-label="Lattice AI">
          <div className="notion-workspace__section-head"><strong>Lattice AI</strong></div>
          <div className="notion-workspace__agent-grid">
            <button type="button" className="notion-workspace__agent is-selected" onClick={openPersonalization}>
              <GlimMascot size="small" state={avatarState} title="Lattice AI" />
              <span>Lattice AI</span>
            </button>
          </div>
        </section>
        <div className="notion-workspace__session-tools">
          <strong>会话</strong>
          <label className="notion-workspace__search" title="搜索对话">
            <Search size={15} aria-hidden="true" />
            <input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="" aria-label="搜索对话" />
          </label>
        </div>
        <div className="ai-workspace__session-list">
          {visibleSessionGroups.map(([group, rows]) => (
            <section key={group} className="ai-workspace__session-group">
              <span className="ai-workspace__session-label">{group}</span>
              {rows.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={`ai-workspace__session${session.id === sessionId ? ' is-active' : ''}`}
                  onClick={() => selectSession(session)}
                  title={safeSessionTitle(session.title, '未命名对话')}
                >
                  <span className="ai-workspace__session-dot" aria-hidden="true" />
                  <span>{safeSessionTitle(session.title, '未命名对话')}</span>
                </button>
              ))}
            </section>
          ))}
          {!sessions.length ? <div className="ai-workspace__session-empty"><strong>暂无会话</strong><span>发送第一条消息后，会话会自动保存在这里。</span></div> : null}
          {sessions.length > 0 && !visibleSessionGroups.length ? <p className="ai-workspace__session-empty">没有匹配的对话</p> : null}
          {sessions.length >= 8 ? <button type="button" className="ai-workspace__all-sessions" onClick={openSessionBrowser}><List size={14} />查看全部对话</button> : null}
        </div>
        <div className="notion-workspace__secondary-links">
          <button type="button" onClick={() => onOpenExpertManager?.('experts')}><BookOpen size={17} /><span>库</span></button>
          <button type="button" onClick={() => onOpenExpertManager?.('skills')}><Settings2 size={17} /><span>设置</span></button>
        </div>
        <div className="notion-workspace__footer">
          <button type="button" className="notion-workspace__new-chat" onClick={onNewChat ?? startNewSession}>
            <LatticeAiAvatar size="tiny" state={avatarState} /><span>新对话</span><kbd>Ctrl+O</kbd>
          </button>
        </div>
      </aside>
      <main className="ai-assistant" aria-label="AI 知识库助手">
        <header className="ai-assistant__header">
          <div className="notion-breadcrumb">
            <button type="button" className="notion-breadcrumb__avatar" onClick={openPersonalization} aria-label="个性化 Lattice AI" title="个性化"><LatticeAiAvatar size="tiny" state={avatarState} /></button>
            <span>Lattice AI</span><ChevronRight size={15} aria-hidden="true" />
            <button type="button" className="notion-breadcrumb__title" onClick={() => setHeaderMenuOpen((value) => !value)}>{activeSessionTitle}<ChevronDown size={14} /></button>
          </div>
          <div className="ai-assistant__header-actions">
            <button type="button" className="icon-btn" onClick={() => toast.info('评论功能已就绪')} aria-label="评论" title="评论"><MessageCircle size={17} /></button>
            <button type="button" className="icon-btn" onClick={() => { void navigator.clipboard?.writeText(window.location.href); toast.success('链接已复制'); }} aria-label="分享" title="分享"><Share2 size={17} /></button>
            <button type="button" className={`icon-btn${pinned ? ' is-active' : ''}`} onClick={() => { setPinned((value) => !value); toast.info(pinned ? '已取消置顶' : '已置顶'); }} aria-label="置顶" title="置顶"><Pin size={17} /></button>
            <div className="notion-header-menu-wrap">
              <button type="button" className="icon-btn" onClick={() => setHeaderMenuOpen((value) => !value)} aria-expanded={headerMenuOpen} aria-label="更多" title="更多"><MoreHorizontal size={18} /></button>
              {headerMenuOpen ? <div className="notion-popover notion-popover--header" role="menu">
                <button type="button" onClick={() => { setHeaderMenuOpen(false); renameCurrentSession(); }}><FileText size={15} />重命名</button>
                <button type="button" onClick={openPersonalization}><UserRound size={15} />个性化 Lattice AI</button>
                <button type="button" onClick={() => { setHeaderMenuOpen(false); onOpenSettings?.('ai'); }}><Settings2 size={15} />设置</button>
              </div> : null}
            </div>
            <button type="button" className="icon-btn ai-assistant__back" onClick={onClose} aria-label="返回上一个工作区" title="返回上一个工作区"><ChevronLeft size={17} /></button>
          </div>
        </header>

        {sessionBrowserOpen ? (
          <AiSessionHistoryView
            rows={sessionBrowserRows}
            meta={sessionBrowserMeta}
            loading={sessionBrowserLoading}
            query={sessionBrowserQuery}
            searchContent={sessionBrowserSearchContent}
            page={sessionBrowserPage}
            pageSize={SESSION_PAGE_SIZE}
            deleteId={sessionBrowserDeleteId}
            currentSessionId={sessionId}
            onClose={() => setSessionBrowserOpen(false)}
            onQueryChange={(value) => { setSessionBrowserQuery(value); setSessionBrowserPage(0); }}
            onSearchContentChange={(value) => { setSessionBrowserSearchContent(value); setSessionBrowserPage(0); }}
            onRefresh={() => setSessionBrowserReload((value) => value + 1)}
            onPageChange={setSessionBrowserPage}
            onSelect={selectSession}
            onDelete={deleteSessionFromBrowser}
          />
        ) : null}

        <>
            {recoverableRuns.length ? (
              <div className="ai-assistant__recovery" role="status">
                <div className="ai-assistant__recovery-copy">
                  <strong>检测到未完成的 AI 任务</strong>
                  <span>{recoverableRuns.length > 1 ? `${recoverableRuns.length} 个任务 · ` : ''}{recoveryStatusLabel(String(recoverableRuns[0].run.status))} · {recoveryKindLabel(recoverableRuns[0].recoveryKind)}</span>
                </div>
                <div className="ai-assistant__recovery-actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={Boolean(recoveryBusyRunId) || composerBusy}
                    onClick={() => { void recoverDurableRun(recoverableRuns[0]); }}
                  >
                    {recoveryBusyRunId === recoverableRuns[0].runId
                      ? '处理中…'
                      : recoverableRuns[0].recoveryKind === 'write_confirmation_required'
                        || recoverableRuns[0].recoveryKind === 'write_payload_unavailable'
                        || recoverableRuns[0].recoveryKind === 'tool_replay_unavailable'
                        ? '重新生成计划'
                        : '恢复任务'}
                  </button>
                  <button type="button" className="btn btn--sm" disabled={Boolean(recoveryBusyRunId)} onClick={() => ignoreDurableRun(recoverableRuns[0].runId)}>忽略</button>
                </div>
                {recoverableRuns.length > 1 ? <small>恢复后可继续处理其他任务</small> : null}
              </div>
            ) : null}
            {activeNote ? (
              <button type="button" className="ai-assistant__active-note" onClick={() => onOpenNote?.(activeNote.id)} title="打开当前笔记">
                <span className="ai-assistant__active-note-icon" aria-hidden="true">#</span>
                <strong>{activeNote.title}</strong>
                <small>{[activeNote.filePath ?? '当前笔记', activeNote.wordCount ? `${activeNote.wordCount} 字` : ''].filter(Boolean).join(' · ')}</small>
              </button>
            ) : null}

            {related.length ? (
              <div className={`ai-assistant__related${relatedOpen ? ' is-open' : ''}`}>
                <button type="button" className="ai-assistant__related-toggle" onClick={() => setRelatedOpen((value) => !value)} aria-expanded={relatedOpen}>
                  <span>相关笔记 · {related.length}</span>
                  <span className="ai-assistant__related-arrow" aria-hidden="true">{relatedOpen ? '▾' : '▸'}</span>
                </button>
                {relatedOpen ? (
                  <div className="ai-assistant__related-list">
                    {related.map((item) => (
                      <button type="button" key={item.id} className="ai-assistant__related-chip" onClick={() => onOpenNote?.(item.id)} title={`${item.filePath ?? ''}\n相关度 ${(item.score * 100).toFixed(0)}%`}>
                        <strong>{item.title}</strong>
                        <small>{Math.round(item.score * 100)}%{item.anchor ? ` · ${item.anchor}` : ''}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div
              className="ai-assistant__messages"
              aria-live="polite"
              ref={messagesRef}
              onScroll={virtualEnabled ? handleMessagesScroll : undefined}
            >
              {messages.length === 1 && messages[0]?.id === WELCOME_MESSAGE.id && !sending ? (
                <div className="ai-welcome">
                  <button type="button" className="ai-welcome__avatar-button" onClick={openPersonalization} aria-label="个性化你的 Lattice AI" title="个性化你的 Lattice AI">
                    <LatticeAiAvatar size="hero" state={avatarState} />
                  </button>
                  <p className="ai-welcome__eyebrow">Lattice AI · 格物知识库</p>
                  <h1>下一个目的地，现在启航!</h1>
                  <p className="ai-welcome__subtitle">笔记、任务与灵感都在这里——从一条提问开始。</p>
                  <div className="ai-welcome__prompts">
                    {WELCOME_PROMPTS.map((item) => (
                      <button type="button" key={item.label} disabled={composerBusy} onClick={() => send(item.prompt)}>
                        <item.icon size={14} aria-hidden="true" />
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {virtualRange && virtualRange.topSpacerHeight > 0 ? <div style={{ height: virtualRange.topSpacerHeight }} aria-hidden="true" /> : null}
                  {visibleMessages.map((message, relativeIndex) => {
                    const index = (virtualRange?.start ?? 0) + relativeIndex;
                    return (
                      <div key={message.id} data-message-index={virtualRange ? index : undefined}>
                        <AiMessageView
                          message={message}
                          onSuggestion={send}
                          onOpenNote={onOpenNote}
                          onSaveToNote={onSaveToNote}
                          isLastAssistant={index === lastAssistantIndex}
                          onRegenerate={regenerateLast}
                          busy={composerBusy}
                          onUndoExecuted={() => undoTaskModeOperations(message)}
                          undoExecutedBusy={taskUndoBusyId === message.id}
                          undoExecutedDone={undoneTaskMessages.has(message.id)}
                          onOpenPath={openPathInVault}
                          onSwitchVariant={(index) => switchVariant(message.id, index)}
                          onFeedback={(rating) => void sendFeedback(message, rating)}
                          feedbackGiven={feedbackGivenMap[message.id] ?? null}
                        />
                      </div>
                    );
                  })}
                  {virtualRange && virtualRange.bottomSpacerHeight > 0 ? <div style={{ height: virtualRange.bottomSpacerHeight }} aria-hidden="true" /> : null}
                </>
              )}
              {sending ? (
                <AiStreamingMessageView
                  taskMode={activeTaskMode}
                  progress={progressSteps}
                  reasoningText={reasoningText}
                  reasoningOpen={reasoningOpen}
                  reasoningStartedAt={reasoningStartedAtRef.current || undefined}
                  streamText={displayStreamText(streamText)}
                  streamStatus={streamStatus}
                  onReasoningToggle={setReasoningOpen}
                />
              ) : null}
            </div>

            {preview ? <AiOperationPreviewView preview={preview} onConfirm={executePreview} onRefresh={refreshOperationPreview} onCancel={cancelOperationPreview} disabled={sending} /> : null}
            {execution ? (
              <AiExecutionSummaryView
                result={execution}
                  undoable={(execution.results ?? []).some((item) => item.status !== 'undone' && (
                    typeof item.result?.operationId === 'string'
                    || (Array.isArray(item.operationIds) && item.operationIds.length > 0)
                    || (Array.isArray(item.result?.operationIds) && item.result.operationIds.length > 0)
                  ))}
                undoBusy={undoBusyAll}
                onUndo={undoExecution}
                onOpenPath={openPathInVault}
              />
            ) : null}
            {error ? (
              <div className="ai-assistant__error" role="alert">
                <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>{error}</span>
                {retryMessage ? <button type="button" className="btn btn--sm" onClick={retryFailedRun}>
                  <RefreshCw size={12} strokeWidth={1.8} aria-hidden="true" />
                  重试
                </button> : null}
              </div>
            ) : null}

            {expertSuggestion ? (
              <div className="ai-assistant__expert-suggestion" role="status">
                <span className="ai-assistant__expert-suggestion-copy">
                  这条消息命中了「{expertSuggestion.name}」的路由关键词{Array.isArray(expertSuggestion.matched) && expertSuggestion.matched.length ? `（${expertSuggestion.matched.slice(0, 3).join('、')}）` : ''}，切换后它会带着专属 Skill 和权限处理后续请求。
                </span>
                <button type="button" className="btn btn--sm" onClick={() => { onSelectExpert?.(expertSuggestion.id); setExpertSuggestion(null); }}>切换</button>
                <button type="button" className="icon-btn" onClick={() => setExpertSuggestion(null)} aria-label="忽略专家建议" title="忽略">×</button>
              </div>
            ) : null}

            {routingClarification ? (
              <div className="ai-assistant__routing-clarification" role="group" aria-labelledby="ai-routing-clarification-title">
                <CircleHelp size={17} strokeWidth={1.8} aria-hidden="true" />
                <div className="ai-assistant__routing-clarification-copy">
                  <strong id="ai-routing-clarification-title">这条请求还不够具体</strong>
                  <span>请选择你希望我优先做的事，原请求会继续保留。</span>
                  <div className="ai-assistant__routing-clarification-options">
                    {ROUTING_CLARIFICATION_OPTIONS.map((option) => (
                      <button type="button" key={option.label} onClick={() => chooseRoutingClarification(option.prompt)} disabled={composerBusy}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button type="button" className="icon-btn" onClick={() => setRoutingClarification(null)} aria-label="关闭澄清提示" title="关闭"><X size={14} /></button>
              </div>
            ) : null}

            <div className="ai-assistant__composer">
              <div className="ai-assistant__quick-actions">
                <button type="button" disabled={composerBusy} onClick={() => send('创建一份幻灯片')}><LayoutGrid size={15} />创建幻灯片</button>
                <button type="button" disabled={composerBusy} onClick={() => send('创建一个表格')}><Table2 size={15} />表格</button>
                <button type="button" disabled={composerBusy} onClick={() => send('研究这个问题并整理关键结论')}><FileSearch size={15} />研究</button>
                <button type="button" disabled={composerBusy} onClick={() => send('将这些内容可视化')}><WandSparkles size={15} />可视化</button>
              </div>
              <form
                className={composerDragActive ? 'is-dragging' : ''}
                onSubmit={(event) => { event.preventDefault(); send(); }}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!composerBusy) setComposerDragActive(true);
                }}
                onDragLeave={() => setComposerDragActive(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setComposerDragActive(false);
                  void addAiFiles(Array.from(event.dataTransfer.files ?? []));
                }}
              >
                {attachments.length ? (
                  <div className="ai-assistant__attachments" aria-label="待发送附件">
                    {attachments.map((attachment) => (
                      <div className={`ai-assistant__attachment ${attachment.kind === 'image' ? 'is-image' : ''}`} key={attachment.id}>
                        {attachment.kind === 'image'
                          ? <img src={attachment.dataUrl} alt={attachment.name} />
                          : <FileText size={17} aria-hidden="true" />}
                        <span className="ai-assistant__attachment-copy">
                          <strong title={attachment.name}>{attachment.name}</strong>
                          <small>{formatAiAttachmentSize(attachment.size)}</small>
                        </span>
                        <button type="button" onClick={() => removeAiFile(attachment.id)} aria-label={`移除附件 ${attachment.name}`} title="移除附件"><X size={13} /></button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {attachmentsRequireExternalModel ? (
                  <div className="ai-assistant__attachment-note" role="status">
                    <span>已添加附件；请先配置支持图片的外部模型，才能发送识别请求。</span>
                    <button type="button" onClick={() => onOpenSettings?.('ai')}>打开模型设置</button>
                  </div>
                ) : null}
                {composerDragActive ? <div className="ai-assistant__drop-hint">松开以添加图片或文件</div> : null}
                <textarea
                  ref={draftRef}
                  value={draft}
                  onChange={(event) => {
                    const nextDraft = event.target.value;
                    setDraft(nextDraft);
                    writeStoredDraft(draftStorageKey, nextDraft);
                  }}
                  onKeyDown={(event) => {
                    // Enter 发送、Shift+Enter 换行；中文输入法组词期间的回车不发送
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  onPaste={(event) => {
                    const imageFiles = getClipboardImageFiles(event.clipboardData);
                    if (!imageFiles.length) return;
                    event.preventDefault();
                    void addAiFiles(imageFiles);
                  }}
                  placeholder="询问 Lattice AI"
                  rows={1}
                  aria-label="输入 AI 指令"
                  disabled={composerBusy}
                />
                <div className="ai-assistant__composer-footer">
                  <div className="ai-assistant__attachment-menu-wrap">
                    <button type="button" className={`ai-assistant__attachment-trigger ${attachmentMenuOpen ? 'is-open' : ''}`} onClick={() => { setComposerMenu(null); setAttachmentMenuOpen((current) => !current); }} aria-expanded={attachmentMenuOpen} aria-label="添加附件" title="添加照片和文件">
                      <Plus size={16} aria-hidden="true" />
                    </button>
                    {attachmentMenuOpen ? (
                      <div className="ai-assistant__menu ai-assistant__menu--attachments" role="menu" aria-label="附件">
                        <button type="button" role="menuitem" onClick={() => attachmentInputRef.current?.click()}>
                          <Paperclip size={15} aria-hidden="true" /><span>添加照片和文件</span>
                        </button>
                        <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); onOpenExpertManager?.('skills'); }}>
                          <WandSparkles size={15} aria-hidden="true" /><span>技能</span><ChevronRight size={14} aria-hidden="true" />
                        </button>
                        <label className="ai-assistant__menu-toggle" role="menuitem">
                          <Globe2 size={15} aria-hidden="true" /><span>网页</span><small>测试版</small>
                          <input type="checkbox" checked={webSearchEnabled} onChange={(event) => setWebSearchEnabled(event.target.checked)} />
                          <span className="ai-assistant__toggle" aria-hidden="true" />
                        </label>
                        <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); onOpenExpertManager?.('mcp'); }}>
                          <LayoutGrid size={15} aria-hidden="true" /><span>连接</span><small>1</small><ChevronRight size={14} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                    <input
                      ref={attachmentInputRef}
                      className="ai-assistant__attachment-input"
                      type="file"
                      accept="image/*,.pdf,.md,.txt,.csv,.json"
                      multiple
                      onChange={(event) => {
                        void addAiFiles(Array.from(event.target.files ?? []));
                        event.currentTarget.value = '';
                      }}
                      aria-label="选择照片和文件"
                    />
                  </div>
                  {attachmentError ? <span className="ai-assistant__attachment-error" role="alert">{attachmentError}</span> : null}
                  <div className="ai-assistant__composer-menu-wrap">
                    <button type="button" className={`ai-assistant__composer-picker ${composerMenu === 'approval' ? 'is-open' : ''}`} onClick={() => { setAttachmentMenuOpen(false); setComposerMenu((current) => current === 'approval' ? null : 'approval'); }} aria-expanded={composerMenu === 'approval'}>
                      <span>{approvalLabel}</span><ChevronDown size={13} />
                    </button>
                    {composerMenu === 'approval' ? (
                      <div className="ai-assistant__menu ai-assistant__menu--workload" role="menu" aria-label="审批模式">
                        <div className="notion-menu__intro"><span>Lattice AI 应如何请求批准?</span><button type="button" onClick={() => toast.info('写入操作会在执行前显示预览')}>了解更多</button></div>
                        <button type="button" role="menuitemradio" aria-checked={false} onClick={() => { setSettings((current) => saveAiSettings({ ...current, interactionMode: 'quick', autoApprove: false })); setComposerMenu(null); }}>
                          <span>始终询问</span><small>在进行更改或共享内容前询问我</small>
                        </button>
                        <button type="button" role="menuitemradio" aria-checked={!taskModeEnabled} className={!taskModeEnabled ? 'is-selected' : ''} onClick={() => { setSettings((current) => saveAiSettings({ ...current, interactionMode: 'quick', autoApprove: false })); setComposerMenu(null); }}>
                          <span>为我审核</span><small>仅在涉及潜在不安全操作时询问我</small>{!taskModeEnabled ? <Check size={16} /> : null}
                        </button>
                        <button
                          type="button"
                          className="is-warning"
                          role="menuitemradio"
                          aria-checked={taskModeEnabled}
                          disabled={taskModeUnsupported}
                          title={taskModeUnsupported ? '当前模型不支持工具调用（连通性测试实测），任务模式不可用' : undefined}
                          onClick={() => { if (taskModeUnsupported) return; setSettings((current) => saveAiSettings({ ...current, interactionMode: 'task', autoApprove: true, preferModel: true })); setComposerMenu(null); }}
                        >
                          <span>跳过所有审批</span><small>{taskModeUnsupported ? '当前模型不支持工具调用，任务模式不可用' : '直接执行，无需询问。请谨慎使用。'}</small>{taskModeEnabled ? <Check size={16} /> : null}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="ai-assistant__composer-menu-wrap">
                    <button type="button" className={`ai-assistant__composer-picker ai-assistant__model-picker ${composerMenu === 'model' ? 'is-open' : ''}`} onClick={() => { setAttachmentMenuOpen(false); setComposerMenu((current) => current === 'model' ? null : 'model'); }} aria-expanded={composerMenu === 'model'}>
                      <span>{settings.preferModel === true && activeProvider?.model && connectionState !== 'local' ? activeProvider.model : '自动'}</span><ChevronDown size={13} />
                    </button>
                    {composerMenu === 'model' ? (
                      <div className="ai-assistant__menu ai-assistant__menu--model" role="menu" aria-label="模型">
                        <div className="notion-model__heading"><strong>自动</strong><small>平衡速度、工作量和费用。</small></div>
                        <button type="button" role="menuitemradio" aria-checked={settings.preferModel !== true} className={settings.preferModel !== true ? 'is-selected' : ''} onClick={() => { if (settings.preferModel) togglePreferModel(); setComposerMenu(null); }}><Sparkles size={14} /><span>自动</span><small>平衡速度和质量</small>{settings.preferModel !== true ? <Check size={15} /> : null}</button>
                        <span className="ai-assistant__menu-label">已配置模型</span>
                        {settings.providers.filter((provider) => provider.enabled !== false).map((provider) => {
                          const configured = Boolean(provider.endpoint?.trim() && provider.model?.trim());
                          const isSelected = settings.preferModel === true && provider.id === settings.activeProviderId;
                          return (
                            <button key={provider.id} type="button" role="menuitemradio" aria-checked={isSelected} className={isSelected ? 'is-selected' : ''}
                              onClick={() => {
                                if (!configured) { setComposerMenu(null); onOpenSettings?.('ai'); return; }
                                setSettings((current) => saveAiSettings({ ...current, activeProviderId: provider.id, preferModel: true }));
                                setComposerMenu(null);
                              }}>
                              <Sparkles size={14} /><span>{provider.model || provider.name || '未命名模型'}</span>
                              <small>{!configured ? '未配置' : provider.verified ? '已连接' : '需要测试连接'}</small>
                              {isSelected ? <Check size={15} /> : null}
                            </button>
                          );
                        })}
                        <button type="button" className="ai-assistant__menu-link" onClick={() => { setComposerMenu(null); onOpenSettings?.('ai'); }}>打开模型设置</button>
                      </div>
                    ) : null}
                  </div>
                  <span className="ai-assistant__composer-hint">Enter 发送 · Shift+Enter 换行</span>
                  {sending
                    ? <button type="button" className="ai-assistant__send ai-assistant__send--stop" onClick={stopGenerating} aria-label="停止生成" title="停止生成"><Square size={11} fill="currentColor" /></button>
                    : <button type="submit" className="ai-assistant__send" disabled={(!draft.trim() && !attachments.length) || composerBusy || attachmentsRequireExternalModel} aria-label="发送消息" title={attachmentsRequireExternalModel ? '请先配置支持图片的外部模型' : '发送消息'}><ArrowUp size={16} /></button>}
                </div>
              </form>
            </div>
        </>
      </main>
    </div>
  );
}
const CONNECTION_STATE_META = {
  local: { label: '本地模式', title: '未配置外部模型，使用本地规则助手' },
  configured: { label: '已配置', title: '已保存模型配置，但尚未通过连通性测试；可在模型管理中点击「测试连接」验证' },
  connected: { label: '已连接', title: '外部模型连通性测试已通过' },
};

function LatticeAiAvatar({ size = 'small', variant = 0, state }: { size?: 'tiny' | 'small' | 'large' | 'hero'; variant?: number; state?: GlimState }) {
  // variant 保留旧签名：>=0 时映射到状态家族，0 即默认待命。
  const resolved: GlimState = state ?? GLIM_STATES[variant % GLIM_STATES.length]?.state ?? 'idle';
  return <GlimMascot size={size} state={resolved} />;
}

































function flattenFolders(nodes: FolderNode[] | null | undefined, parentPath = ''): FolderEntry[] {
  return (nodes ?? []).flatMap((node) => {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    return [{ ...node, path }, ...flattenFolders(node.children, path)];
  });
}

function SessionRenameDialog({ open, title, saving, inputRef, onChange, onClose, onSubmit }: SessionRenameDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title="会话名称" ariaLabel="重命名会话" className="rename-modal" initialFocusRef={inputRef}>
      <form className="rename-dialog" onSubmit={onSubmit}>
        <header className="rename-dialog__header">
          <div>
            <span className="rename-dialog__eyebrow">AI SESSION</span>
            <h2>重命名会话</h2>
          </div>
          <button type="button" className="icon-btn rename-dialog__close" onClick={onClose} aria-label="关闭重命名">
            ×
          </button>
        </header>
        <div className="rename-dialog__body">
          <label htmlFor="rename-session-name">会话名称</label>
          <input
            ref={inputRef}
            id="rename-session-name"
            value={title}
            maxLength={120}
            autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
            disabled={saving}
          />
        </div>
        <footer className="rename-dialog__actions">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className="btn btn--primary" disabled={saving || !title.trim()}>{saving ? '保存中…' : '保存'}</button>
        </footer>
      </form>
    </Modal>
  );
}
