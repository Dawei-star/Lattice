// 版本号递增会让 activate 删除旧缓存：修改本文件或想强制全员刷新缓存时递增。
// v2：修复「cache-first 永久缓存 Vite 开发模块」——开发期 /src、/@vite、/node_modules
// 的模块不再经过 SW，生产构建不受影响（构建产物带内容哈希，仍走 cache-first）。
const CACHE_NAME = 'lattice-shell-v2';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/theme-init.js', '/lattice-icon.svg'];

// 永不缓存、永不代答的路径：Vite 开发服务器的源码模块与 HMR 通道
const UNCACHED_PREFIXES = ['/src/', '/@vite/', '/@react-refresh', '/node_modules/'];

self.addEventListener('install', (event) => {
  // 立即接管：cache-first 出问题时页面本身就是坏的，用户没有机会在应用内
  // 点「更新」按钮，等待态会让修复版 SW 永远无法生效
  event.waitUntil(Promise.all([
    self.skipWaiting(),
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  ]));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || request.headers.get('accept')?.includes('text/event-stream')) return;
  // 开发期源码模块一律直连网络：cache-first 在这里等于「永远热更新失效」
  if (UNCACHED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
      }
      return response;
    }).catch(() => caches.match('/index.html')));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    });
  }));
});
