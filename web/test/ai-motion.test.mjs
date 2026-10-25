import assert from 'node:assert/strict';
import fs from 'node:fs';

// U2 重写后的锚点：进度清单已被 UnifiedTimeline（AiAgentTimeline）取代，
// 推理块已被 ReasoningBlock（markdown 化 + 时长徽标）取代。
const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../src/components/AIAssistantPanel.tsx', import.meta.url), 'utf8');
const timeline = fs.readFileSync(new URL('../src/components/ai/AiAgentTimeline.tsx', import.meta.url), 'utf8');
const reasoning = fs.readFileSync(new URL('../src/components/ai/blocks/ReasoningBlock.tsx', import.meta.url), 'utf8');
const message = fs.readFileSync(new URL('../src/components/ai/AiMessageList.tsx', import.meta.url), 'utf8');

// 功能性动效在 reduced-motion 下保持（装饰动效可静，功能动效不可失）
assert.match(
  styles,
  /\.ai-progress__item\.is-running > svg,\s*\n\s*\.ai-timeline__item\.is-running > svg \{\s*animation: ai-progress-spin 900ms linear infinite !important;/,
  'reduced-motion override must keep the functional timeline spinner alive',
);
assert.match(
  styles,
  /\.ai-message__typing span \{\s*animation: ai-response-dot 1\.05s ease-in-out infinite !important;/,
  'reduced-motion override must keep the functional typing indicator alive',
);
assert.match(styles, /\.ai-message__typing span:nth-child\(2\) \{ animation-delay: 120ms !important; \}/);
assert.match(styles, /\.ai-message__typing span:nth-child\(3\) \{ animation-delay: 240ms !important; \}/);
assert.match(message, /className="ai-message__typing" role="status" aria-label="AI 正在处理请求"/);

// UnifiedTimeline：运行中条目带 aria-current，完成后徽标收口
assert.match(timeline, /aria-current=\{entry\.status === 'running' \? 'step' : undefined\}/);
assert.match(timeline, /TASK COMPLETE/);
assert.match(timeline, /className="ai-timeline__toggle"/);
assert.match(styles, /\.ai-timeline__item\.is-running > svg \{ color: var\(--accent\); animation: ai-progress-spin 900ms linear infinite;/);
assert.match(styles, /\.ai-timeline__footer/);
assert.match(message, /<AiAgentTimeline\s*\n?\s*entries=\{timelineEntries\}/);

// ReasoningBlock：markdown 化思考流 + 时长徽标 + 完成折叠沿用
assert.match(reasoning, /className=\{`ai-message__reasoning \$\{streaming \? 'is-streaming' : ''\}`\}/);
assert.match(reasoning, /open=\{streaming \? open : false\}/);
assert.match(reasoning, /onToggle=\{streaming \? \(event\) => onToggle\?\.\(event\.currentTarget\.open\) : undefined\}/);
assert.match(reasoning, /<span className="ai-message__reasoning-label">分析摘要<\/span>/);
assert.match(reasoning, /ai-message__reasoning-duration/);
assert.match(styles, /\.ai-message__reasoning\.is-streaming \.ai-message__reasoning-body/);

// 面板：任务模式与 durable run 接线
assert.match(panel, /const taskMode = requestMode === 'task'/);
assert.match(panel, /taskMode=\{activeTaskMode\}/);
assert.match(panel, /onRuntimeEvent: \(event\) =>/);
assert.match(panel, /runMetricsRef\.current = event\.metrics/);
assert.match(panel, /mergeRuntimeToolProgress/);
assert.match(message, /首字 \$\{formatMetricDuration\(metrics\.timeToFirstTokenMs\)/);
assert.match(panel, /scanDurableRuns\(tauriAiRunClient(?:, storageNamespace)?\)/);
assert.match(panel, /rememberDurableRun\(/);
assert.match(panel, /resumeRun: true/);
assert.match(panel, /getActiveAiProviderRuntime\(settings\)/);
assert.match(panel, /skipUserMessage: true/);
assert.match(panel, /retryRunIdRef\.current = isTauri\(\) \? runId : null/);
assert.match(panel, /onOpenPath=\{openPathInVault\}/);
assert.match(styles, /\.ai-execution-summary__paths/);

console.log('AI motion tests passed');
