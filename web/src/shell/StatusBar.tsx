/** 底部状态栏属性。 */
export interface StatusBarProps {
  /** 知识库概览统计（metaApi.overview） */
  overview?: { noteCount?: number; linkCount?: number } | null;
  connectionDown?: boolean;
  /** 当前打开笔记（仅用标题） */
  note?: { title: string } | null;
}

export default function StatusBar({ overview, connectionDown, note }: StatusBarProps) {
  return (
    <footer className="statusbar" aria-label="应用状态">
      <span>{overview?.noteCount ?? 0} 篇笔记</span>
      <span>{overview?.linkCount ?? 0} 条链接</span>
      <span className="statusbar__spacer" />
      <span>{note ? `当前：${note.title}` : '未打开笔记'}</span>
      <span className={`statusbar__connection ${connectionDown ? 'is-offline' : ''}`}>
        <i aria-hidden="true" /> {connectionDown ? '连接中断' : '已连接'}
      </span>
    </footer>
  );
}
