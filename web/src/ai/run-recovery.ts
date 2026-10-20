import type { TauriAiRunClient, TauriAiRunRecord } from './providers/tauri-provider.ts';
import { aiStorageKey } from './storage.ts';
import { isProviderReadToolName } from './provider-read-tools.ts';

export interface DurableRunIndexRecord {
  runId: string;
  sessionId: string;
  createdAt: string;
  expertId?: string;
  workspaceId?: string;
  permissionScopeId?: string;
  permissionVersion?: string;
}

export interface DurableRunRecovery extends DurableRunIndexRecord {
  run: TauriAiRunRecord;
  recoveryKind: DurableRunRecoveryKind;
}

export type DurableRunRecoveryKind =
  | 'run_resume'
  | 'read_replayable'
  | 'write_confirmation_required'
  | 'write_payload_unavailable'
  | 'tool_replay_unavailable';

const STORAGE_KEY = 'lattice-ai-durable-runs-v1';
const MAX_INDEX_SIZE = 32;
const RECOVERABLE_STATUSES = new Set(['queued', 'running', 'failed', 'cancelled']);
const WRITE_TOOL_NAMES = new Set(['lattice_file_operation']);
const WRITE_OPERATION_TYPES = new Set(['create', 'update', 'delete', 'move', 'copy']);

function checkpointSteps(run: Pick<TauriAiRunRecord, 'checkpoint'>): Array<Record<string, unknown>> {
  const checkpoint = run.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return [];
  const steps = (checkpoint as { completedSteps?: unknown }).completedSteps;
  return Array.isArray(steps)
    ? steps.filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
    : [];
}

function checkpointStage(run: Pick<TauriAiRunRecord, 'checkpoint'>): string {
  const checkpoint = run.checkpoint;
  return checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
    ? String((checkpoint as { stage?: unknown }).stage ?? '')
    : '';
}

function hasProviderReadStep(run: Pick<TauriAiRunRecord, 'checkpoint'>): boolean {
  return checkpointSteps(run).some((step) => (
    isProviderReadToolName(step.toolName)
      && typeof step.callId === 'string'
  ));
}

function hasWriteStep(run: Pick<TauriAiRunRecord, 'checkpoint'>): boolean {
  return checkpointSteps(run).some((step) => (
    (typeof step.toolName === 'string' && WRITE_TOOL_NAMES.has(step.toolName))
      || (typeof step.type === 'string' && WRITE_OPERATION_TYPES.has(step.type))
  ));
}

function hasUnknownToolStep(run: Pick<TauriAiRunRecord, 'checkpoint'>): boolean {
  return checkpointSteps(run).some((step) => (
    typeof step.toolName === 'string'
      && !isProviderReadToolName(step.toolName)
      && !WRITE_TOOL_NAMES.has(step.toolName)
  ));
}

/**
 * Classify what can safely happen after a desktop process restart.
 * Write bodies are intentionally absent from checkpoints, so they can never
 * be resumed automatically, including when read and write steps are mixed.
 */
export function classifyDurableRunRecovery(run: Pick<TauriAiRunRecord, 'checkpoint'>): DurableRunRecoveryKind | null {
  if (hasWriteStep(run)) return 'write_payload_unavailable';
  if (hasUnknownToolStep(run)) return 'tool_replay_unavailable';
  if (checkpointStage(run) === 'waiting_confirmation') return 'write_confirmation_required';
  if (hasProviderReadStep(run)) return 'read_replayable';
  return 'run_resume';
}

function isRecord(value: unknown): value is DurableRunIndexRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DurableRunIndexRecord>;
  return typeof item.runId === 'string' && item.runId.trim().length > 0
    && typeof item.sessionId === 'string' && item.sessionId.trim().length > 0
    && typeof item.createdAt === 'string' && item.createdAt.trim().length > 0;
}

function storageKey(namespace?: string | null): string {
  return namespace ? aiStorageKey(STORAGE_KEY, namespace) : STORAGE_KEY;
}

function readIndex(namespace?: string | null): DurableRunIndexRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(namespace)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const unique = new Map<string, DurableRunIndexRecord>();
    for (const item of parsed) {
      if (isRecord(item)) unique.set(item.runId, item);
    }
    return [...unique.values()].slice(-MAX_INDEX_SIZE);
  } catch {
    return [];
  }
}

function writeIndex(records: DurableRunIndexRecord[], namespace?: string | null) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(namespace), JSON.stringify(records.slice(-MAX_INDEX_SIZE)));
  } catch {
    // Indexing is best effort and must not block a durable Run.
  }
}

export function loadDurableRunIds(namespace?: string | null): DurableRunIndexRecord[] {
  return readIndex(namespace);
}

export function rememberDurableRun(record: DurableRunIndexRecord, namespace?: string | null): DurableRunIndexRecord[] {
  if (!isRecord(record)) return readIndex(namespace);
  const next = readIndex(namespace).filter((item) => item.runId !== record.runId);
  next.push({
    runId: record.runId,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    ...(record.expertId ? { expertId: record.expertId } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    ...(record.permissionScopeId ? { permissionScopeId: record.permissionScopeId } : {}),
    ...(record.permissionVersion ? { permissionVersion: record.permissionVersion } : {}),
  });
  writeIndex(next, namespace);
  return next;
}

export function forgetDurableRun(runId: string, namespace?: string | null): DurableRunIndexRecord[] {
  const next = readIndex(namespace).filter((item) => item.runId !== runId);
  writeIndex(next, namespace);
  return next;
}

export async function scanDurableRuns(client: Pick<TauriAiRunClient, 'get'>, namespace?: string | null): Promise<DurableRunRecovery[]> {
  const indexed = readIndex(namespace);
  const recoverable: DurableRunRecovery[] = [];
  const staleIds: string[] = [];
  await Promise.all(indexed.map(async (record) => {
    try {
      const run = await client.get(record.runId);
      if (!run) {
        staleIds.push(record.runId);
        return;
      }
      const recoveryKind = classifyDurableRunRecovery(run);
      const stage = checkpointStage(run);
      if (String(run.status) === 'completed'
        && stage !== 'waiting_confirmation'
        && recoveryKind !== 'read_replayable'
        && recoveryKind !== 'write_payload_unavailable'
        && recoveryKind !== 'tool_replay_unavailable') {
        staleIds.push(record.runId);
        return;
      }
      if (RECOVERABLE_STATUSES.has(String(run.status)) || stage === 'waiting_confirmation' || recoveryKind) {
        recoverable.push({
          ...record,
          run,
          recoveryKind: recoveryKind ?? 'run_resume',
        });
      }
      else staleIds.push(record.runId);
    } catch {
      // A transient IPC error should leave the candidate available for the next scan.
    }
  }));
  if (staleIds.length) {
    const stale = new Set(staleIds);
    writeIndex(readIndex(namespace).filter((record) => !stale.has(record.runId)), namespace);
  }
  return recoverable.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function isRecoverableDurableRunStatus(status: unknown): boolean {
  return RECOVERABLE_STATUSES.has(String(status));
}
