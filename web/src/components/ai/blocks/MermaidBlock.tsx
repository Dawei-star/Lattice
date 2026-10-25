import { memo, useEffect, useState } from 'react';
import type { AiBlock } from '../../../ai/parse-blocks.ts';
import { extractFenceBody, renderMermaidDiagram, type RichRenderResult } from '../../../ai/rich-render.ts';
import CodeBlock from './CodeBlock.tsx';

/**
 * Mermaid 块（U3）：懒加载 mermaid（securityLevel:'strict'）渲染 SVG，
 * 加载/解析失败回退为代码块（验收：mermaid 失败回退用例）。
 */
const MermaidBlock = memo(function MermaidBlock({ block }: { block: AiBlock }) {
  const source = extractFenceBody(block.source);
  const [rendered, setRendered] = useState<RichRenderResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRendered(null);
    setFailed(false);
    renderMermaidDiagram(source, String(block.start)).then((result) => {
      if (cancelled) return;
      if (result.kind === 'fallback') setFailed(true);
      else setRendered(result);
    });
    return () => {
      cancelled = true;
    };
  }, [source, block.start]);

  if (failed) return <CodeBlock block={block} />;
  if (!rendered) {
    return <div className="ai-mermaid is-loading" role="status" aria-label="正在渲染图表">图表渲染中…</div>;
  }
  return <div className="ai-mermaid" data-mermaid dangerouslySetInnerHTML={{ __html: rendered.output }} />;
});

export default MermaidBlock;
