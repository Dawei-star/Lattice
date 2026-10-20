export interface AiToolCheckpointStep {
  id: string;
  operationId?: string;
  operationIds?: string[];
  toolName?: string;
  callId?: string;
  input?: Record<string, string | number>;
  status: 'completed' | 'failed' | 'pending';
  type?: string;
  path?: string | null;
  targetPath?: string | null;
}

export interface AiToolCheckpoint {
  stage: 'tool_execution' | 'waiting_confirmation' | 'tool_completed' | 'tool_failed';
  planHash?: string;
  sequence?: number;
  nextStepId?: string;
  lastError?: string;
  completedSteps: AiToolCheckpointStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Rehydrates only the Rust-approved checkpoint fields before a resumed run. */
export function normalizeToolCheckpoint(value: unknown): AiToolCheckpoint | null {
  if (!isRecord(value)) return null;
  const stage = value.stage;
  if (stage !== 'tool_execution' && stage !== 'waiting_confirmation' && stage !== 'tool_completed' && stage !== 'tool_failed') return null;
  if (!Array.isArray(value.completedSteps)) return null;
  const completedSteps = value.completedSteps.flatMap((item): AiToolCheckpointStep[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) return [];
    const status = item.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'pending') return [];
    return [{
      id: item.id,
      status,
      ...(typeof item.operationId === 'string' ? { operationId: item.operationId } : {}),
      ...(Array.isArray(item.operationIds) ? {
        operationIds: item.operationIds.filter((value): value is string => typeof value === 'string').slice(0, 64),
      } : {}),
      ...(typeof item.toolName === 'string' ? { toolName: item.toolName } : {}),
      ...(typeof item.callId === 'string' ? { callId: item.callId } : {}),
      ...(isRecord(item.input) ? {
        input: Object.fromEntries(Object.entries(item.input).flatMap(([key, value]) => (
          (['path', 'query'].includes(key) && typeof value === 'string')
            || (['offset', 'limit'].includes(key) && typeof value === 'number' && Number.isFinite(value))
            ? [[key, value]]
            : []
        ))) as Record<string, string | number>,
      } : {}),
      ...(typeof item.type === 'string' ? { type: item.type } : {}),
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
      ...(typeof item.targetPath === 'string' ? { targetPath: item.targetPath } : {}),
    }];
  });
  return {
    stage,
    ...(typeof value.planHash === 'string' && value.planHash ? { planHash: value.planHash } : {}),
    ...(typeof value.sequence === 'number' && Number.isFinite(value.sequence) ? { sequence: Math.max(0, value.sequence) } : {}),
    ...(typeof value.nextStepId === 'string' && value.nextStepId ? { nextStepId: value.nextStepId } : {}),
    ...(typeof value.lastError === 'string' && value.lastError ? { lastError: value.lastError } : {}),
    completedSteps,
  };
}

/** Reuse completed steps only when the resumed operation plan is still the same. */
export function checkpointForPlan(checkpoint: AiToolCheckpoint | null | undefined, planHash?: string | null): AiToolCheckpoint {
  if (!checkpoint) return createToolCheckpoint(planHash);
  if (checkpoint.planHash && planHash && checkpoint.planHash !== planHash) return createToolCheckpoint(planHash);
  return planHash && !checkpoint.planHash ? { ...checkpoint, planHash } : checkpoint;
}

export function createToolCheckpoint(planHash?: string | null): AiToolCheckpoint {
  return {
    stage: 'tool_execution',
    ...(planHash ? { planHash } : {}),
    completedSteps: [],
  };
}

export function recordToolCheckpointStep(
  checkpoint: AiToolCheckpoint,
  step: Omit<AiToolCheckpointStep, 'status'>,
  status: AiToolCheckpointStep['status'],
): AiToolCheckpoint {
  const next = checkpoint.completedSteps.filter((item) => item.id !== step.id);
  next.push({ ...step, status });
  return { ...checkpoint, completedSteps: next };
}

export function completedToolStep(checkpoint: AiToolCheckpoint | null | undefined, id: string) {
  return checkpoint?.completedSteps.find((step) => step.id === id && step.status === 'completed');
}
