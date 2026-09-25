import { useState } from 'react';
import { formatDateTime, formatNumber, formatRelativeTime } from '../lib/format.js';

/**
 * 右侧面板：元信息 / 出链 / 反向链接。
 * 反向链接是双链笔记的核心价值——写作时就能看到「谁引用了我」。
 */
export default function LinkPanel({
  note,
  folderLookup,
  onOpenNote,
  onCreateWikiLink,
}) {
  const [tab, setTab] = useState('links');

  if (!note) {
    return (
      <aside className="linkpanel linkpanel--empty" aria-label="笔记关系">
        <p className="empty-hint">打开一篇笔记后，这里会显示它的出链与反向链接。</p>
      </aside>
    );
  }

  const outgoing = note.outgoing ?? [];
  const backlinks = note.backlinks ?? [];
  const resolvedCount = outgoing.filter((link) => link.resolved).length;

  return (
    <aside className="linkpanel" aria-label="笔记关系">
      <div className="linkpanel__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'links'}
          className={tab === 'links' ? 'is-active' : ''}
          onClick={() => setTab('links')}
        >
          链接
          <span className="linkpanel__count">{outgoing.length + backlinks.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'info'}
          className={tab === 'info' ? 'is-active' : ''}
          onClick={() => setTab('info')}
        >
          信息
        </button>
      </div>

      {tab === 'links' ? (
        <div className="linkpanel__body">
          <Group
            title="出链"
            hint={`${resolvedCount}/${outgoing.length} 已解析`}
            items={outgoing}
            emptyText="还没有引用其他笔记。用 [[标题]] 建立第一条链接。"
            renderItem={(link) => (
              <button
                type="button"
                className={`linkpanel__item ${link.resolved ? '' : 'is-dangling'}`}
                onClick={() =>
                  link.resolved ? onOpenNote(link.targetNoteId) : onCreateWikiLink(link.targetTitle)
                }
                title={link.resolved ? `打开「${link.resolvedTitle}」` : '点击创建这篇缺失的笔记'}
              >
                <span className="linkpanel__item-title">{link.resolvedTitle ?? link.targetTitle}</span>
                <span className="linkpanel__item-tag">{link.resolved ? '已解析' : '悬空'}</span>
              </button>
            )}
          />

          <Group
            title="反向链接"
            hint={`${backlinks.length} 条`}
            items={backlinks}
            emptyText="还没有其他笔记引用它。"
            renderItem={(link) => (
              <button
                type="button"
                className="linkpanel__item"
                onClick={() => onOpenNote(link.sourceNoteId)}
                title="打开引用它的笔记"
              >
                <span className="linkpanel__item-title">{link.sourceTitle}</span>
                <span className="linkpanel__item-tag">{formatRelativeTime(link.sourceUpdatedAt)}</span>
              </button>
            )}
          />

          {note.tags?.length ? (
            <div className="linkpanel__group">
              <div className="linkpanel__group-head">
                <span>标签</span>
              </div>
              <div className="linkpanel__tags">
                {note.tags.map((tag) => (
                  <span key={tag.id} className="tag tag--mini">#{tag.name}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="linkpanel__body">
          <dl className="meta">
            <Meta label="标题" value={note.title} />
            <Meta label="所属目录" value={note.folderId ? folderLookup.get(note.folderId) ?? '—' : '未分类'} />
            <Meta label="字数" value={`${formatNumber(note.wordCount)} 字`} />
            <Meta label="出链" value={`${outgoing.length} 条`} />
            <Meta label="反链" value={`${backlinks.length} 条`} />
            <Meta label="创建时间" value={formatDateTime(note.createdAt)} />
            <Meta label="更新时间" value={formatDateTime(note.updatedAt)} />
            <Meta label="笔记 ID" value={<code className="meta__code">{note.id.slice(0, 8)}</code>} />
          </dl>

          <p className="linkpanel__tip">
            想在这篇笔记里引用别的笔记？回到正文写 <code>[[笔记标题]]</code> 即可，
            保存后链接与标签都会自动重建。
          </p>
        </div>
      )}
    </aside>
  );
}

function Group({ title, hint, items, emptyText, renderItem }) {
  return (
    <div className="linkpanel__group">
      <div className="linkpanel__group-head">
        <span>{title}</span>
        {hint ? <span className="linkpanel__group-hint">{hint}</span> : null}
      </div>
      {items.length === 0 ? (
        <p className="empty-hint">{emptyText}</p>
      ) : (
        <div className="linkpanel__list">{items.map((item, index) => (
          <div key={`${title}-${index}`}>{renderItem(item)}</div>
        ))}</div>
      )}
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <div className="meta__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
