import { memo } from 'react';
import { renderMarkdown } from '../../../lib/markdown.ts';

/**
 * Markdown 块（U2 块架构）：source 引用不变时 memo 跳过重渲染。
 * 增量解析（parseBlocksIncremental）复用已稳定块的 source 引用，
 * 流式期间只有尾部块真正走 renderMarkdown，长回复不再整段重注入。
 */
const MarkdownBlock = memo(function MarkdownBlock({ source }: { source: string }) {
  return (
    <div
      className="ai-message__markdown-block"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source, { codeToolbar: true }) }}
    />
  );
});

export default MarkdownBlock;
