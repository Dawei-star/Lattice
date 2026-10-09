import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, Check, FilePenLine, FolderOpen, ShieldCheck, X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';

const OPERATION_LABELS = {
  create: '创建',
  write: '覆盖',
  update: '修改',
  append: '追加',
  edit: '修改',
  copy: '复制',
  move: '移动',
  rename: '重命名',
  delete: '删除',
  mkdir: '创建目录',
};

/**
 * 文件写操作的唯一 UI 闸门。调用方只拿到确认结果，不能绕过卡片直接提交。
 * 队列保证多个并发请求会逐项展示，而不是静默丢弃。
 */
export function useFileConfirmation() {
  const [pending, setPending] = useState(null);
  const queueRef = useRef([]);
  const resolverRef = useRef(null);

  const pump = useCallback(() => {
    if (resolverRef.current || !queueRef.current.length) return;
    const next = queueRef.current.shift();
    resolverRef.current = next.resolve;
    setPending(next.operation);
  }, []);

  const requestFileConfirmation = useCallback((operation) => new Promise((resolve) => {
    queueRef.current.push({ operation: normalizeOperation(operation), resolve });
    pump();
  }), [pump]);

  const finish = useCallback((result) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolve?.(result);
    window.setTimeout(pump, 0);
  }, [pump]);

  const ConfirmationCard = pending ? (
    <FileOperationConfirmationCard
      operation={pending}
      onConfirm={(result) => finish({ confirmed: true, ...result })}
      onCancel={() => finish({ confirmed: false })}
    />
  ) : null;

  return { requestFileConfirmation, pending, ConfirmationCard };
}

function normalizeOperation(operation = {}) {
  const actions = Array.isArray(operation.actions) && operation.actions.length
    ? operation.actions
    : [operation];
  const vaultDir = String(operation.vaultDir ?? '').replace(/[\\/]+$/, '');
  const withAbsolutePath = (pathValue) => vaultDir && pathValue
    ? `${vaultDir}\\${pathValue.replaceAll('/', '\\')}`
    : undefined;
  return {
    ...operation,
    actions: actions.map((action) => ({
      ...action,
      type: String(action.type ?? 'write').toLowerCase(),
      path: String(action.path ?? action.targetPath ?? '').replaceAll('\\', '/'),
      targetPath: action.targetPath ? String(action.targetPath).replaceAll('\\', '/') : undefined,
      fullPath: action.fullPath ?? withAbsolutePath(String(action.path ?? action.targetPath ?? '').replaceAll('\\', '/')),
      directory: action.directory ?? withAbsolutePath(String(action.path ?? action.targetPath ?? '').replaceAll('\\', '/').split('/').slice(0, -1).join('/')),
    })),
    type: operation.type ?? actions[0]?.type ?? 'write',
    summary: operation.summary ?? `${actions.length} 项文件变更`,
    impact: operation.impact ?? '将按确认内容写入知识库',
    reversible: operation.reversible !== false,
    requiresSecondConfirmation: operation.requiresSecondConfirmation === true
      || actions.some((action) => action.type === 'delete'),
    fullPath: operation.fullPath ?? withAbsolutePath(String(operation.path ?? actions[0]?.path ?? '').replaceAll('\\', '/')),
    directory: operation.directory ?? withAbsolutePath(String(operation.path ?? actions[0]?.path ?? '').replaceAll('\\', '/').split('/').slice(0, -1).join('/')),
  };
}

function FileOperationConfirmationCard({ operation, onConfirm, onCancel }) {
  const [deleteStep, setDeleteStep] = useState(0);
  const deleteRequired = operation.requiresSecondConfirmation;
  const actions = operation.actions ?? [];
  const title = deleteStep === 1 ? '再次确认删除' : deleteRequired ? '确认文件操作' : '确认文件操作';

  return (
    <Modal open title={title} ariaLabel={title} onClose={onCancel} className="file-confirmation-modal">
      <section className="file-confirmation-card" aria-label="文件操作确认">
        <header className="file-confirmation-card__header">
          <div className={`file-confirmation-card__icon ${deleteRequired ? 'is-danger' : ''}`} aria-hidden="true">
            {deleteRequired ? <AlertTriangle size={20} /> : <FilePenLine size={20} />}
          </div>
          <div>
            <span className="file-confirmation-card__eyebrow">FILE OPERATION / CONFIRMATION</span>
            <h2>{deleteStep === 1 ? '删除不可逆，请再次确认' : '执行前确认文件变更'}</h2>
            <p>{deleteStep === 1 ? '确认后将立即执行删除；取消不会产生任何写入。' : '未确认前不会写入、移动、覆盖或删除任何文件。'}</p>
          </div>
        </header>

        <div className="file-confirmation-card__summary">
          <div><span>操作类型</span><strong>{actions.map((action) => OPERATION_LABELS[action.type] ?? action.type).join('、')}</strong></div>
          <div><span>影响范围</span><strong>{operation.impact}</strong></div>
          <div><span>可撤销性</span><strong>{operation.reversible ? '已生成快照，可撤销' : '不可撤销'}</strong></div>
        </div>

        <div className="file-confirmation-card__files">
          <div className="file-confirmation-card__files-head"><FolderOpen size={14} aria-hidden="true" /><strong>全部变更项（{actions.length}）</strong></div>
          {actions.map((action, index) => (
            <div className="file-confirmation-card__file" key={`${action.type}-${action.path}-${index}`}>
              <div className="file-confirmation-card__file-topline">
                <span className={`file-confirmation-card__operation is-${action.type}`}>{OPERATION_LABELS[action.type] ?? action.type}</span>
                <code>{action.path || '未指定路径'}</code>
              </div>
              {action.targetPath ? <div className="file-confirmation-card__target">目标：<code>{action.targetPath}</code></div> : null}
              <div className="file-confirmation-card__paths">
                <span>完整路径：{action.fullPath ?? operation.fullPath ?? '由 Vault 配置解析'}</span>
                <span>所在目录：{action.directory ?? operation.directory ?? '由 Vault 配置解析'}</span>
              </div>
              {action.contentSummary || operation.contentSummary ? <p className="file-confirmation-card__diff">变更摘要：{action.contentSummary ?? operation.contentSummary}</p> : null}
            </div>
          ))}
        </div>

        <footer className="file-confirmation-card__actions">
          <button type="button" className="btn" onClick={onCancel}><X size={15} aria-hidden="true" />取消</button>
          {deleteStep === 0 && deleteRequired ? (
            <button type="button" className="btn btn--danger" onClick={() => setDeleteStep(1)}><AlertTriangle size={15} aria-hidden="true" />继续删除</button>
          ) : (
            <button type="button" className={`btn ${deleteRequired ? 'btn--danger' : 'btn--primary'}`} onClick={() => onConfirm({ secondConfirmed: deleteRequired })}>
              {deleteRequired ? <AlertTriangle size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
              {deleteRequired ? '确认删除' : '确认执行'}
            </button>
          )}
        </footer>
        <div className="file-confirmation-card__notice"><ShieldCheck size={14} aria-hidden="true" />取消或关闭卡片都不会提交文件操作。</div>
      </section>
    </Modal>
  );
}
