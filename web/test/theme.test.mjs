import assert from 'node:assert/strict';
import { validateThemeContrast } from '../src/lib/theme.js';

const readableTheme = {
  bg: '#eaf3ff',
  'bg-panel': 'rgba(248, 252, 255, 0.42)',
  'bg-subtle': 'rgba(225, 237, 252, 0.48)',
  text: '#18345c',
  'text-secondary': '#4b6682',
  'text-tertiary': '#6c83a0',
  accent: '#397fe9',
  'accent-hover': '#2369d2',
  'accent-contrast': '#0f172a',
};

assert.deepEqual(validateThemeContrast(readableTheme), []);

const lowContrastText = validateThemeContrast({
  bg: '#ffffff',
  text: '#d9e2ef',
});
assert.ok(lowContrastText.some((issue) => issue.foreground === 'text' && issue.background === 'bg'));

const lowContrastPanel = validateThemeContrast({
  bg: '#ffffff',
  'bg-panel': 'rgba(0, 0, 0, 0.5)',
  text: '#ffffff',
});
assert.ok(lowContrastPanel.some((issue) => issue.foreground === 'text' && issue.background === 'bg-panel'));

assert.deepEqual(validateThemeContrast({
  bg: 'hsl(0 0% 100%)',
  text: 'hsl(0 0% 0%)',
}), []);

const lowContrastButton = validateThemeContrast({
  bg: '#ffffff',
  accent: '#ffffff',
  'accent-contrast': '#ffffff',
});
assert.ok(lowContrastButton.some((issue) => issue.foreground === 'accent-contrast' && issue.background === 'accent'));

console.log('theme contrast tests passed');
