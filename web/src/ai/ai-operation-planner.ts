import type { RequestOptions } from '../api/client.ts';
import type { AiOperationGateway } from './ai-operation-adapter.ts';
import { classifyAiWriteRisk } from '../lib/ai-policy.ts';

export interface AiPlannedAction {
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

export interface AiPlanWarning { code?: string; path?: string | null; message?: string; severity?: string; actionIds?: string[]; }
export interface AiPlanQuality { blocked: boolean; warnings: AiPlanWarning[]; }
export interface AiPlannedOperation {
  id: string;
  orderIndex: number;
  originalType?: string;
  type: string;
  path?: string | null;
  targetPath?: string | null;
  action: AiPlannedAction;
  risk?: string;
  riskLevel?: string;
  riskReason?: string;
  requiresConfirmation?: boolean;
  sensitive?: boolean;
  sensitivityReason?: string;
  previewFailed?: boolean;
  summary?: string;
  error?: string;
  diff?: string;
  planId?: string | null;
  planHash?: string | null;
  blocked?: boolean;
  quality?: { blocked?: boolean; warnings?: AiPlanWarning[] } | null;
  additionalConfirmationReasons?: string[];
  [key: string]: unknown;
}

export interface AiImpactItem {
  id: string;
  actionId: string;
  type: string;
  path: string | null;
  targetPath: string | null;
  fullPath: string | null;
  directory: string | null;
  impact: string | null;
  audience: string[];
  external: boolean;
  reversible: boolean;
  executable: boolean;
}

export interface AiImpactScope {
  operationCount: number;
  executableCount: number;
  resourceCount: number;
  paths: string[];
  targetPaths: string[];
  audiences: string[];
  hasExternalEffect: boolean;
  hasIrreversibleEffect: boolean;
  summary: string;
  items: AiImpactItem[];
}

export interface AiOperationPreview {
  id: string;
  blocked: boolean;
  quality: AiPlanQuality;
  requiresAdditionalConfirmation: boolean;
  additionalConfirmationReasons: string[];
  requiresSensitiveConfirmation: boolean;
  actions: AiPlannedAction[];
  operations: AiPlannedOperation[];
  fileOperations: AiPlannedOperation[];
  failedOperations: AiPlannedOperation[];
  aiOperations: AiPlannedAction[];
  aiPlanId: string | null;
  aiPlanHash: string | null;
  impact: AiImpactScope;
  summary: string;
  createdAt: string;
}

/** L1 自动执行只允许整批计划全部是可撤销的低风险写入。 */
export function isAutoExecutableL1Plan(preview: AiOperationPreview | null | undefined): boolean {
  if (!preview || preview.blocked || preview.failedOperations.length || preview.aiOperations.length) return false;
  if (!preview.operations.length || preview.fileOperations.length !== preview.operations.length) return false;
  return preview.operations.every((operation) => (
    operation.previewFailed !== true
    && operation.blocked !== true
    && operation.riskLevel === 'L1'
    && operation.requiresConfirmation === false
  ));
}

interface PreviewEnvelope {
  operations?: AiPlannedOperation[] | null;
  quality?: AiPlanQuality | null;
  plan?: { id?: string | null } | null;
  id?: string;
  planHash?: string | null;
  blocked?: unknown;
  additionalConfirmationReasons?: string[];
  requiresAdditionalConfirmation?: boolean;
  requiresSensitiveConfirmation?: boolean;
  [key: string]: unknown;
}

interface HttpEnvelope { data?: unknown; [key: string]: unknown; }

const FILE_KERNEL_ACTIONS = new Set(['create', 'update', 'delete', 'move', 'copy']);

function unwrap<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'data' in value) return (value as { data: T }).data;
  return value as T;
}

function describeAction(action: AiPlannedAction | null | undefined) {
  const labels: Record<string, string> = { read: '读取', create: '创建', update: '更新', delete: '删除', move: '移动', copy: '复制', archive: '归档' };
  return `${labels[action?.type ?? ''] ?? action?.type ?? '操作'} ${action?.path ?? ''}${action?.targetPath ? ` → ${action.targetPath}` : ''}`.trim();
}

function dedupeWarnings(warnings: AiPlanWarning[] = []) {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code ?? 'warning'}|${warning.path ?? ''}|${(warning.actionIds ?? []).join(',')}|${warning.message ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toFileMutation(action: AiPlannedAction) {
  const mutationType = action.type === 'update' ? 'write' : action.type;
  return {
    type: mutationType,
    path: action.path ?? action.sourcePath ?? action.fromPath,
    ...(action.targetPath || action.toPath || action.destination ? { targetPath: action.targetPath ?? action.toPath ?? action.destination } : {}),
    ...(action.content !== undefined ? { content: String(action.content) } : {}),
  };
}

function withIds(actions: AiPlannedAction[]) {
  return actions.map((action, index) => ({ ...action, id: String(action.id ?? `op-${index + 1}`) }));
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,;\n]/u).map((item) => item.trim()).filter(Boolean);
  return [];
}

