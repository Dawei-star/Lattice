import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
const serviceWorker = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/');
assert.match(index, /rel="manifest"/);
assert.match(index, /name="theme-color"/);
assert.match(serviceWorker, /url\.pathname\.startsWith\('\/api\/'\)/);
assert.match(serviceWorker, /text\/event-stream/);
assert.match(serviceWorker, /SKIP_WAITING/);

console.log('pwa tests passed');
