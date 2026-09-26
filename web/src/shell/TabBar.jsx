export default function TabBar({ tabs, activeTabId, noteTitles, onSelect, onClose, onNew }) {
  return (
    <div className="tabbar" role="tablist" aria-label="已打开笔记">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const title = tab.noteId ? (noteTitles.get(tab.noteId) ?? '加载中…') : '新标签页';
        return (
          <div
            key={tab.id}
            className={`tabbar__tab ${active ? 'is-active' : ''}`.trim()}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={title}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(tab.id);
              }
            }}
          >
            <span className="tabbar__title">{title}</span>
            <button
              type="button"
              className="tabbar__close"
              aria-label={`关闭「${title}」`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" className="tabbar__new" onClick={onNew} aria-label="新标签页（Ctrl / Cmd + T）" title="新标签页（Ctrl / Cmd + T）">
        ＋
      </button>
    </div>
  );
}