function buildImpactScope(operations: AiPlannedOperation[]): AiImpactScope {
  const items = operations.map((operation, index) => {
    const action = operation.action ?? {};
    const actionId = String(action.id ?? operation.id ?? `op-${index + 1}`);
    const type = String(operation.type ?? action.type ?? 'operation');
    const path = operation.path ?? action.path ?? action.sourcePath ?? action.fromPath ?? null;
    const targetPath = operation.targetPath ?? action.targetPath ?? action.toPath ?? action.destination ?? null;
    const fullPath = typeof operation.fullPath === 'string' ? operation.fullPath : null;
    const directory = typeof operation.directory === 'string' ? operation.directory : null;
    const audience = toStringList(action.audience ?? action.audiences ?? operation.audience ?? operation.audiences);
    const external = action.external === true || operation.external === true
      || ['send', 'publish', 'share', 'permission', 'permissions'].includes(type.toLowerCase());
    const reversible = action.reversible !== false && operation.reversible !== false && !external;
    return {
      id: String(operation.id ?? actionId), actionId, type,
      path: path == null ? null : String(path), targetPath: targetPath == null ? null : String(targetPath),
      fullPath, directory, impact: typeof operation.impact === 'string' ? operation.impact : null,
      audience: [...new Set(audience)], external, reversible,
      executable: operation.previewFailed !== true && operation.blocked !== true,
    };
  });
  const executableItems = items.filter((item) => item.executable);
  const paths = [...new Set(items.flatMap((item) => item.path ? [item.path] : []))];
  const targetPaths = [...new Set(items.flatMap((item) => item.targetPath ? [item.targetPath] : []))];
  const audiences = [...new Set(items.flatMap((item) => item.audience))];
  const resourceCount = new Set([...paths, ...targetPaths]).size;
  const hasExternalEffect = items.some((item) => item.external);
  const hasIrreversibleEffect = items.some((item) => !item.reversible);
  const qualifiers = [
    hasExternalEffect ? '包含外部受众或第三方系统' : '',
    hasIrreversibleEffect ? '包含不可撤销影响' : '本地文件动作可通过快照撤销',
  ].filter(Boolean);
  return {
    operationCount: items.length,
    executableCount: executableItems.length,
    resourceCount,
    paths,
    targetPaths,
    audiences,
    hasExternalEffect,
    hasIrreversibleEffect,
    summary: `${executableItems.length}/${items.length} 项操作，涉及 ${resourceCount} 个资源${qualifiers.length ? `；${qualifiers.join('；')}` : ''}`,
    items,
  };
}

export { buildImpactScope };

