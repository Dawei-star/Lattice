export default function StatusBar({ overview, connectionDown, note }) {
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
