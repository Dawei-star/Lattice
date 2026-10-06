export function registerPwa({ onInstallAvailable, onUpdateAvailable } = {}) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  // 开发模式绝不注册：SW 的 cache-first 会把 Vite 的 /src 模块永久缓存，
  // 热更新全部失效，且新旧模块 ESM 导出对不上时整页白屏（生产构建资源
  // 带内容哈希，才适合 SW 缓存）。import.meta.env 仅在 Vite 构建时存在。
  if (import.meta.env?.DEV) return () => {};

  let installEvent = null;
  let registration = null;
  let disposed = false;
  const handleBeforeInstallPrompt = (event) => {
    event.preventDefault();
    installEvent = event;
    onInstallAvailable?.(true);
  };
  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((nextRegistration) => {
    if (disposed) return;
    registration = nextRegistration;
    const notifyIfWaiting = () => {
      if (registration.waiting && navigator.serviceWorker.controller) onUpdateAvailable?.(registration);
    };
    notifyIfWaiting();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') notifyIfWaiting();
      });
    });
  }).catch(() => {
    // PWA support is an enhancement; the normal app remains usable if registration fails.
  });

  async function promptInstall() {
    if (!installEvent) return false;
    installEvent.prompt();
    const result = await installEvent.userChoice;
    installEvent = null;
    onInstallAvailable?.(false);
    return result?.outcome === 'accepted';
  }

  function applyUpdate() {
    if (!registration?.waiting) return false;
    const reload = () => window.location.reload();
    navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  // The returned object is intentionally attached after registration setup so
  // callers can use the same cleanup function and actions without global state.
  // eslint-compatible properties are supported by the plain browser module.
  return Object.assign(() => {
    disposed = true;
    window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, {
    promptInstall,
    applyUpdate,
  });
}
