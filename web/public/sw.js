/*
 * 格物 Lattice 服务工作者 —— 手写，不引入 Workbox / vite-plugin-pwa，
 * 与项目「图谱布局、Markdown 消毒、静态导出都自己写」的调性保持一致。
 *
 * 缓存策略按资源类型分治（全部只处理同源 GET，写操作与非 GET 一律直连网络）：
 *   - 应用外壳（导航请求）：网络优先，失败回落到缓存的 index.html —— 离线也能打开界面。
 *   - /assets/ 哈希产物：缓存优先 —— 文件名含内容哈希，天然不可变。
 *   - /attachments/：缓存优先 —— UUID 文件名，内容不会变。
 *   - /api/ 的 GET：网络优先、成功后回写缓存 —— 拿到的是最新数据，
 *     只有在后端暂时不可达（离线）时才退回上次读过的内容，这正是本地优先应用该有的降级。
 *
 * 注意：这是一份「越用越有缓存」的运行时缓存，而非一次性全量预缓存，
 * 因此首次联网访问后，第二次起离线才可读；这与所有 SPA 的 PWA 行为一致。
 */
const VERSION = 'v1';
const SHELL_CACHE = `lattice-shell-${VERSION}`;
const RUNTIME_CACHE = `lattice-runtime-${VERSION}`;

// 随外壳一起预缓存的静态资源（都不带内容哈希，需靠版本升级刷新）
const PRECACHE_URLS = ['/', '/index.html', '/manifest.webmanifest', '/theme-init.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 导出站点是独立预览、附件之外无必要经手，交给浏览器默认处理
  if (url.pathname.startsWith('/export/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstRuntime(request));
    return;
  }
  // /assets/、/attachments/、图标、字体等静态资源
  event.respondWith(cacheFirst(request));
});

/** 缓存优先：命中即用，未命中回源并写入运行时缓存 */
async function cacheFirst(request) {
  const cached = await matchCache(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) putRuntime(request, response.clone());
  return response;
}

/** 网络优先（外壳）：在线时取最新 index.html 并刷新缓存，离线回落到缓存外壳 */
async function networkFirstShell(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/index.html', response.clone());
    }
    return response;
  } catch (error) {
    return (await matchCache(request)) || (await caches.match('/index.html')) || Response.error();
  }
}

/** 网络优先（API）：始终尝试取最新数据，成功后回写；仅在网络失败时回落到上次缓存 */
async function networkFirstRuntime(request) {
  try {
    const response = await fetch(request);
    if (response.ok) putRuntime(request, response.clone());
    return response;
  } catch (error) {
    const cached = await matchCache(request);
    // 只读缓存里的 JSON 响应；未缓存过的接口在离线时如实报错，让前端「连接中断」横幅接管
    if (cached && (cached.headers.get('content-type') || '').includes('application/json')) return cached;
    return Response.error();
  }
}

async function matchCache(request) {
  return (await caches.match(request, { ignoreSearch: false })) ?? null;
}

async function putRuntime(request, response) {
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, response);
}
