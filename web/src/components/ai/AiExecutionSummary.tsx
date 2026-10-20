export interface AiExecutionSummaryResult {
  completed?: number;
  failed?: number;
  results?: Array<{ id?: string; type?: string; path?: string | null; targetPath?: string | null; status?: string }>;
}

export interface AiExecutionSummaryProps {
  result: AiExecutionSummaryResult;
  undoable?: boolean;
  undoBusy?: boolean;
  onUndo?: () => void;
  onOpenPath?: (path: string) => void;
}

export default function AiExecutionSummary({ result, undoable = false, undoBusy = false, onUndo, onOpenPath }: AiExecutionSummaryProps) {
  const paths = [...new Set((result.results ?? [])
    .flatMap((item) => [item.path, item.targetPath])
    .filter((path): path is string => Boolean(path && path.trim())))];
  return (
    <div className={`ai-execution-summary ${result.failed ? 'has-failures' : ''}`}>
      <span>{result.failed ? '!' : '✓'}</span>
      <strong>{result.failed ? `${result.completed} 项完成，${result.failed} 项失败` : `已完成 ${result.completed} 项操作`}</strong>
      {onOpenPath && paths.length ? <div className="ai-execution-summary__paths">{paths.map((path) => <button type="button" key={path} onClick={() => onOpenPath(path)} title={`打开 ${path}`}>打开 {path}</button>)}</div> : null}
      {undoable ? <button type="button" className="ai-execution-summary__undo" onClick={onUndo} disabled={undoBusy} title="用文件内核的快照把这些操作恢复到执行前">{undoBusy ? '撤销中…' : '撤销本次操作'}</button> : null}
    </div>
  );
}
