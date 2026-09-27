import { useEffect, useRef } from 'react';

/**
 * 顶栏：品牌、全局检索入口、视图切换、新建、主题与手动刷新。
 */
export default function TopBar({
  query,
  onQueryChange,
  view,
  onViewChange,
  onCreateNote,
  onOpenSwitcher,
  onRefresh,
  refreshing,
  theme,
  onToggleTheme,
  panelOpen,
  onTogglePanel,
  onOpenSettings,
}) {
  const inputRef = useRef(null);

  // 顶栏检索框只负责输入；真正的检索在 useVault 里防抖执行
  useEffect(() => {
    if (view !== 'notes') inputRef.current?.blur();
  }, [view]);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__logo" aria-hidden="true">格</span>
        <div className="topbar__titles">
          <strong>格物 Lattice</strong>
          <span>本地优先的双链笔记</span>
        </div>
      </div>

      <div className="topbar__search">
        <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
          <path
            d="M7 1a6 6 0 1 0 3.7 10.7l3.3 3.3 1.4-1.4-3.3-3.3A6 6 0 0 0 7 1Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
            fill="currentColor"
          />
        </svg>
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="全文检索笔记内容与标题…"
          aria-label="全文检索"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query ? (
          <button type="button" className="topbar__clear" onClick={() => onQueryChange('')} aria-label="清空检索">
            ×
          </button>
        ) : null}
      </div>

      <div className="topbar__actions">
        <div className="segmented" role="tablist" aria-label="视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'notes'}
            className={view === 'notes' ? 'is-active' : ''}
            onClick={() => onViewChange('notes')}
          >
            笔记
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'graph'}
            className={view === 'graph' ? 'is-active' : ''}
            onClick={() => onViewChange('graph')}
          >
            图谱
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'canvas'}
            className={view === 'canvas' ? 'is-active' : ''}
            onClick={() => onViewChange('canvas')}
          >
            画布
          </button>
        </div>

        <button type="button" className="btn" onClick={onOpenSwitcher} title="快速切换（Ctrl / Cmd + K）">
          <span className="kbd">Ctrl</span>
          <span className="kbd">K</span>
        </button>

        <button type="button" className="btn btn--primary" onClick={onCreateNote} title="新建笔记（Ctrl / Cmd + N）">
          新建笔记
        </button>

        <button
          type="button"
          className="btn btn--icon"
          onClick={onRefresh}
          disabled={refreshing}
          title="重新加载全部数据"
          aria-label="重新加载"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className={`icon ${refreshing ? 'is-spinning' : ''}`}>
            <path
              d="M8 2a6 6 0 1 0 5.2 3H11a4.5 4.5 0 1 1-1.3-1.7V6h4V2h-1.6v1.1A6 6 0 0 0 8 2Z"
              fill="currentColor"
            />
          </svg>
        </button>

        <button
          type="button"
          className={`btn btn--icon ${panelOpen ? 'is-on' : ''}`}
          onClick={onTogglePanel}
          title={panelOpen ? '收起关系面板' : '展开关系面板'}
          aria-pressed={panelOpen}
          aria-label="切换关系面板"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
            <path d="M2 3h12v1.6H2V3Zm0 4.2h12v1.6H2V7.2Zm0 4.2h12V13H2v-1.6Z" fill="currentColor" />
          </svg>
        </button>

        <button
          type="button"
          className="btn btn--icon"
          onClick={onToggleTheme}
          title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-label="切换主题"
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
      </div>
    </header>
  );
}
