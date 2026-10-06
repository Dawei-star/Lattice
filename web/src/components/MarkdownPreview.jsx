import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../lib/markdown.js';
import Lightbox from './Lightbox.jsx';

const MAX_EMBED_DEPTH = 2;

/**
 * Markdown 预览。
 *
 * 负责四件事：
 *  1. 用 renderMarkdown 把正文渲染为已消毒的 HTML
 *  2. 接管双链 / 嵌入的点击：已解析的跳转，悬空的触发创建
 *  3. 异步把 ![[嵌入]] 卡片的内容填进去（带深度上限与循环检测）
 *  4. 点击图片打开灯箱大图查看
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
  const [lightbox, setLightbox] = useState(null);

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
        resolveAsset,
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
  }, [html, resolveEmbed, resolveTitle, resolveAsset, depth]);

  const handleClick = (event) => {
    // 点击图片打开灯箱（嵌入卡片里的图片同样生效）
    const image = event.target.closest('img');
    if (image?.getAttribute('src')) {
      event.preventDefault();
      setLightbox({ src: image.getAttribute('src'), alt: image.getAttribute('alt') ?? '' });
      return;
    }

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
    <>
      <div
        ref={containerRef}
        className={`preview markdown-body ${className}`}
        onClick={handleClick}
        // 内容已由 renderMarkdown 做过白名单消毒
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {/* position:fixed，挂在预览容器外不影响排版 */}
      {lightbox ? (
        <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}
    </>
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
    // resolveAsset 必须随 context 传入：嵌入内容里的相对路径图片依赖它改写成
    // 可加载的 URL，缺了就是一排裂图（顶层预览正常、嵌入内容异常的断链）
    body.innerHTML = renderMarkdown(content, { resolveTitle: context.resolveTitle, resolveAsset: context.resolveAsset });
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
