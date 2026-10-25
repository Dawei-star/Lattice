import { memo, useEffect, useState } from 'react';
import type { AiBlock } from '../../../ai/parse-blocks.ts';
import { renderMathBlock, type RichRenderResult } from '../../../ai/rich-render.ts';
import CodeBlock from './CodeBlock.tsx';

/**
 * 数学块（U3）：懒加载 KaTeX（trust:false，禁用信任扩展）渲染 display 公式，
 * 加载失败回退为代码块。只有消息中出现 $$ 块才会触发加载。
 */
const MathBlock = memo(function MathBlock({ block }: { block: AiBlock }) {
  const [rendered, setRendered] = useState<RichRenderResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRendered(null);
    setFailed(false);
    renderMathBlock(block.source).then((result) => {
      if (cancelled) return;
      if (result.kind === 'fallback') setFailed(true);
      else setRendered(result);
    });
    return () => {
      cancelled = true;
    };
  }, [block.source]);

  if (failed) return <CodeBlock block={block} />;
  if (!rendered) {
    return <div className="ai-math is-loading" role="status" aria-label="正在渲染公式">公式渲染中…</div>;
  }
  return <div className="ai-math" dangerouslySetInnerHTML={{ __html: rendered.output }} />;
});

export default MathBlock;
