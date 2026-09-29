import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGithubReleases, compareVersions, parseGithubRelease } from '../src/lib/update.js';

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

test('compares release versions and accepts a release name when tag is not semantic', () => {
  assert.equal(compareVersions('v0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1', '0.1.0'), 0);
  assert.equal(parseGithubRelease(release()).version, '0.1.1');
});

test('selects the newest non-draft release and setup asset', async () => {
  let request;
  const result = await checkGithubReleases({
    currentVersion: '0.1.1',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return [
            release({ name: 'v0.2.0', tag_name: 'v0.2.0', assets: [{ name: 'Lattice-0.2.0-setup.exe', browser_download_url: 'https://github.com/Dawei-star/Lattice/releases/download/v0.2.0/Lattice-0.2.0-setup.exe' }] }),
            release({ name: 'v9.0.0', tag_name: 'v9.0.0', draft: true }),
            release({ name: 'v0.1.0', tag_name: 'v0.1.0' }),
          ];
        },
      };
    },
  });

  assert.match(request.url, /api\.github\.com\/repos\/Dawei-star\/Lattice\/releases/);
  assert.equal(request.options.cache, 'no-store');
  assert.equal(result.version, '0.2.0');
  assert.equal(result.isUpdateAvailable, true);
  assert.equal(result.installer.name, 'Lattice-0.2.0-setup.exe');
  assert.equal(result.downloadUrl, result.installer.url);
});

test('falls back to the release page when no Windows installer exists', async () => {
  const result = await checkGithubReleases({
    currentVersion: '0.1.1',
    fetchImpl: async () => ({ ok: true, async json() { return [release({ assets: [] })]; } }),
  });

  assert.equal(result.isUpdateAvailable, false);
  assert.equal(result.downloadUrl, result.htmlUrl);
  assert.equal(result.installer, null);
});

test('rejects a failed GitHub response', async () => {
  await assert.rejects(
    checkGithubReleases({ fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /403/,
  );
});
