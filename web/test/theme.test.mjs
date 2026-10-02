import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';
import { clearImportedTheme, importThemeFile, validateThemeContrast } from '../src/lib/theme.js';

installDom();

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

const jsonFile = {
  name: 'sample-theme.json',
  size: 80,
  text: async () => JSON.stringify({
    name: 'Sample JSON theme',
    colors: { bg: '#f3f7f4', text: '#18352a', accent: '#0f766e', 'accent-contrast': '#ffffff' },
  }),
};
const importedJson = await importThemeFile(jsonFile);
assert.equal(importedJson.name, 'Sample JSON theme');
assert.equal(importedJson.tokens.bg, '#f3f7f4');
assert.equal(document.documentElement.style.getPropertyValue('--accent'), '#0f766e');

const cssFile = {
  name: 'sample-theme.css',
  size: 70,
  text: async () => ':root { --bg: #f3f7f4; --text: #18352a; --accent: #0f766e; --accent-contrast: #ffffff; }',
};
const importedCss = await importThemeFile(cssFile);
assert.equal(importedCss.name, 'CSS theme');
assert.equal(importedCss.tokens.text, '#18352a');
assert.equal(document.documentElement.style.getPropertyValue('--text'), '#18352a');
clearImportedTheme();

console.log('theme contrast tests passed');
