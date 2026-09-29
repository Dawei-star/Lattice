const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Dawei-star/Lattice/releases?per_page=20';
const GITHUB_HOST = 'github.com';

export function normalizeVersion(value) {
  const match = String(value ?? '').match(/(?:^|[^\d])v?(\d+(?:\.\d+){0,2})(?:[-+][0-9A-Za-z.-]+)?/i);
  if (!match) return null;
  const parts = match[1].split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

export function compareVersions(left, right) {
  const leftParts = normalizeVersion(left) ?? [0, 0, 0];
  const rightParts = normalizeVersion(right) ?? [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function releaseVersion(release) {
  return normalizeVersion(release?.tag_name) ?? normalizeVersion(release?.name);
}

function safeGithubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === GITHUB_HOST ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseGithubRelease(release) {
  const versionParts = releaseVersion(release);
  const htmlUrl = safeGithubUrl(release?.html_url);
  if (!versionParts || !htmlUrl) return null;

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const windowsAssets = assets
    .map((asset) => ({
      name: String(asset?.name ?? ''),
      url: safeGithubUrl(asset?.browser_download_url),
    }))
    .filter((asset) => asset.url && /\.exe$/i.test(asset.name));
  const setup = windowsAssets.find((asset) => /setup/i.test(asset.name)) ?? windowsAssets[0] ?? null;
  const portable = windowsAssets.find((asset) => /portable/i.test(asset.name)) ?? null;

  return {
    version: versionParts.join('.'),
    tagName: String(release.tag_name ?? ''),
    name: String(release.name || `v${versionParts.join('.')}`),
    htmlUrl,
    publishedAt: release.published_at ?? null,
    installer: setup,
    portable,
    downloadUrl: setup?.url ?? htmlUrl,
  };
}

export async function checkGithubReleases({ currentVersion, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持在线检查更新');

  const response = await fetchImpl(GITHUB_RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`GitHub 返回了 ${response.status} 状态`);

  const releases = await response.json();
  const latest = releases
    .filter((release) => !release?.draft)
    .map(parseGithubRelease)
    .filter(Boolean)
    .sort((left, right) => compareVersions(right.version, left.version))[0];

  if (!latest) throw new Error('GitHub Releases 中没有可用的版本');
  return {
    ...latest,
    isUpdateAvailable: compareVersions(latest.version, currentVersion) > 0,
  };
}

export { GITHUB_RELEASES_URL };
