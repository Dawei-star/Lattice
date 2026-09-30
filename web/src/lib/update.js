/**
 * 更新检查：经由后端 /api/update/check 代理请求 GitHub Releases。
 * 不在渲染进程直连 GitHub —— 桌面端页面的 CSP（connect-src 'self'）
 * 会拦截跨域请求，直连只会得到 Failed to fetch。
 */
import { http } from '../api/client.js';

/**
 * @param {{ currentVersion?: string, httpImpl?: typeof http }} [options] httpImpl 注入便于测试
 * @returns {Promise<{ version: string, tagName: string, name: string, htmlUrl: string, publishedAt: string|null, installer: {name: string, url: string}|null, portable: {name: string, url: string}|null, downloadUrl: string, isUpdateAvailable: boolean }>}
 */
export async function checkGithubReleases({ currentVersion, httpImpl = http } = {}) {
  try {
    return await httpImpl.get('/update/check', {
      query: { current: currentVersion },
      // 手动触发的检查无需三次退避重试，失败尽快给出反馈
      retries: 1,
      timeout: 20_000,
    });
  } catch (error) {
    if (error?.name === 'ApiError') {
      if (error.isOffline || error.isTimeout || error.status === 0) {
        throw new Error('无法连接本地服务，请确认后端已启动');
      }
      if (error.status >= 500) throw new Error('GitHub 暂时无法访问，请稍后重试');
    }
    throw error;
  }
}
