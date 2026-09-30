/**
 * 更新检查服务：由服务端代理请求 GitHub Releases。
 * 不在渲染进程直连 GitHub，既绕开页面的 CSP（connect-src 'self'），
 * 也让检查结果不依赖浏览器环境的网络策略。
 */
import { UpdateCheckError } from '../../lib/errors.js';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Dawei-star/Lattice/releases?per_page=20';
const GITHUB_HOST = 'github.com';
const REQUEST_TIMEOUT_MS = 10_000;

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

function parseGithubRelease(release) {
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

/**
 * 拉取并解析 GitHub Releases，返回最新非 draft 版本。
 * @param {{ fetchImpl?: typeof fetch }} [options] 注入 fetch 便于测试
 */
export async function latestRelease({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new UpdateCheckError('当前服务端环境不支持在线检查更新');

  let response;
  try {
    response = await fetchImpl(GITHUB_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Lattice-Update-Check' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new UpdateCheckError('无法连接 GitHub，请稍后重试', { cause });
  }
  if (!response.ok) throw new UpdateCheckError(`GitHub 返回了 ${response.status} 状态`);

  let releases;
  try {
    releases = await response.json();
  } catch (cause) {
    throw new UpdateCheckError('GitHub 返回了无法解析的数据', { cause });
  }

  const latest = (Array.isArray(releases) ? releases : [])
    .filter((release) => !release?.draft)
    .map(parseGithubRelease)
    .filter(Boolean)
    .sort((left, right) => compareVersions(right.version, left.version))[0];

  if (!latest) throw new UpdateCheckError('GitHub Releases 中没有可用的版本');
  return latest;
}

/**
 * 检查更新入口：给定当前版本，返回最新版本及是否有更新。
 * @param {string} currentVersion 前端上报的当前版本号
 * @param {{ fetchImpl?: typeof fetch }} [options] 注入 fetch 便于测试
 */
export async function checkUpdate(currentVersion, { fetchImpl } = {}) {
  const latest = await latestRelease({ fetchImpl });
  return {
    ...latest,
    isUpdateAvailable: compareVersions(latest.version, currentVersion) > 0,
  };
}
