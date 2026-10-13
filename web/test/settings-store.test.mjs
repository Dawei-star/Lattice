import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';
import { saveSettings, subscribeSettings } from '../src/settings/settings.js';

installDom();

const seen = [];
const unsubscribe = subscribeSettings((settings) => seen.push(settings));
const saved = saveSettings({ density: 'comfortable' });
assert.deepEqual(seen, [saved]);

const external = { ...saved, density: 'compact' };
window.dispatchEvent(new window.CustomEvent('lattice:settings-change', { detail: external }));
assert.deepEqual(seen, [saved, external]);

unsubscribe();
saveSettings({ density: 'comfortable' });
assert.equal(seen.length, 2);

console.log('settings store tests passed');
