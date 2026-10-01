export const RELEASES_API_URL = 'https://api.github.com/repos/Dawei-star/Lattice/releases/latest';
export const RELEASES_PAGE_URL = 'https://github.com/Dawei-star/Lattice/releases/latest';

function normalizeVersion(value) {
  const match = String(value ?? '').match(/(?:^|[^\d])v?(\d+(?:\.\d+){0,2})(?:[-+][0-9A-Za-z.-]+)?/i);
  if (!match) return null;

  const parts = match[1].split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3).join('.');
}

function safeGithubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseLatestRelease(release) {
  const version = normalizeVersion(release?.tag_name) ?? normalizeVersion(release?.name);
  if (!version) return null;

  const htmlUrl = safeGithubUrl(release?.html_url) ?? RELEASES_PAGE_URL;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const windowsAssets = assets
    .map((asset) => ({
      name: String(asset?.name ?? ''),
      url: safeGithubUrl(asset?.browser_download_url),
    }))
    .filter((asset) => asset.url && /\.exe$/i.test(asset.name));

  return {
    version,
    name: String(release?.name || `v${version}`),
    htmlUrl,
    installer: windowsAssets.find((asset) => /setup/i.test(asset.name)) ?? windowsAssets[0] ?? null,
    portable: windowsAssets.find((asset) => /portable/i.test(asset.name)) ?? null,
  };
}

export async function fetchLatestRelease({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持在线检查版本');

  let response;
  try {
    response = await fetchImpl(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
  } catch (cause) {
    throw new Error('无法连接 GitHub', { cause });
  }

  if (!response.ok) throw new Error(`GitHub 返回了 ${response.status} 状态`);

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error('GitHub 返回了无法解析的数据', { cause });
  }

  const release = parseLatestRelease(payload);
  if (!release) throw new Error('GitHub Releases 中没有可用版本');
  return release;
}

function setLink(link, url, label) {
  link.href = url;
  const labelElement = link.querySelector('[data-download-label]');
  if (labelElement) labelElement.textContent = label;
}

export function applyLatestRelease(release, documentRef = globalThis.document) {
  const setupUrl = release.installer?.url ?? release.htmlUrl;
  const portableUrl = release.portable?.url ?? release.htmlUrl;

  documentRef.querySelectorAll('[data-download="setup"]').forEach((link) => {
    const label = link.dataset.downloadRole === 'hero'
      ? '下载 Windows 安装版'
      : release.installer ? `直接下载 v${release.version}` : '前往最新发布页下载';
    setLink(link, setupUrl, label);
  });

  documentRef.querySelectorAll('[data-download="portable"]').forEach((link) => {
    setLink(link, portableUrl, release.portable ? `下载 v${release.version} 绿色版` : '前往最新发布页下载');
  });

  const status = documentRef.querySelector('[data-release-status]');
  if (status) status.textContent = `Windows 安装版 · v${release.version}`;
}

export function applyReleaseFallback(documentRef = globalThis.document) {
  documentRef.querySelectorAll('[data-download="setup"], [data-download="portable"]').forEach((link) => {
    setLink(link, RELEASES_PAGE_URL, '前往最新发布页下载');
  });

  const status = documentRef.querySelector('[data-release-status]');
  if (status) status.textContent = '请从 GitHub Releases 获取最新版本';
}
