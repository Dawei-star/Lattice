/**
 * 富媒体渲染（U3）：mermaid 图表与 KaTeX 数学块的懒加载渲染器。
 *
 * - 懒加载：`import('mermaid')` / `import('katex')` 由 Vite 切成异步 chunk，
 *   只有消息里真的出现对应块才加载（"检测到 `$`/图表才启用"）；
 * - 安全：mermaid `securityLevel: 'strict'` 且渲染结果剥除 `<script>`；
 *   KaTeX `trust: false`（禁用 \\href/\\includegraphics 等信任扩展）；
 * - 失败回退：加载失败或解析失败一律返回 `fallback`，组件回退为代码块。
 *
 * loader 可注入（setXxxLoaderForTests），测试用假 loader 覆盖成功/失败两条路径。
 */

export interface RichRenderResult {
  kind: 'svg' | 'html' | 'fallback';
  /** kind=svg/html 时为渲染产物；fallback 时为原始源码 */
  output: string;
}

interface MermaidModule {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
}

interface KatexModule {
  renderToString: (source: string, options: Record<string, unknown>) => string;
}

let mermaidLoader: () => Promise<MermaidModule> = async () => (await import('mermaid')).default;
let katexLoader: () => Promise<KatexModule> = async () => {
  const [module, ] = await Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]);
  return module.default ?? (module as unknown as KatexModule);
};

export function setMermaidLoaderForTests(loader: (() => Promise<MermaidModule>) | null) {
  mermaidLoader = loader ?? (() => Promise.reject(new Error('mermaid loader unavailable')));
}
export function setKatexLoaderForTests(loader: (() => Promise<KatexModule>) | null) {
  katexLoader = loader ?? (() => Promise.reject(new Error('katex loader unavailable')));
}

/** 剥掉 code 围栏行，取 mermaid 图源。 */
export function extractFenceBody(source: string): string {
  const lines = String(source ?? '').split('\n');
  if (lines.length && lines[0].trimStart().startsWith('```')) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
  return lines.join('\n');
}

/** 剥掉 `$$` 定界行，取数学源。 */
export function stripMathDelimiters(source: string): string {
  const lines = String(source ?? '').split('\n');
  if (lines[0]?.trim() === '$$') lines.shift();
  if (lines[lines.length - 1]?.trim() === '$$') lines.pop();
  return lines.join('\n').trim();
}

export async function renderMermaidDiagram(source: string, id: string): Promise<RichRenderResult> {
  try {
    const mermaid = await mermaidLoader();
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
    const { svg } = await mermaid.render(`lattice-mmd-${id}`, source);
    // 纵深防御：strict 模式本身不带脚本，仍剥除任何 <script> 残留
    const clean = svg.replace(/<script[\s\S]*?<\/script>/gi, '');
    if (!clean.trim()) return { kind: 'fallback', output: source };
    return { kind: 'svg', output: clean };
  } catch {
    return { kind: 'fallback', output: source };
  }
}

export async function renderMathBlock(source: string): Promise<RichRenderResult> {
  try {
    const katex = await katexLoader();
    const html = katex.renderToString(stripMathDelimiters(source), {
      trust: false,
      throwOnError: false,
      displayMode: true,
      output: 'html',
    });
    if (!html.trim()) return { kind: 'fallback', output: source };
    return { kind: 'html', output: html };
  } catch {
    return { kind: 'fallback', output: source };
  }
}
