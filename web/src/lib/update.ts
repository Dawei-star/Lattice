/**
 * 更新检查：经由后端 /api/update/check 代理请求 GitHub Releases。
 * 不在渲染进程直连 GitHub —— 桌面端页面的 CSP（connect-src 'self'）
 * 会拦截跨域请求，直连只会得到 Failed to fetch。
 */
import { http } from '../api/client.ts';

/** GitHub Release 检查结果（经后端 /api/update/check 归一化）。 */
export interface GithubReleaseInfo {
  version: string;
  tagName: string;
  name: string;
  htmlUrl: string;
  publishedAt: string | null;
  installer: { name: string; url: string } | null;
  portable: { name: string; url: string } | null;
  downloadUrl: string;
  isUpdateAvailable: boolean;
}

/** 检查选项：httpImpl 注入便于测试。 */
export interface CheckGithubReleasesOptions {
  currentVersion?: string;
  httpImpl?: typeof http;
}

/** 安装包按钮文案：按资产扩展名给出准确格式，避免在 Linux 上仍显示“Windows 安装包”。 */
export function installerLabel(assetName?: string | null): string {
  const lower = (assetName ?? '').toLowerCase();
  if (lower.endsWith('.deb')) return '下载 .deb 安装包';
  if (lower.endsWith('.appimage')) return '下载 AppImage';
  if (lower.endsWith('.rpm')) return '下载 RPM 包';
  if (lower.endsWith('.msi')) return '下载 MSI 安装包';
  if (lower.endsWith('.dmg')) return '下载 macOS 安装包';
  if (lower.endsWith('.exe')) return '下载 Windows 安装包';
  return '下载安装包';
}

/** 当前桌面平台文案（仅用于“关于”页展示）。 */
export function desktopPlatformLabel(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): string {
  if (/macintosh|mac os x/i.test(userAgent)) return 'macOS Desktop';
  if (/linux/i.test(userAgent)) return 'Linux Desktop';
  if (/windows/i.test(userAgent)) return 'Windows Desktop';
  return 'Desktop';
}

export async function checkGithubReleases({ currentVersion, httpImpl = http }: CheckGithubReleasesOptions = {}): Promise<GithubReleaseInfo> {
  try {
    return await httpImpl.get<GithubReleaseInfo>('/update/check', {
      query: { current: currentVersion },
      // 手动触发的检查无需三次退避重试，失败尽快给出反馈
      retries: 1,
      timeout: 20_000,
    });
  } catch (error: any) {
    if (error?.name === 'ApiError') {
      if (error.isOffline || error.isTimeout || error.status === 0) {
        throw new Error('无法连接本地服务，请确认后端已启动');
      }
      if (error.status >= 500) throw new Error('GitHub 暂时无法访问，请稍后重试');
    }
    throw error;
  }
}
