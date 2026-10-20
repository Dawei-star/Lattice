import assert from 'node:assert/strict';
import fs from 'node:fs';

const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../src/components/AIAssistantPanel.tsx', import.meta.url), 'utf8');
const progress = fs.readFileSync(new URL('../src/components/ai/AiProgressChecklist.tsx', import.meta.url), 'utf8');
const message = fs.readFileSync(new URL('../src/components/ai/AiMessageList.tsx', import.meta.url), 'utf8');

assert.match(
  styles,
  /\.ai-progress__item\.is-running > svg \{\s*animation: ai-progress-spin 900ms linear infinite !important;/,
  'reduced-motion override must keep the functional progress spinner alive',
);
assert.match(
  styles,
  /\.ai-message__typing span \{\s*animation: ai-response-dot 1\.05s ease-in-out infinite !important;/,
  'reduced-motion override must keep the functional typing indicator alive',
);
assert.match(styles, /\.ai-message__typing span:nth-child\(2\) \{ animation-delay: 120ms !important; \}/);
assert.match(styles, /\.ai-message__typing span:nth-child\(3\) \{ animation-delay: 240ms !important; \}/);
assert.match(message, /className="ai-message__typing" role="status" aria-label="AI 正在处理请求"/);
assert.match(progress, /aria-current=\{status === 'running' \? 'step' : undefined\}/);
assert.doesNotMatch(progress, /className=\{status === 'running' \? 'is-spinning' : undefined\}/);
assert.match(progress, /TASK COMPLETE/);
assert.match(progress, /className="ai-progress__toggle"/);
assert.match(message, /message\.meta\?\.taskMode === true && progress\.length/);
assert.match(panel, /const taskMode = requestMode === 'task'/);
assert.match(panel, /taskMode=\{activeTaskMode\}/);
assert.match(panel, /onRuntimeEvent: \(event\) =>/);
assert.match(panel, /runMetricsRef\.current = event\.metrics/);
assert.match(panel, /mergeRuntimeToolProgress/);
assert.match(message, /首字 \$\{formatMetricDuration\(metrics\.timeToFirstTokenMs\)/);
assert.match(styles, /\.ai-progress\.is-complete \.ai-progress__list/);
assert.match(styles, /\.ai-progress__item\.is-completed \.ai-progress__copy strong \{ color: var\(--text-secondary\); text-decoration: none; \}/);
assert.match(message, /className="ai-message__reasoning is-streaming"/);
assert.match(message, /open=\{reasoningOpen\}/);
assert.match(message, /onToggle=\{\(event\) => onReasoningToggle\?\.\(event\.currentTarget\.open\)\}/);
assert.match(message, /<span className="ai-message__reasoning-label">分析摘要<\/span>/);
assert.match(message, /<summary>查看分析摘要<\/summary>/);
assert.match(styles, /\.ai-message__reasoning\.is-streaming \.ai-message__reasoning-body/);
assert.match(panel, /scanDurableRuns\(tauriAiRunClient(?:, storageNamespace)?\)/);
assert.match(panel, /rememberDurableRun\(/);
assert.match(panel, /resumeRun: true/);
assert.match(panel, /getActiveAiProviderRuntime\(settings\)/);
assert.match(panel, /skipUserMessage: true/);
assert.match(panel, /retryRunIdRef\.current = isTauri\(\) \? runId : null/);
assert.match(panel, /onOpenPath=\{\(path\) =>/);
assert.match(styles, /\.ai-execution-summary__paths/);

console.log('AI motion tests passed');
