import { useEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '../lib/markdown.js';

const MAX_EMBED_DEPTH = 2;

/**
 * Markdown 预览。
 *
 * 负责三件事：
 *  1. 用 renderMarkdown 把正文渲染为已消毒的 HTML
 *  2. 接管双链 / 嵌入的点击：已解析的跳转，悬空的触发创建
 *  3. 异步把 ![[嵌入]] 卡片的内容填进去（带深度上限与循环检测）
 */
export default function MarkdownPreview({
  content,
  resolveTitle,
  resolveAsset,
  resolveEmbed,
  onOpenWikiLink,
  onCreateWikiLink,
  className = '',
  depth = 0,
}) {
  const containerRef = useRef(null);

  const html = useMemo(
    () => renderMarkdown(content, { resolveTitle, resolveAsset }),
    [content, resolveAsset, resolveTitle],
  );

  // 每次 HTML 变化后，把仍处于 loading 状态的嵌入卡片填上内容
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !resolveEmbed || depth >= MAX_EMBED_DEPTH) return undefined;

    let cancelled = false;

    const run = async () => {
      await hydrateEmbeds(root, {
        resolveEmbed,
        resolveTitle,
        depth,
        /** 当前这条嵌入链上已经展开过的标题，用于识别真正的循环引用 */
        trail: new Set(),
        isCancelled: () => cancelled,
      });
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [html, resolveEmbed, resolveTitle, depth]);

  const handleClick = (event) => {
    const trigger = event.target.closest('[data-wiki-title]');
    if (!trigger) return;

    event.preventDefault();
    const title = trigger.getAttribute('data-wiki-title');
    if (!title) return;

    if (trigger.classList.contains('is-dangling')) onCreateWikiLink?.(title);
    else onOpenWikiLink?.(title);
  };

  if (!content?.trim()) {
    return (
      <div className={`preview preview--empty ${className}`}>
        <p>这篇笔记还是空的，左侧写点什么吧。</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`preview markdown-body ${className}`}
      onClick={handleClick}
      // 内容已由 renderMarkdown 做过白名单消毒
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

async function hydrateEmbeds(root, context) {
  const pending = [...root.querySelectorAll('[data-embed-state="loading"]')];

  for (const node of pending) {
    if (context.isCancelled()) return;

    const title = node.getAttribute('data-embed-title') ?? '';
    const key = title.trim().toLowerCase();
    const body = node.querySelector('.note-embed__body');

    if (!body) continue;

    if (context.trail.has(key)) {
      markState(node, 'error', '检测到循环嵌入，已停止展开');
      continue;
    }

    let content = null;
    try {
      content = await context.resolveEmbed(title);
    } catch {
      content = null;
    }

    if (context.isCancelled()) return;

    if (content === null || content === undefined) {
      markState(node, 'missing', '目标笔记不存在，点击标题即可创建');
      continue;
    }

    if (!content.trim()) {
      markState(node, 'empty', '目标笔记内容为空');
      continue;
    }

    context.trail.add(key);
    body.innerHTML = renderMarkdown(content, { resolveTitle: context.resolveTitle });
    node.dataset.embedState = 'ready';

    // 递归展开嵌入里的嵌入
    if (context.depth + 1 < MAX_EMBED_DEPTH) {
      await hydrateEmbeds(body, { ...context, depth: context.depth + 1 });
    }

    context.trail.delete(key);
  }
}

function markState(node, state, message) {
  node.dataset.embedState = state;
  const body = node.querySelector('.note-embed__body');
  if (body) body.innerHTML = `<span class="note-embed__hint">${message}</span>`;
}
