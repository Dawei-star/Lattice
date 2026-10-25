import { useState } from 'react';
import { FilePlus2, FilePenLine, FileSymlink, FileX2, Trash2 } from 'lucide-react';

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
}

const TYPE_META: Record<string, { label: string; Icon: typeof FilePlus2 }> = {
  create: { label: '新建', Icon: FilePlus2 },
  write: { label: '修改', Icon: FilePenLine },
  update: { label: '修改', Icon: FilePenLine },
  delete: { label: '删除', Icon: FileX2 },
  move: { label: '移动', Icon: FileSymlink },
  copy: { label: '复制', Icon: FilePlus2 },
};

/**
 * FileChangesCard（U2，用户 2026-10-24 反馈点名）：任务模式写操作升级为
 * 文件变更卡片——图标/路径/±行数/审查（展开 diff）/打开/撤销。
 * ±行数由面板在构建预览时按内核 diff 统计（countDiffLines）。
 */
export default function AiFileChangesCard({ changes, onOpenPath, onUndo, undoBusy = false, undoDone = false }: AiFileChangesCardProps) {
  const [expandedId, setExpandedId] = useState('');
  const failed = changes.filter((change) => change.status === 'failed' || change.error).length;
  if (!changes.length) return null;

  return (
    <div className={`ai-file-changes ${failed ? 'has-failures' : ''}`} role="group" aria-label="文件变更">
      <div className="ai-file-changes__header">
        <strong>文件变更 · {changes.length} 项</strong>
        {failed ? <span className="ai-file-changes__failed">{failed} 项失败</span> : null}
      </div>
      <ul className="ai-file-changes__list">
        {changes.map((change, index) => {
          const meta = TYPE_META[change.type] ?? TYPE_META.update;
          const { Icon } = meta;
          const key = change.id ?? `${change.type}-${change.path}-${index}`;
          const expanded = expandedId === key;
          return (
            <li key={key} className={`ai-file-changes__item is-${change.type} ${change.status === 'failed' || change.error ? 'has-failures' : ''}`}>
              <button
                type="button"
                className="ai-file-changes__row"
                onClick={() => setExpandedId(expanded ? '' : key)}
                title={expanded ? '收起差异' : '审查差异'}
              >
                <Icon size={14} aria-hidden="true" />
                <span className="ai-file-changes__type">{meta.label}</span>
                <span className="ai-file-changes__path">{change.path}{change.targetPath && change.targetPath !== change.path ? ` → ${change.targetPath}` : ''}</span>
                {Number.isFinite(change.additions) && change.additions ? <span className="ai-file-changes__additions">+{change.additions}</span> : null}
                {Number.isFinite(change.deletions) && change.deletions ? <span className="ai-file-changes__deletions">-{change.deletions}</span> : null}
                {change.error ? <span className="ai-file-changes__error">{change.error}</span> : null}
              </button>
              {expanded && change.diff ? <pre className="ai-file-changes__diff">{change.diff.slice(0, 2000)}</pre> : null}
            </li>
          );
        })}
      </ul>
      <div className="ai-file-changes__actions">
        {[...new Set(changes.map((change) => change.targetPath || change.path).filter(Boolean))].slice(0, 6).map((path) => (
          <button key={path} type="button" className="btn btn--sm" onClick={() => onOpenPath?.(path)} title={`打开 ${path}`}>打开 {path.split('/').pop()}</button>
        ))}
        {onUndo ? (
          <button type="button" className="btn btn--sm ai-file-changes__undo" onClick={onUndo} disabled={undoBusy || undoDone} title="用文件内核的快照撤销这批操作">
            <Trash2 size={12} aria-hidden="true" />{undoDone ? '已撤销' : undoBusy ? '撤销中…' : '撤销'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
