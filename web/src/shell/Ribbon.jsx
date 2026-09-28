export default function Ribbon({ view, onViewChange, onOpenSwitcher, onToggleAi, onCreateNote, onCreateCanvas, onRefresh, refreshing, onTogglePanel, onToggleTheme, onOpenSettings, theme }) {
  return (
    <nav className="ribbon" aria-label="主导航">
      <div className="ribbon__group">
        <button type="button" className="ribbon__button" onClick={onCreateNote} aria-label="新建笔记">
          <span aria-hidden="true">✎</span>
        </button>
        <button type="button" className={`ribbon__button ${view === 'notes' ? 'is-active' : ''}`} onClick={() => onViewChange('notes')} aria-label="笔记">
          <span aria-hidden="true">▤</span>
        </button>
        <button type="button" className={`ribbon__button ${view === 'graph' ? 'is-active' : ''}`} onClick={() => onViewChange('graph')} aria-label="图谱">
          <span aria-hidden="true">⌘</span>
        </button>
        <button type="button" className={`ribbon__button ${view === 'canvas' ? 'is-active' : ''}`} onClick={() => onViewChange('canvas')} aria-label="画布">
          <span aria-hidden="true">▧</span>
        </button>
        <button type="button" className="ribbon__button" onClick={() => onCreateCanvas?.()} aria-label="新建白板">
          <span aria-hidden="true">▦</span>
        </button>
        <button type="button" className="ribbon__button" onClick={onOpenSwitcher} aria-label="快速切换">
          <span aria-hidden="true">⌕</span>
        </button>
        <button type="button" className="ribbon__button" onClick={onToggleAi} aria-label="AI 文件助手">
          <span aria-hidden="true">✦</span>
        </button>
      </div>
      <div className="ribbon__spacer" />
      <div className="ribbon__group">
        <button type="button" className="ribbon__button" onClick={onRefresh} disabled={refreshing} aria-label="重新加载">
          <span aria-hidden="true" className={refreshing ? 'is-spinning' : ''}>↻</span>
        </button>
        <button type="button" className="ribbon__button" onClick={onTogglePanel} aria-label="切换侧栏">
          <span aria-hidden="true">◧</span>
        </button>
        <button type="button" className="ribbon__button" onClick={onToggleTheme} aria-label={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}>
          <span aria-hidden="true">{theme === 'dark' ? '☼' : '◐'}</span>
        </button>
        <button type="button" className="ribbon__button" onClick={onOpenSettings} aria-label="设置">
          <span aria-hidden="true">⚙</span>
        </button>
      </div>
    </nav>
  );
}
