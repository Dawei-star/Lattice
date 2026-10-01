import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLatestRelease, parseLatestRelease, RELEASES_API_URL, RELEASES_PAGE_URL } from './download-release.mjs';

const release = (overrides = {}) => ({
  tag_name: 'v0.1.2',
  name: 'v0.1.2',
  html_url: 'https://github.com/Dawei-star/Lattice/releases/tag/v0.1.2',
  assets: [
    { name: 'Lattice-0.1.2-portable.exe', browser_download_url: 'https://github.com/Dawei-star/Lattice/releases/download/v0.1.2/Lattice-0.1.2-portable.exe' },
    { name: 'Lattice-0.1.2-setup.exe', browser_download_url: 'https://github.com/Dawei-star/Lattice/releases/download/v0.1.2/Lattice-0.1.2-setup.exe' },
  ],
  ...overrides,
});

test('parses the latest release and selects both Windows assets', () => {
  const latest = parseLatestRelease(release());

  assert.equal(latest.version, '0.1.2');
  assert.equal(latest.installer.name, 'Lattice-0.1.2-setup.exe');
  assert.equal(latest.portable.name, 'Lattice-0.1.2-portable.exe');
});

test('falls back to the latest release page when an asset is unavailable', () => {
  const latest = parseLatestRelease(release({ assets: [] }));

  assert.equal(latest.installer, null);
  assert.equal(latest.portable, null);
  assert.equal(latest.htmlUrl, 'https://github.com/Dawei-star/Lattice/releases/tag/v0.1.2');
});

test('fetches the stable GitHub release metadata without a version hardcode', async () => {
  let request;
  const latest = await fetchLatestRelease({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => release() };
    },
  });

  assert.equal(request.url, RELEASES_API_URL);
  assert.equal(request.options.cache, 'no-store');
  assert.equal(latest.version, '0.1.2');
  assert.equal(RELEASES_PAGE_URL, 'https://github.com/Dawei-star/Lattice/releases/latest');
});
