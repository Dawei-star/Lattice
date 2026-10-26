import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGithubReleases, desktopPlatformLabel, installerLabel } from '../src/lib/update.ts';

const release = {
  version: '0.2.0',
  tagName: 'v0.2.0',
  name: 'v0.2.0',
  htmlUrl: 'https://github.com/Dawei-star/Lattice/releases/tag/v0.2.0',
  publishedAt: '2026-09-29T00:00:00Z',
  installer: { name: 'Lattice-0.2.0-setup.exe', url: 'https://github.com/Dawei-star/Lattice/releases/download/v0.2.0/Lattice-0.2.0-setup.exe' },
  portable: null,
  downloadUrl: 'https://github.com/Dawei-star/Lattice/releases/download/v0.2.0/Lattice-0.2.0-setup.exe',
  isUpdateAvailable: true,
};

function fakeHttp(overrides = {}) {
  const calls = [];
  return {
    calls,
    get: async (path, options) => {
      calls.push({ path, options });
      if (overrides.reject) throw overrides.reject;
      return overrides.result ?? release;
    },
  };
}

test('queries the local update proxy with the current version', async () => {
  const httpImpl = fakeHttp();
  const result = await checkGithubReleases({ currentVersion: '0.1.1', httpImpl });

  assert.equal(httpImpl.calls.length, 1);
  assert.equal(httpImpl.calls[0].path, '/update/check');
  assert.deepEqual(httpImpl.calls[0].options.query, { current: '0.1.1' });
  assert.equal(result.version, '0.2.0');
  assert.equal(result.isUpdateAvailable, true);
});

test('maps offline and backend failures to friendly messages', async () => {
  const offline = Object.assign(new Error('offline'), { name: 'ApiError', isOffline: true, status: 0 });
  await assert.rejects(
    checkGithubReleases({ httpImpl: fakeHttp({ reject: offline }) }),
    /无法连接本地服务/,
  );

  const upstream = Object.assign(new Error('upstream'), { name: 'ApiError', status: 502 });
  await assert.rejects(
    checkGithubReleases({ httpImpl: fakeHttp({ reject: upstream }) }),
    /GitHub 暂时无法访问/,
  );

  // 后端 4xx 文案本身面向用户，原样透出
  const badRequest = Object.assign(new Error('版本号格式有误'), { name: 'ApiError', status: 400 });
  await assert.rejects(
    checkGithubReleases({ httpImpl: fakeHttp({ reject: badRequest }) }),
    /版本号格式有误/,
  );
});

test('installer label follows the asset format on each platform', () => {
  assert.equal(installerLabel('Lattice_0.2.0_amd64.deb'), '下载 .deb 安装包');
  assert.equal(installerLabel('Lattice_0.2.0_amd64.AppImage'), '下载 AppImage');
  assert.equal(installerLabel('Lattice-0.2.0-1.x86_64.rpm'), '下载 RPM 包');
  assert.equal(installerLabel('Lattice_0.2.0_x64-setup.exe'), '下载 Windows 安装包');
  assert.equal(installerLabel('Lattice_0.2.0_aarch64.dmg'), '下载 macOS 安装包');
  assert.equal(installerLabel(null), '下载安装包');
});

test('desktop platform label reads the user agent', () => {
  assert.equal(desktopPlatformLabel('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15'), 'Linux Desktop');
  assert.equal(desktopPlatformLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows Desktop');
  assert.equal(desktopPlatformLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macOS Desktop');
});
