import { useEffect, useState } from 'react';
import { Check, Plus, RefreshCw, X } from 'lucide-react';
import type { AiImpactScope } from '../../ai/ai-operation-planner.ts';

export interface AiAction {
  id?: string;
  type: string;
  path?: string | null;
  targetPath?: string | null;
  content?: string;
  [key: string]: unknown;
}

interface PlanWarning { code?: string; path?: string | null; message?: string; severity?: string; actionIds?: string[]; }
interface PreviewOperation {
  id: string;
  orderIndex: number;
  type: string;
  action: AiAction;
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
  [key: string]: unknown;
}

export interface AiOperationPreviewData {
  blocked: boolean;
  quality?: { blocked?: boolean; warnings?: PlanWarning[] } | null;
  requiresAdditionalConfirmation: boolean;
  additionalConfirmationReasons: string[];
  impact?: AiImpactScope;
  actions?: AiAction[];
  operations: PreviewOperation[];
  summary: string;
}

export interface AiOperationPreviewProps {
  preview: AiOperationPreviewData;
  onConfirm: (options: { additionalConfirmed: boolean; actions?: AiAction[] }) => void;
  onRefresh?: (actions: AiAction[]) => Promise<AiOperationPreviewData | null | undefined>;
  onCancel: () => void;
  disabled?: boolean;
}

function previewActions(preview: AiOperationPreviewData | null | undefined): AiAction[] {
  const actions = Array.isArray(preview?.actions) ? preview.actions : (preview?.operations ?? []).map((operation) => operation.action).filter(Boolean);
  return actions.map((action, index) => ({ ...action, id: String(action.id ?? `op-${index + 1}`) }));
}

function describeAiAction(action: AiAction | null | undefined) {
  const labels: Record<string, string> = { read: '读取', create: '创建', update: '更新', delete: '删除', move: '移动', copy: '复制', archive: '归档' };
  return `${labels[action?.type ?? ''] ?? action?.type ?? '操作'} ${action?.path ?? ''}${action?.targetPath ? ` → ${action.targetPath}` : ''}`.trim();
}