/** Builds a complete, executable preview without coupling the React panel to API details. */
export function createAiOperationPlanner(gateway: Pick<AiOperationGateway, 'preview'> & { filePreview?: (input: unknown, options?: RequestOptions) => Promise<unknown> }) {
  return {
    async build(actions: AiPlannedAction[], requestOptions: RequestOptions = {}, role = 'editor', allowedPaths?: readonly string[]): Promise<AiOperationPreview | null> {
      const executionContext = {
        actor: 'local-user',
        role,
        ...(allowedPaths ? { allowedPaths: [...allowedPaths] } : {}),
      };
      const draftActions = withIds(actions);
      const fileActions = draftActions.filter((action) => FILE_KERNEL_ACTIONS.has(action.type));
      const archiveActions = draftActions.filter((action) => action.type === 'archive');
      const fileOperations: AiPlannedOperation[] = [];
      const failedOperations: AiPlannedOperation[] = [];
      let batchQuality: AiPlanQuality = { blocked: false, warnings: [] };

      try {
        const data = unwrap<PreviewEnvelope>(await gateway.preview({ actions: draftActions, ...executionContext }, requestOptions));
        if (data?.quality) batchQuality = data.quality;
      } catch {
        // Individual previews remain useful when a combined plan contains one invalid action.
      }

      await Promise.all(fileActions.map(async (action, index) => {
        const risk = classifyAiWriteRisk(action, { batchSize: draftActions.length });
        const base: AiPlannedOperation = {
          id: String(action.id ?? `file-op-${index + 1}`), orderIndex: index, originalType: action.type, type: action.type,
          path: action.path, targetPath: action.targetPath, action, risk: action.type === 'delete' ? 'destructive' : 'write',
          riskLevel: risk.level, riskReason: risk.reason, requiresConfirmation: true,
        };
        try {
          const data = unwrap<PreviewEnvelope>(await gateway.preview({ actions: [action], ...executionContext, source: 'ai-chat' }, requestOptions));
          const operation = data?.operations?.[0] ?? {};
          let diff = '';
          if (gateway.filePreview) {
            try {
              const response = unwrap<HttpEnvelope>(await gateway.filePreview({ ...toFileMutation(action), ...executionContext }, requestOptions));
              diff = String(response?.diff ?? '');
            } catch {
              // Diff is presentation-only; the AI operation preview remains authoritative.
            }
          }
          fileOperations.push({
            ...data,
            ...base,
            ...operation,
            action,
            diff,
            riskLevel: risk.level,
            riskReason: risk.reason,
            requiresConfirmation: risk.requiresConfirmation,
            planId: data.plan?.id ?? data.id,
            planHash: data.planHash,
            blocked: data.blocked === true,
          });
        } catch (error) {
          failedOperations.push({ ...base, previewFailed: true, summary: describeAction(action), error: error instanceof Error ? error.message : '预览失败：路径不合法或源文件状态异常' });
        }
      }));
      const byOrder = (left: AiPlannedOperation, right: AiPlannedOperation) => left.orderIndex - right.orderIndex;
      fileOperations.sort(byOrder); failedOperations.sort(byOrder);

      let archiveOperations: AiPlannedOperation[] = [];
      let aiOperations: AiPlannedAction[] = [];
      let aiPlanHash: string | null = null;
      let aiPlanId: string | null = null;
      let archiveBlocked = false;
      let archiveRequiresAdditionalConfirmation = false;
      let archiveRequiresSensitiveConfirmation = false;
      let archiveAdditionalConfirmationReasons: string[] = [];
      let archiveQuality: AiPlanQuality = { blocked: false, warnings: [] };
      if (archiveActions.length) {
        try {
          const data = unwrap<PreviewEnvelope>(await gateway.preview({ actions: archiveActions, ...executionContext }, requestOptions));
          archiveOperations = (data.operations ?? []).map((operation, index) => ({
            ...operation, id: String(operation.id ?? `archive-op-${index + 1}`), action: archiveActions[index],
            riskLevel: classifyAiWriteRisk(archiveActions[index], { batchSize: draftActions.length }).level,
            riskReason: classifyAiWriteRisk(archiveActions[index], { batchSize: draftActions.length }).reason,
          }));
          aiOperations = archiveActions; aiPlanHash = data.planHash ?? null; aiPlanId = data.plan?.id ?? data.id ?? null;
          archiveBlocked = data.blocked === true; archiveRequiresAdditionalConfirmation = data.requiresAdditionalConfirmation === true;
          archiveRequiresSensitiveConfirmation = data.requiresSensitiveConfirmation === true;
          archiveAdditionalConfirmationReasons = data.additionalConfirmationReasons ?? []; archiveQuality = data.quality ?? archiveQuality;
        } catch {
          archiveOperations = archiveActions.map((action, index) => ({
            id: String(action.id ?? `archive-op-${index + 1}`), orderIndex: index, originalType: action.type, type: action.type,
            path: action.path, targetPath: action.targetPath, action, previewFailed: true, risk: 'write',
            riskLevel: classifyAiWriteRisk(action, { batchSize: draftActions.length }).level,
            riskReason: classifyAiWriteRisk(action, { batchSize: draftActions.length }).reason, requiresConfirmation: true,
            summary: describeAction(action), error: '归档预览失败：源文件可能不是待整理的 Inbox 笔记',
          }));
        }
      }

      const operations = [...fileOperations, ...archiveOperations, ...failedOperations];
      if (!operations.length) return null;
      const qualityWarnings = dedupeWarnings([
        ...(batchQuality.warnings ?? []), ...(archiveQuality.warnings ?? []),
        ...fileOperations.flatMap((operation) => operation.quality?.warnings ?? []),
      ]);
      const quality: AiPlanQuality = { blocked: batchQuality.blocked === true || archiveQuality.blocked === true || qualityWarnings.some((warning) => warning.severity === 'error'), warnings: qualityWarnings };
      const blocked = role === 'viewer' || quality.blocked || fileOperations.some((operation) => operation.blocked) || archiveBlocked;
      const writes = operations.filter((operation) => operation.requiresConfirmation !== false).length;
      const additionalConfirmationReasons = [...new Set([
        ...fileOperations.flatMap((operation) => operation.additionalConfirmationReasons ?? []), ...archiveAdditionalConfirmationReasons,
        ...(writes > 1 ? ['batch'] : []), ...(operations.some((operation) => operation.type === 'delete') ? ['delete'] : []),
        ...(operations.some((operation) => operation.sensitive) ? ['sensitive'] : []),
      ])];
      return {
        id: globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}`, blocked, quality,
        requiresAdditionalConfirmation: archiveRequiresAdditionalConfirmation || additionalConfirmationReasons.length > 0,
        additionalConfirmationReasons, requiresSensitiveConfirmation: archiveRequiresSensitiveConfirmation || operations.some((operation) => operation.sensitive),
        actions: draftActions, operations, fileOperations, failedOperations, aiOperations, aiPlanId, aiPlanHash,
        impact: buildImpactScope(operations),
        summary: `${operations.length} 项操作 · ${writes} 项需要确认`, createdAt: new Date().toISOString(),
      };
    },
  };
}
