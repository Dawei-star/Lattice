import { AttachIcon, GraphIcon, MoonIcon, NoteIcon, SunIcon } from './icons.jsx';

const VIEWS = [
  { key: 'notes', label: '笔记', Icon: NoteIcon },
  { key: 'graph', label: '图谱', Icon: GraphIcon },
  { key: 'attachments', label: '附件', Icon: AttachIcon },
];

/**
 * 左侧竖向导航（窄屏时自动变成底部标签栏）。
 *
 * 视图切换从这里接管而不是顶栏：顶栏留给「检索 + 操作」，
 * 导航固定在左侧竖轴上，切换视图时视线不需要在屏幕上横向跳跃。
 *
 * 注意：这里保持 .segmented / .segmented--rail 的类名与纯文本标签，
 * 冒烟测试依据 `.segmented button` 的文本定位视图切换入口。
 */
export default function AppRail({ view, onViewChange, theme, onToggleTheme }) {
  const isDark = theme === 'dark';

  return (
    <nav className="app__rail" aria-label="主导航">
      <div className="rail__brand">
        <span className="rail__mark" aria-hidden="true">格</span>
      </div>

      <div className="segmented segmented--rail" role="tablist" aria-label="视图切换">
        {VIEWS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={view === key ? 'is-active' : ''}
            title={label}
            onClick={() => onViewChange(key)}
          >
            <Icon className="icon rail__icon" />
            <span className="rail__label">{label}</span>
          </button>
        ))}
      </div>

      <div className="rail__spacer" />

      <button
        type="button"
        className="rail__btn"
        onClick={onToggleTheme}
        title={isDark ? '切换到浅色主题' : '切换到深色主题'}
        aria-label="切换主题"
      >
        {isDark ? <SunIcon className="icon rail__icon" /> : <MoonIcon className="icon rail__icon" />}
        <span className="rail__label">{isDark ? '浅色' : '深色'}</span>
      </button>
    </nav>
  );
}