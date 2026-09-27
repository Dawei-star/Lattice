const STORAGE_KEY = 'lattice-settings-v1';

export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: '14',
  contentWidth: '860',
  density: 'compact',
  editorMode: 'split',
  tabSize: '2',
  autoSaveDelay: '900',
  autoSave: true,
  quickSwitcher: true,
});

const OPTIONS = {
  fontSize: new Set(['13', '14', '15']),
  contentWidth: new Set(['720', '860', '1040']),
  density: new Set(['compact', 'comfortable']),
  editorMode: new Set(['edit', 'split', 'preview']),
  tabSize: new Set(['2', '4']),
  autoSaveDelay: new Set(['500', '900', '1500']),
};

export function loadSettings() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return normalizeSettings(stored);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch) {
  const next = normalizeSettings({ ...loadSettings(), ...patch });

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式下 localStorage 可能不可写，当前会话仍然立即应用设置。
  }

  applySettings(next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lattice:settings-change', { detail: next }));
  }
  return next;
}

export function applySettings(settings = loadSettings()) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--interface-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--content-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--content-max-width', `${settings.contentWidth}px`);
  root.dataset.density = settings.density;
}

export function subscribeSettings(listener) {
  if (typeof window === 'undefined') return () => {};
  const handleChange = (event) => listener(event.detail ?? loadSettings());
  window.addEventListener('lattice:settings-change', handleChange);
  return () => window.removeEventListener('lattice:settings-change', handleChange);
}

function normalizeSettings(value) {
  const next = { ...DEFAULT_SETTINGS };
  for (const [key, options] of Object.entries(OPTIONS)) {
    if (typeof value?.[key] === 'string' && options.has(value[key])) next[key] = value[key];
  }
  if (typeof value?.autoSave === 'boolean') next.autoSave = value.autoSave;
  if (typeof value?.quickSwitcher === 'boolean') next.quickSwitcher = value.quickSwitcher;
  return next;
}
