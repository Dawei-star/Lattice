export function registerPwa({ onInstallAvailable, onUpdateAvailable } = {}) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return () => {};

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
