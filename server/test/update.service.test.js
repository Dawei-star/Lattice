import assert from 'node:assert/strict';
import test from 'node:test';
import { checkUpdate, compareVersions, latestRelease, normalizeVersion } from '../src/modules/update/update.service.js';

const release = (overrides = {}) => ({
  tag_name: 'init',
  name: 'v0.1.1',
  html_url: 'https://github.com/Dawei-star/Lattice/releases/tag/init',
  published_at: '2026-09-29T00:00:00Z',
  draft: false,
  assets: [
    { name: 'Lattice-0.1.1-portable.exe', browser_download_url: 'https://github.com/Dawei-star/Lattice/releases/download/init/Lattice-0.1.1-portable.exe' },
    { name: 'Lattice-0.1.1-setup.exe', browser_download_url: 'https://github.com/Dawei-star/Lattice/releases/download/init/Lattice-0.1.1-setup.exe' },
  ],
  ...overrides,
});

const jsonResponse = (body) => ({ ok: true, status: 200, async json() { return body; } });

test('compares release versions and accepts a release name when tag is not semantic', () => {
  assert.equal(compareVersions('v0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1', '0.1.0'), 0);
  assert.equal(normalizeVersion('not-a-version'), null);
});

test('latestRelease selects the newest non-draft release and setup asset', async () => {
  let request;
  const latest = await latestRelease({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse([
        release({ name: 'v0.2.0', tag_name: 'v0.2.0', assets: [{ name: 'Lattice-0.2.0-setup.exe', browser_download_url: 'https://github.com/Dawei-star/Lattice/releases/download/v0.2.0/Lattice-0.2.0-setup.exe' }] }),
        release({ name: 'v9.0.0', tag_name: 'v9.0.0', draft: true }),
        release({ name: 'v0.1.0', tag_name: 'v0.1.0' }),
      ]);
    },
  });

  assert.match(request.url, /api\.github\.com\/repos\/Dawei-star\/Lattice\/releases/);
  assert.equal(request.options.headers['User-Agent'], 'Lattice-Update-Check');
  assert.equal(latest.version, '0.2.0');
  assert.equal(latest.installer.name, 'Lattice-0.2.0-setup.exe');
  assert.equal(latest.downloadUrl, latest.installer.url);
});

test('latestRelease falls back to the release page when no Windows installer exists', async () => {
  const latest = await latestRelease({ fetchImpl: async () => jsonResponse([release({ assets: [] })]) });
  assert.equal(latest.installer, null);
  assert.equal(latest.downloadUrl, latest.htmlUrl);
});

test('latestRelease rejects a failed GitHub response', async () => {
  await assert.rejects(
    latestRelease({ fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /403/,
  );
});

test('latestRelease rejects when GitHub is unreachable', async () => {
  await assert.rejects(
    latestRelease({ fetchImpl: async () => { throw new Error('connect ETIMEDOUT'); } }),
    /无法连接 GitHub/,
  );
});

test('checkUpdate reports whether an update is available', async () => {
  const available = await checkUpdate('0.1.1', { fetchImpl: async () => jsonResponse([release({ name: 'v0.2.0', tag_name: 'v0.2.0' })]) });
  assert.equal(available.isUpdateAvailable, true);

  const current = await checkUpdate('0.2.0', { fetchImpl: async () => jsonResponse([release({ name: 'v0.2.0', tag_name: 'v0.2.0' })]) });
  assert.equal(current.isUpdateAvailable, false);

  const unparseable = await checkUpdate('', { fetchImpl: async () => jsonResponse([release({ name: 'v0.2.0', tag_name: 'v0.2.0' })]) });
  assert.equal(unparseable.isUpdateAvailable, true);
});
