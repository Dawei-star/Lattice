import { useEffect, useState } from 'react';
import { formatDateTime, formatNumber, formatRelativeTime } from '../lib/format.js';
import { aiApi } from '../api/ai.js';
import { loadAiSettings } from '../settings/aiSettings.js';

/**
 * 右侧面板：元信息 / 出链 / 反向链接 / AI 智能建议。
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

  if (note.external) {
    return (
      <aside className="linkpanel linkpanel--empty" aria-label="外部文件信息">
        <p className="empty-hint">外部 Markdown 文件不会加入当前知识库索引，也不参与双链和标签分析。</p>
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
          tabIndex={tab === 'links' ? 0 : -1}
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
          tabIndex={tab === 'info' ? 0 : -1}
          className={tab === 'info' ? 'is-active' : ''}
          onClick={() => setTab('info')}
        >
          信息
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'smart'}
          tabIndex={tab === 'smart' ? 0 : -1}
          className={tab === 'smart' ? 'is-active' : ''}
          onClick={() => setTab('smart')}
        >
          ✦ 智能
        </button>
      </div>

      {tab === 'links' ? (
        <div className="linkpanel__body">
          <Group
            title="出链"
            hint={outgoing.length ? `${resolvedCount}/${outgoing.length} 已解析` : null}
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
      ) : tab === 'smart' ? (
        <SmartSuggestions note={note} onOpenNote={onOpenNote} />
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

/**
 * AI 智能建议：双链推荐 + 受控标签推荐。
 * 接受 = 派发写入事件，由编辑器把 [[链接]] / #标签 追加进当前草稿（走正常保存），
 * 不绕过用户的编辑缓冲，避免覆盖未保存内容。
 */
function SmartSuggestions({ note, onOpenNote }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState({});

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    setAccepted({});
    (async () => {
      try {
        const accessToken = loadAiSettings().accessToken?.trim();
        const options = accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};
        const response = await aiApi.suggestions(note.id, 6, options);
        if (!cancelled) setData(response?.data ?? response ?? { links: [], tags: [] });
      } catch (requestError) {
        if (!cancelled) setError(requestError?.message ?? '建议加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [note.id]);

  const accept = (type, value) => {
    window.dispatchEvent(new CustomEvent('lattice:ai-suggestion-accept', {
      detail: { noteId: note.id, type, value },
    }));
    setAccepted((current) => ({ ...current, [`${type}:${value}`]: true }));
  };

  const links = data?.links ?? [];
  const tags = data?.tags ?? [];

  return (
    <div className="linkpanel__body">
      <div className="linkpanel__group">
        <div className="linkpanel__group-head">
          <span>建议建立的双链</span>
          {data?.semanticAvailable ? <span className="linkpanel__group-hint">语义排序</span> : <span className="linkpanel__group-hint">关键词匹配</span>}
        </div>
        {error ? <p className="empty-hint">{error}</p>
          : !data ? <p className="empty-hint">分析中…</p>
          : links.length === 0 ? <p className="empty-hint">暂无合适的链接建议——写更多内容或配置语义索引后会更准。</p>
          : (
            <div className="linkpanel__list">
              {links.map((item) => (
                <div className="linkpanel__suggestion" key={item.id}>
                  <button
                    type="button"
                    className="linkpanel__item"
                    onClick={() => onOpenNote(item.id)}
                    title={`打开「${item.title}」`}
                  >
                    <span className="linkpanel__item-title">{item.title}</span>
                    <span className="linkpanel__item-tag">{item.reason}{typeof item.score === 'number' && item.reason === '语义相关' ? ` ${(item.score * 100).toFixed(0)}%` : ''}</span>
                  </button>
                  <button
                    type="button"
                    className={`linkpanel__accept ${accepted[`link:${item.title}`] ? 'is-done' : ''}`}
                    disabled={accepted[`link:${item.title}`]}
                    onClick={() => accept('link', item.title)}
                    title={`在笔记末尾追加 [[${item.title}]]`}
                  >
                    {accepted[`link:${item.title}`] ? '✓' : '＋链接'}
                  </button>
                </div>
              ))}
            </div>
          )}
      </div>

      <div className="linkpanel__group">
        <div className="linkpanel__group-head">
          <span>建议补充的标签</span>
          {tags.length ? <span className="linkpanel__group-hint">受控词表</span> : null}
        </div>
        {!error && data && tags.length === 0 ? (
          <p className="empty-hint">暂无标签建议——库里已有的标签词表里没有匹配这篇笔记的词。</p>
        ) : null}
        {tags.length ? (
          <div className="linkpanel__suggestion-tags">
            {tags.map((item) => (
              <button
                type="button"
                key={item.name}
                className={`linkpanel__accept linkpanel__accept--tag ${accepted[`tag:${item.name}`] ? 'is-done' : ''}`}
                disabled={accepted[`tag:${item.name}`]}
                onClick={() => accept('tag', item.name)}
                title={`在笔记末尾追加 #${item.name}（已匹配${item.matchedIn}，全库 ${item.usage} 篇在用）`}
              >
                {accepted[`tag:${item.name}`] ? `✓ #${item.name}` : `＋ #${item.name}`}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <p className="linkpanel__tip">接受建议会把 <code>[[链接]]</code> / <code>#标签</code> 追加到正文末尾并自动保存。</p>
    </div>
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
