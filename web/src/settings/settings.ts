import { createStore } from 'zustand/vanilla';

/** 界面偏好设置（localStorage 持久化，跨窗口广播同步）。 */
export interface LatticeSettings {
  fontSize: string;
  contentWidth: string;
  density: 'compact' | 'comfortable';
  editorMode: 'edit' | 'split' | 'preview';
  tabSize: string;
  autoSaveDelay: string;
  autoSave: boolean;
  quickSwitcher: boolean;
  showAttachments: boolean;
  backgroundImage: string;
}

export type SettingsPatch = Partial<LatticeSettings>;

const STORAGE_KEY = 'lattice-settings-v1';
const SAFE_BACKGROUND_IMAGE = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/]+={0,2}$/i;

export const DEFAULT_SETTINGS: Readonly<LatticeSettings> = Object.freeze({
  fontSize: '14',
  contentWidth: '860',
  density: 'compact',
  editorMode: 'split',
  tabSize: '2',
  autoSaveDelay: '900',
  autoSave: true,
  quickSwitcher: true,
  showAttachments: false,
  backgroundImage: '',
});

const OPTIONS: Record<Exclude<keyof LatticeSettings, 'autoSave' | 'quickSwitcher' | 'showAttachments' | 'backgroundImage'>, Set<string>> = {
  fontSize: new Set(['13', '14', '15']),
  contentWidth: new Set(['720', '860', '1040']),
  density: new Set(['compact', 'comfortable']),
  editorMode: new Set(['edit', 'split', 'preview']),
  tabSize: new Set(['2', '4']),
  autoSaveDelay: new Set(['500', '900', '1500']),
};

const settingsStore = createStore<{ settings: LatticeSettings | null }>(() => ({ settings: null }));
const bridgedWindows = new WeakSet<Window>();

function bridgeWindowEvents() {
  if (typeof window === 'undefined' || bridgedWindows.has(window)) return;
  window.addEventListener('lattice:settings-change', (event) => {
    const next = (event as CustomEvent).detail ?? loadSettings();
    if (settingsStore.getState().settings !== next) settingsStore.setState({ settings: next });
  });
  bridgedWindows.add(window);
}

export function loadSettings(): LatticeSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };

  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return normalizeSettings(stored as Record<string, unknown> | null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch: SettingsPatch): LatticeSettings {
  const next = normalizeSettings({ ...loadSettings(), ...patch });

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式下 localStorage 可能不可写，当前会话仍然立即应用设置。
  }

  applySettings(next);
  bridgeWindowEvents();
  settingsStore.setState({ settings: next });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new window.CustomEvent('lattice:settings-change', { detail: next }));
  }
  return next;
}

export function applySettings(settings: LatticeSettings = loadSettings()) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--interface-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--content-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--content-max-width', `${settings.contentWidth}px`);
  root.style.setProperty('--app-background-image', settings.backgroundImage ? `url("${settings.backgroundImage}")` : 'none');
  root.dataset.density = settings.density;
}

export function subscribeSettings(listener: (settings: LatticeSettings) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  bridgeWindowEvents();
  return settingsStore.subscribe((state) => listener(state.settings as LatticeSettings));
}

function normalizeSettings(value: Record<string, unknown> | null | undefined): LatticeSettings {
  const next = { ...DEFAULT_SETTINGS };
  for (const [key, options] of Object.entries(OPTIONS)) {
    if (typeof value?.[key] === 'string' && options.has(value[key] as string)) (next as Record<string, unknown>)[key] = value[key];
  }
  if (typeof value?.autoSave === 'boolean') next.autoSave = value.autoSave;
  if (typeof value?.quickSwitcher === 'boolean') next.quickSwitcher = value.quickSwitcher;
  if (typeof value?.showAttachments === 'boolean') next.showAttachments = value.showAttachments;
  if (value?.backgroundImage === '' || (typeof value?.backgroundImage === 'string' && SAFE_BACKGROUND_IMAGE.test(value.backgroundImage))) {
    next.backgroundImage = value.backgroundImage;
  }
  return next;
}
