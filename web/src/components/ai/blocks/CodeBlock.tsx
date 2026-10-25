import { memo } from 'react';
import type { AiBlock } from '../../../ai/parse-blocks.ts';
import { renderMarkdown } from '../../../lib/markdown.ts';

/**
 * 围栏块（code / mermaid / math）：沿用 markdown 渲染管线（高亮 + 工具栏 + sanitize），
 * 输出与整段渲染一致；data-block-kind 供 U3 的 Mermaid/KaTeX 渲染器接管。
 * memo：source 引用不变即跳过重渲染。
 */
const CodeBlock = memo(function CodeBlock({ block }: { block: AiBlock }) {
  return (
    <div
      className="ai-message__code-block"
      data-block-kind={block.kind}
      data-block-language={block.language ?? undefined}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(block.source, { codeToolbar: true }) }}
    />
  );
});

export default CodeBlock;
