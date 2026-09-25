import { useState } from 'react';
import FolderTree from './FolderTree.jsx';
import TagCloud from './TagCloud.jsx';
import { CloseIcon, PlusIcon } from './icons.jsx';
import { formatNumber } from '../lib/format.js';

/**
 * 左侧栏：目录树 / 标签 / 统计 / 导出。
 *
 * 宽屏（≥1024px）下是常驻的一栏；窄屏下退化为左侧抽屉，
 * 由顶栏的菜单按钮唤起，避免小屏直接丢掉目录与标签的入口。
 */
export default function Sidebar({
  folders,
  tags,
  overview,
  filter,
  onSelectFolder,
  onSelectTag,
  onClearFilter,
  onCreateFolder,
  onDeleteFolder,
  onRenameFolder,
  onExportSite,
  exporting,
  exportResult,
  loading,
  open = false,
  onClose,
}) {
  const [collapsed, setCollapsed] = useState({ folders: false, tags: false, stats: false });
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  const toggle = (key) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  const submitNewFolder = async (event) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    const created = await onCreateFolder(name, null);
    if (created) {
      setNewFolderName('');
      setCreating(false);
    }
  };

  return (
    <>
      <div
        className={`nav-backdrop ${open ? 'is-open' : ''}`}
        onClick={onClose}
        role="presentation"
      />

      <aside className={`sidebar ${open ? 'is-open' : ''}`} aria-label="知识库导航">
        <div className="sidebar__head">
          <span className="sidebar__head-title">知识库</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭导航">
            <CloseIcon />
          </button>
        </div>

        <Section
          title="目录"
          count={folders.length}
          collapsed={collapsed.folders}
          onToggle={() => toggle('folders')}
          action={
            <button
              type="button"
              className="icon-btn"
              title="新建目录"
              aria-label="新建目录"
              onClick={() => setCreating((value) => !value)}
            >
              <PlusIcon />
            </button>
          }
        >
          {creating ? (
            <form className="inline-form" onSubmit={submitNewFolder}>
              <input
                autoFocus
                value={newFolderName}
                maxLength={120}
                placeholder="目录名称，回车确认"
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setCreating(false);
                    setNewFolderName('');
                  }
                }}
              />
            </form>
          ) : null}

          <button
            type="button"
            className={`nav-item ${filter.kind === 'all' ? 'is-active' : ''}`}
            onClick={onClearFilter}
          >
            <span className="nav-item__label">全部笔记</span>
            <span className="nav-item__badge">{formatNumber(overview?.noteCount ?? 0)}</span>
          </button>

          <FolderTree
            nodes={folders}
            filter={filter}
            loading={loading}
            onSelectFolder={onSelectFolder}
            onDeleteFolder={onDeleteFolder}
            onRenameFolder={onRenameFolder}
          />
        </Section>

        <Section
          title="标签"
          count={tags.length}
          collapsed={collapsed.tags}
          onToggle={() => toggle('tags')}
        >
          <TagCloud tags={tags} filter={filter} onSelectTag={onSelectTag} />
        </Section>

        <Section title="统计" collapsed={collapsed.stats} onToggle={() => toggle('stats')}>
          <dl className="stats">
            <Stat label="笔记" value={overview?.noteCount} />
            <Stat label="目录" value={overview?.folderCount} />
            <Stat label="标签" value={overview?.tagCount} />
            <Stat label="链接" value={overview?.linkCount} />
            <Stat label="总字数" value={overview?.totalWords} />
          </dl>

          {overview?.danglingLinks?.length ? (
            <div className="dangling">
              <div className="dangling__title">待补全的引用（{overview.danglingLinks.length}）</div>
              <ul className="dangling__list">
                {overview.danglingLinks.slice(0, 6).map((item) => (
                  <li key={item.targetTitle}>
                    <span className="dangling__name">{item.targetTitle}</span>
                    <span className="dangling__count">×{item.referenceCount}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="export-block">
            <button
              type="button"
              className="btn btn--sm export-block__btn"
              onClick={onExportSite}
              disabled={exporting || (overview?.noteCount ?? 0) === 0}
            >
              {exporting ? '导出中…' : '导出静态站点'}
            </button>
            {exportResult ? (
              <div className="export-block__done">
                <a className="export-block__link" href={exportResult.entry} target="_blank" rel="noopener noreferrer">
                  查看预览（{exportResult.noteCount} 篇）→
                </a>
                <div className="export-block__dir" title={exportResult.dir}>
                  已存到 {exportResult.run}/
                </div>
              </div>
            ) : (
              <div className="export-block__hint">生成自包含 HTML 站点，可离线打开或发布</div>
            )}
          </div>
        </Section>
      </aside>
    </>
  );
}

function Section({ title, count, collapsed, onToggle, action, children }) {
  return (
    <section className="panel">
      <div className="panel__head">
        <button type="button" className="panel__toggle" onClick={onToggle} aria-expanded={!collapsed}>
          <span className={`caret ${collapsed ? 'is-collapsed' : ''}`} aria-hidden="true">▾</span>
          <span className="panel__title">{title}</span>
          {count === undefined ? null : <span className="panel__count">{count}</span>}
        </button>
        {action}
      </div>
      {collapsed ? null : <div className="panel__body">{children}</div>}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stats__item">
      <dt>{label}</dt>
      <dd>{formatNumber(value ?? 0)}</dd>
    </div>
  );
}