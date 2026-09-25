import { useEffect, useRef } from 'react';
import {
  ArrowLeftIcon,
  CloseIcon,
  MenuIcon,
  PanelIcon,
  RefreshIcon,
  SearchIcon,
} from './icons.jsx';

/**
 * 顶栏（命令栏）：当前视图上下文 + 全局检索 + 高频操作。
 *
 * 视图切换与主题切换已移交左侧导航栏，顶栏只保留「左右手不改姿势」能按到的动作。
 * 窄屏下会依次退化为：抽屉入口 → 返回列表 → 折叠检索框。
 */
export default function TopBar({
  query,
  onQueryChange,
  view,
  viewLabel,
  onCreateNote,
  onOpenSwitcher,
  onRefresh,
  refreshing,
  panelOpen,
  onTogglePanel,
  onToggleNav,
  onBack,
  backVisible,
}) {
  const inputRef = useRef(null);

  // 顶栏检索框只负责输入；真正的检索在 useVault 里防抖执行
  useEffect(() => {
    if (view !== 'notes') inputRef.current?.blur();
  }, [view]);

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn topbar__nav-toggle"
        onClick={onToggleNav}
        title="知识库导航"
        aria-label="打开知识库导航"
      >
        <MenuIcon className="icon" />
      </button>

      {backVisible ? (
        <button type="button" className="icon-btn topbar__back" onClick={onBack} aria-label="返回笔记列表">
          <ArrowLeftIcon className="icon" />
        </button>
      ) : null}

      <div className="topbar__context">
        <span className="topbar__eyebrow">格物 Lattice</span>
        <h1 className="topbar__view">{viewLabel}</h1>
      </div>

      <div className="topbar__search">
        <SearchIcon className="icon" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="检索标题与正文…"
          aria-label="全文检索"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query ? (
          <button type="button" className="topbar__clear" onClick={() => onQueryChange('')} aria-label="清空检索">
            <CloseIcon />
          </button>
        ) : (
          <span className="topbar__search-hint">
            <span className="kbd">Ctrl</span>
            <span className="kbd">K</span>
          </span>
        )}
      </div>

      <div className="topbar__actions">
        <button
          type="button"
          className="btn topbar__switcher"
          onClick={onOpenSwitcher}
          title="快速切换笔记（Ctrl / Cmd + K）"
        >
          快速切换
        </button>

        <button
          type="button"
          className="btn btn--primary topbar__new"
          onClick={onCreateNote}
          title="新建笔记（Ctrl / Cmd + N）"
        >
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
          <RefreshIcon className={`icon ${refreshing ? 'is-spinning' : ''}`} />
        </button>

        <button
          type="button"
          className={`btn btn--icon topbar__panel ${panelOpen ? 'is-on' : ''}`}
          onClick={onTogglePanel}
          title={panelOpen ? '收起关系面板' : '展开关系面板'}
          aria-pressed={panelOpen}
          aria-label="切换关系面板"
        >
          <PanelIcon className="icon" />
        </button>
      </div>
    </header>
  );
}