function extractMarkdownTags(content: unknown) {
  const source = String(content ?? '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return [];
  const lines = match[1].split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*tags\s*:/i.test(line));
  if (index === -1) return [];
  const first = lines[index].replace(/^\s*tags\s*:\s*/i, '').trim();
  const values = first || lines.slice(index + 1).reduce<string[]>((items, line) => { if (/^\s*-\s+/.test(line)) items.push(line.replace(/^\s*-\s+/, '').trim()); return items; }, []).join(',');
  return values.replace(/^\[/, '').replace(/\]$/, '').split(',').map((value) => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function replaceMarkdownTags(content: unknown, value: unknown) {
  const source = String(content ?? '');
  const tags = String(value ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
  if (!tags.length && !/^---\r?\n/.test(source)) return source;
  const serialized = `tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]`;
  const match = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!match) return `---\n${serialized}\n---\n${source}`;
  const lineEnding = match[1].includes('\r\n') ? '\r\n' : '\n';
  const lines = match[2].split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*tags\s*:/i.test(line));
  if (index === -1) lines.push(serialized);
  else { let end = index + 1; while (end < lines.length && /^\s*-\s+/.test(lines[end])) end += 1; lines.splice(index, end - index, serialized); }
  return `${match[1]}${lines.join(lineEnding)}${match[3]}${source.slice(match[0].length)}`;
}

function formatAdditionalConfirmationReasons(reasons: string[] = []) {
  const labels: Record<string, string> = { batch: '批量操作', delete: '删除操作', sensitive: '敏感文件', 'high-risk': '高风险操作' };
  return [...new Set(reasons)].map((reason) => labels[reason]).filter(Boolean).join('、') || '高风险操作';
}

function impactItemLabel(item: AiImpactScope['items'][number]) {
  const target = item.targetPath ? ` → ${item.targetPath}` : '';
  return `${item.type} ${item.path ?? '未指定资源'}${target}`;
}

export default function AiOperationPreview({ preview, onConfirm, onRefresh, onCancel, disabled }: AiOperationPreviewProps) {
  const [draftActions, setDraftActions] = useState<AiAction[]>(() => previewActions(preview));
  const [dirty, setDirty] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [additionalConfirmed, setAdditionalConfirmed] = useState(false);
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setDraftActions(previewActions(preview));
    setDirty(false);
    setNotice('');
    setAdditionalConfirmed(false);
    setAcceptedIds(new Set());
  }, [preview]);

  const requiresAdditionalConfirmation = preview.requiresAdditionalConfirmation === true;
  const additionalConfirmationLabel = formatAdditionalConfirmationReasons(preview.additionalConfirmationReasons);
  const qualityWarnings = preview.quality?.warnings ?? [];
  const qualityBlocked = preview.quality?.blocked === true;
  const findDraft = (operation: PreviewOperation) => draftActions.find((action) => String(action.id) === String(operation.action?.id ?? operation.id)) ?? null;
  const selectableOperations = preview.operations.filter((operation) => !operation.previewFailed && Boolean(findDraft(operation)));
  const acceptedActions = selectableOperations
    .filter((operation) => acceptedIds.has(String(operation.action?.id ?? operation.id)))
    .map((operation) => findDraft(operation))
    .filter((action): action is AiAction => Boolean(action));
  const executionActions = acceptedActions.length ? acceptedActions : selectableOperations
    .map((operation) => findDraft(operation))
    .filter((action): action is AiAction => Boolean(action));
  const acceptedActionIds = acceptedActions.length
    ? new Set(acceptedActions.map((action) => String(action.id)))
    : null;
  const impactItems = (preview.impact?.items ?? []).filter((item) => item.executable && (!acceptedActionIds || acceptedActionIds.has(item.actionId)));
  const impactPaths = [...new Set(impactItems.flatMap((item) => item.path ? [item.path] : []))];
  const impactTargetPaths = [...new Set(impactItems.flatMap((item) => item.targetPath ? [item.targetPath] : []))];
  const impactAudiences = [...new Set(impactItems.flatMap((item) => item.audience))];
  const impactHasIrreversibleEffect = impactItems.some((item) => !item.reversible);
  const toggleAccepted = (actionId: string) => {
    setAcceptedIds((current) => {
      const next = new Set(current);
      if (next.has(actionId)) next.delete(actionId);
      else next.add(actionId);
      return next;
    });
    setNotice('');
  };
  const updateDraft = (actionId: string, patch: Partial<AiAction>) => { setDraftActions((current) => current.map((action) => String(action.id) === actionId ? { ...action, ...patch } : action)); setDirty(true); setNotice(''); };
  const removeDraft = (actionId: string) => { setDraftActions((current) => current.filter((action) => String(action.id) !== actionId)); setAcceptedIds((current) => { const next = new Set(current); next.delete(actionId); return next; }); setDirty(true); setNotice(''); };
  const restoreDraft = (operation: PreviewOperation) => { if (!operation.action || draftActions.some((item) => String(item.id) === String(operation.action.id))) return; setDraftActions((current) => [...current, operation.action]); setDirty(true); setAcceptedIds((current) => { const next = new Set(current); next.delete(String(operation.action?.id ?? operation.id)); return next; }); setNotice(''); };
  const refresh = async () => {
    if (!draftActions.length || refreshing || disabled) { if (!draftActions.length) setNotice('至少保留一项操作后才能更新预览'); return; }
    setRefreshing(true);
    try { const next = await onRefresh?.(draftActions); if (!next) return; setDraftActions(previewActions(next)); setAcceptedIds(new Set()); setDirty(false); setNotice(''); } finally { setRefreshing(false); }
  };

  return (
    <section className="ai-operation-preview" aria-label="文件操作预览">
      <header><div><span className="ai-assistant__eyebrow">ACTION PREVIEW</span><h3>确认文件操作</h3></div><span className="ai-operation-preview__risk">{dirty ? '已修改，需更新预览' : preview.blocked ? '当前操作不可执行' : preview.summary}</span></header>
      <div className="ai-operation-preview__hint">可取消单项，或调整目标路径和标签；更新预览后才会提交新的 diff。</div>
      {preview.requiresAdditionalConfirmation && preview.impact ? (
        <div className="ai-operation-preview__impact" role="group" aria-label="高风险操作影响范围">
          <div className="ai-operation-preview__impact-head"><strong>{acceptedActions.length ? '本次确认范围' : '完整影响范围'}</strong><span>{acceptedActions.length ? `${impactItems.length} 项已选择` : preview.impact.summary}</span></div>
          <div className="ai-operation-preview__impact-facts">
            <span>资源 {new Set([...impactPaths, ...impactTargetPaths]).size}</span>
            {impactPaths.length ? <span>源路径 {impactPaths.length}</span> : null}
            {impactTargetPaths.length ? <span>目标路径 {impactTargetPaths.length}</span> : null}
            {impactAudiences.length ? <span>受众 {impactAudiences.join('、')}</span> : null}
            {impactHasIrreversibleEffect ? <span className="is-danger">不可撤销影响</span> : <span>可通过快照撤销</span>}
          </div>
          <ul className="ai-operation-preview__impact-list">
            {impactItems.map((item) => <li key={`${item.id}-${item.actionId}`}><strong>{impactItemLabel(item)}</strong>{item.impact ? <small>{item.impact}</small> : null}</li>)}
          </ul>
        </div>
      ) : null}
      <div className="ai-operation-preview__list">
        {preview.operations.map((operation, index) => {
          const action = findDraft(operation); const actionId = String(operation.action?.id ?? operation.id); const removed = !action;
          const editableTarget = Boolean(action && ['move', 'copy', 'archive'].includes(action.type)); const editableTags = Boolean(action && ['create', 'update'].includes(action.type) && action.content !== undefined);
          const accepted = acceptedIds.has(actionId);
          return <div className={`ai-operation ${operation.previewFailed ? 'is-failed' : operation.risk} ${removed ? 'is-removed' : ''} ${accepted ? 'is-accepted' : ''}`} key={`${operation.id}-${operation.orderIndex ?? index}`}>
            <span className="ai-operation__icon">{removed ? '−' : operation.previewFailed ? '!' : operation.type === 'delete' ? '×' : operation.type === 'read' ? '⌕' : '↗'}</span>
            <div className="ai-operation__body"><strong>{action ? describeAiAction(action) : operation.summary}</strong>
              {operation.sensitive ? <small className="ai-operation__error">{operation.sensitivityReason ?? '敏感文件需要额外确认后执行'}</small> : operation.previewFailed ? <small className="ai-operation__error">预览失败：{operation.error}</small> : <small>{removed ? '已取消，不会执行' : operation.riskLevel ? `${operation.riskLevel} · ${operation.riskReason ?? ''}` : operation.risk === 'destructive' ? '删除操作不可逆' : operation.requiresConfirmation ? '确认后写入 Vault' : '只读操作'}</small>}
              {action && (editableTarget || editableTags) ? <div className="ai-operation__editors">{editableTarget ? <label className="ai-operation__editor"><span>目标路径</span><input type="text" value={action.targetPath ?? ''} onChange={(event) => updateDraft(actionId, { targetPath: event.target.value })} aria-label="编辑目标路径" /></label> : null}{editableTags ? <label className="ai-operation__editor"><span>标签</span><input type="text" value={extractMarkdownTags(action.content).join(', ')} onChange={(event) => updateDraft(actionId, { content: replaceMarkdownTags(action.content, event.target.value) })} aria-label="编辑操作标签" placeholder="多个标签用逗号分隔" /></label> : null}</div> : null}
              {!removed && operation.diff && !dirty ? <pre className="ai-operation__diff">{operation.diff}</pre> : null}{!removed && dirty && (editableTarget || editableTags) ? <small className="ai-operation__stale">内容已修改，点击“更新预览”查看新 diff</small> : null}
            </div>
            <div className="ai-operation__actions">
              {!removed && !operation.previewFailed ? <button type="button" className={`btn btn--sm ai-operation__accept ${accepted ? 'is-active' : ''}`} onClick={() => toggleAccepted(actionId)} disabled={disabled || refreshing} title={accepted ? '取消单项接受' : '接受此项操作'} aria-label={accepted ? '取消单项接受' : '接受此项操作'}><Check size={12} />{accepted ? '已接受' : '接受'}</button> : null}
              <button type="button" className="icon-btn ai-operation__remove" onClick={() => removed ? restoreDraft(operation) : removeDraft(actionId)} disabled={disabled || refreshing} title={removed ? '恢复此操作' : '取消此操作'} aria-label={removed ? '恢复此操作' : '取消此操作'}>{removed ? <Plus size={14} /> : <X size={14} />}</button>
            </div>
          </div>;
        })}
      </div>
      {qualityWarnings.length ? <div className={`ai-operation-preview__quality ${qualityBlocked ? 'is-blocked' : ''}`} role={qualityBlocked ? 'alert' : undefined}><strong>{qualityBlocked ? '计划存在冲突，暂不能执行' : '计划检查提示'}</strong><ul>{qualityWarnings.map((warning, index) => <li key={`${warning.code}-${warning.path ?? ''}-${index}`}>{warning.message}</li>)}</ul>{qualityBlocked ? <small>请取消冲突动作或修改目标路径，然后更新预览。</small> : null}</div> : null}
      {notice ? <div className="ai-operation-preview__notice" role="alert">{notice}</div> : null}
      {requiresAdditionalConfirmation && executionActions.length ? <label className="ai-operation-preview__elevated-confirm"><input type="checkbox" checked={additionalConfirmed} onChange={(event) => setAdditionalConfirmed(event.target.checked)} disabled={disabled || refreshing || dirty} /><span>我确认{additionalConfirmationLabel}，本次确认只授权已接受的操作</span></label> : null}
      <footer><button type="button" onClick={onCancel} disabled={disabled || refreshing}>取消</button><button type="button" onClick={refresh} disabled={disabled || refreshing || !dirty}><RefreshCw size={13} className={refreshing ? 'is-spinning' : undefined} aria-hidden="true" />更新预览</button><button type="button" className="is-primary" onClick={() => onConfirm({ additionalConfirmed, actions: executionActions })} disabled={disabled || refreshing || dirty || preview.blocked || qualityBlocked || !executionActions.length || (requiresAdditionalConfirmation && !additionalConfirmed)}>{preview.blocked || qualityBlocked ? '当前操作不可执行' : requiresAdditionalConfirmation && !additionalConfirmed ? '请先确认高风险操作' : acceptedActions.length ? `执行已接受（${acceptedActions.length}）` : '全部接受并执行'}</button></footer>
    </section>
  );
}
