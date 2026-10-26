import { useState } from 'react';
import { ArrowUpRight, ChevronDown, FilePlus2, FilePenLine, FileSymlink, FileText, FileX2, Trash2 } from 'lucide-react';

export interface AiFileChange {
  /** 对应操作 id（与预览/执行结果对账） */
  id?: string;
  type: string;
  path: string;
  targetPath?: string | null;
  /** ±行数（面板构建预览时按 diff 统计） */
  additions?: number;
  deletions?: number;
  /** 预览 diff 摘要（点击行展开审查） */
  diff?: string;
  status?: string;
  error?: string;
}

export interface AiFileChangesCardProps {
  changes: AiFileChange[];
  onOpenPath?: (path: string) => void;
  onUndo?: () => void;
  undoBusy?: boolean;
  undoDone?: boolean;
  /** 写入尚未落盘（预览待确认） */
  pending?: boolean;
}

const TYPE_META: Record<string, { label: string; Icon: typeof FilePlus2 }> = {
  create: { label: '新建', Icon: FilePlus2 },
  write: { label: '修改', Icon: FilePenLine },
  update: { label: '修改', Icon: FilePenLine },
  delete: { label: '删除', Icon: FileX2 },
  move: { label: '移动', Icon: FileSymlink },
  copy: { label: '复制', Icon: FilePlus2 },
};

const VISIBLE_LIMIT = 3;

function fileNameOf(path: string) {
  const name = String(path ?? '').split('/').pop() ?? '';
  return name || path;
}

function extensionOf(path: string) {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function statusNote(change: AiFileChange, pending: boolean) {
  if (change.error) return change.error;
  if (change.status === 'failed') return '写入失败';
  if (change.status === 'undone') return '已撤销';
  if (change.status === 'pending' || pending) return '等待确认后写入';
  return '';
}

/**
 * FileChangesCard（U2，用户 2026-10-24 反馈点名）：任务模式写操作升级为
 * 文件变更卡片——文件类型徽标 / 文件名 / 路径 / ±行数 / 打开 / 展开 diff。
 * ±行数由面板在构建预览时按内核 diff 统计（countDiffLines）。
 * 2026-10-26：生成的文件必须在回答里可见——待确认写入也显示文件卡。
 */
export default function AiFileChangesCard({
  changes,
  onOpenPath,
  onUndo,
  undoBusy = false,
  undoDone = false,
  pending = false,
}: AiFileChangesCardProps) {
  const [expandedId, setExpandedId] = useState('');
  const [showAll, setShowAll] = useState(false);
  const failed = changes.filter((change) => change.status === 'failed' || change.error).length;
  const waiting = pending || changes.some((change) => change.status === 'pending');
  const allCreated = changes.every((change) => change.type === 'create' || change.type === 'copy');
  const additions = changes.reduce((total, change) => total + (Number(change.additions) || 0), 0);
  const deletions = changes.reduce((total, change) => total + (Number(change.deletions) || 0), 0);
  const title = waiting
    ? `待确认 ${changes.length} 个文件`
    : allCreated
      ? `已生成 ${changes.length} 个文件`
      : `已编辑 ${changes.length} 个文件`;
  const subtitle = failed
    ? `${failed} 项写入失败`
    : waiting
      ? '确认后写入知识库'
      : '已写入知识库';
  if (!changes.length) return null;
  const visibleChanges = showAll ? changes : changes.slice(0, VISIBLE_LIMIT);
  const hiddenCount = changes.length - visibleChanges.length;

  return (
    <section className={`ai-file-changes ${failed ? 'has-failures' : ''} ${waiting ? 'is-pending' : ''}`} role="group" aria-label="生成的文件">
      <header className="ai-file-changes__header">
        <span className="ai-file-changes__badge" aria-hidden="true"><FileText size={15} /></span>
        <div className="ai-file-changes__heading">
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>
        {additions || deletions ? (
          <span className="ai-file-changes__totals" aria-label="新增和删除行数">
            {additions ? <em>+{additions}</em> : null}
            {deletions ? <i>−{deletions}</i> : null}
          </span>
        ) : null}
        {onUndo ? (
          <button type="button" className="ai-file-changes__undo" onClick={onUndo} disabled={undoBusy || undoDone} title="用文件内核的快照撤销这批操作">
            <Trash2 size={12} aria-hidden="true" />{undoDone ? '已撤销' : undoBusy ? '撤销中…' : '撤销'}
          </button>
        ) : null}
      </header>

      <ul className="ai-file-changes__list">
        {visibleChanges.map((change, index) => {
          const meta = TYPE_META[change.type] ?? TYPE_META.update;
          const { Icon } = meta;
          const key = change.id ?? `${change.type}-${change.path}-${index}`;
          const expanded = expandedId === key;
          const openPath = change.targetPath || change.path;
          const note = statusNote(change, waiting);
          const ext = extensionOf(change.path);
          return (
            <li key={key} className={`ai-file-changes__item is-${change.type} ${change.status === 'failed' || change.error ? 'has-failures' : ''}`}>
              <div className="ai-file-changes__row">
                <button
                  type="button"
                  className="ai-file-changes__main"
                  onClick={() => change.diff ? setExpandedId(expanded ? '' : key) : onOpenPath?.(openPath)}
                  title={change.diff ? (expanded ? '收起差异' : '展开差异') : `打开 ${change.path}`}
                >
                  <span className="ai-file-changes__ext" data-ext={ext || 'file'} aria-hidden="true">
                    {(ext || 'FILE').slice(0, 4).toUpperCase()}
                  </span>
                  <span className="ai-file-changes__copy">
                    <strong>{fileNameOf(change.path)}</strong>
                    <small>
                      <Icon size={10} aria-hidden="true" />
                      {meta.label} · {change.path}
                      {change.targetPath && change.targetPath !== change.path ? ` → ${change.targetPath}` : ''}
                      {note ? <em>{note}</em> : null}
                    </small>
                  </span>
                  <span className="ai-file-changes__delta">
                    {Number.isFinite(change.additions) && change.additions ? <em>+{change.additions}</em> : null}
                    {Number.isFinite(change.deletions) && change.deletions ? <i>−{change.deletions}</i> : null}
                  </span>
                </button>
                {onOpenPath ? (
                  <button type="button" className="ai-file-changes__open" onClick={() => onOpenPath(openPath)} title={`打开 ${openPath}`} aria-label={`打开 ${openPath}`}>
                    <ArrowUpRight size={13} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {expanded && change.diff ? <pre className="ai-file-changes__diff">{change.diff.slice(0, 2000)}</pre> : null}
            </li>
          );
        })}
      </ul>

      {hiddenCount > 0 || showAll ? (
        <button type="button" className="ai-file-changes__more" onClick={() => setShowAll((value) => !value)} aria-expanded={showAll}>
          {showAll ? '收起文件列表' : `再显示 ${hiddenCount} 个文件`}
          <ChevronDown size={13} className={showAll ? 'is-open' : undefined} aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}
