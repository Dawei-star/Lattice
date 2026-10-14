/** 注册回调：安装提示可用 / 更新可用时通知调用方。 */
export interface PwaRegistrationOptions {
  onInstallAvailable?: (available: boolean) => void;
  onUpdateAvailable?: (registration: ServiceWorkerRegistration) => void;
}

/** beforeinstallprompt 事件（DOM 标准尚未收录，这里只做结构化类型声明）。 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

/** registerPwa 的返回值：卸载清理函数，附加 promptInstall / applyUpdate 动作。 */
export type PwaRegistration = (() => void) & { promptInstall: () => Promise<boolean>; applyUpdate: () => boolean };

/** PWA 未就绪（或环境不支持）时的空实现。 */
function inactiveRegistration(): PwaRegistration {
  return Object.assign(() => {}, {
    promptInstall: (): Promise<boolean> => Promise.resolve(false),
    applyUpdate: (): boolean => false,
  });
}

export function registerPwa({ onInstallAvailable, onUpdateAvailable }: PwaRegistrationOptions = {}): PwaRegistration {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return inactiveRegistration();
  // 开发模式绝不注册：SW 的 cache-first 会把 Vite 的 /src 模块永久缓存，
  // 热更新全部失效，且新旧模块 ESM 导出对不上时整页白屏（生产构建资源
  // 带内容哈希，才适合 SW 缓存）。import.meta.env 仅在 Vite 构建时存在。
  if (import.meta.env?.DEV) return inactiveRegistration();

  let installEvent: BeforeInstallPromptEvent | null = null;
  let registration: ServiceWorkerRegistration | null = null;
  let disposed = false;
  const handleBeforeInstallPrompt = (event: Event) => {
    event.preventDefault();
    installEvent = event as BeforeInstallPromptEvent;
    onInstallAvailable?.(true);
  };
  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((nextRegistration) => {
    if (disposed) return;
    registration = nextRegistration;
    const notifyIfWaiting = () => {
      if (nextRegistration.waiting && navigator.serviceWorker.controller) onUpdateAvailable?.(nextRegistration);
    };
    notifyIfWaiting();
    nextRegistration.addEventListener('updatefound', () => {
      const worker = nextRegistration.installing;
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
