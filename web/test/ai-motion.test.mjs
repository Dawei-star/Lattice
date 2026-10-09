import assert from 'node:assert/strict';
import fs from 'node:fs';

const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../src/components/AIAssistantPanel.jsx', import.meta.url), 'utf8');

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
assert.match(panel, /className="ai-message__typing" role="status" aria-label="AI 正在处理请求"/);
assert.match(panel, /aria-current=\{status === 'running' \? 'step' : undefined\}/);
assert.doesNotMatch(panel, /className=\{status === 'running' \? 'is-spinning' : undefined\}/);
assert.match(panel, /TASK COMPLETE/);
assert.match(panel, /className="ai-progress__toggle"/);
assert.match(panel, /message\.meta\?\.taskMode === true && progress\.length/);
assert.match(panel, /const taskMode = settings\.autoApprove === true/);
assert.match(panel, /activeTaskMode \? <ProgressChecklist steps=\{progressSteps\} live \/> : null/);
assert.match(styles, /\.ai-progress\.is-complete \.ai-progress__list/);
assert.match(styles, /\.ai-progress__item\.is-completed \.ai-progress__copy strong \{ color: var\(--text-secondary\); text-decoration: none; \}/);

console.log('AI motion tests passed');
