const STORAGE_KEY = 'lattice-imported-theme-v1';

const ALLOWED_TOKENS = new Set([
  'bg', 'bg-panel', 'bg-subtle', 'bg-hover', 'bg-active',
  'border', 'border-strong', 'text', 'text-secondary', 'text-tertiary',
  'accent', 'accent-hover', 'accent-soft', 'accent-contrast',
  'danger', 'danger-soft', 'success', 'success-soft', 'warning', 'warning-soft',
  'graph-edge', 'graph-edge-active', 'graph-node', 'graph-node-active', 'graph-label',
]);

const SAFE_COLOR = /^(transparent|currentColor|#[0-9a-f]{3,8}|rgba?\([^;{}]+\)|hsla?\([^;{}]+\))$/i;

export async function importThemeFile(file) {
  if (!file) throw new Error('请选择主题文件');
  if (file.size > 256 * 1024) throw new Error('主题文件不能超过 256 KB');

  const text = await file.text();
  const extension = file.name.toLowerCase().split('.').pop();
  const raw = extension === 'css' ? parseCssTheme(text) : parseJsonTheme(text);
  const tokens = sanitizeTokens(raw);
  if (Object.keys(tokens).length === 0) throw new Error('主题文件没有可识别的颜色令牌');

  const theme = {
    name: raw.name || file.name.replace(/\.[^.]+$/, ''),
    tokens,
  };
  applyImportedTheme(theme);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(theme)); } catch {}
  return theme;
}

export function loadImportedTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved?.tokens) return null;
    const theme = { name: saved.name || 'Imported theme', tokens: sanitizeTokens(saved.tokens) };
    if (!Object.keys(theme.tokens).length) return null;
    applyImportedTheme(theme);
    return theme;
  } catch {
    return null;
  }
}

export function clearImportedTheme() {
  for (const token of ALLOWED_TOKENS) document.documentElement.style.removeProperty(`--${token}`);
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export function applyImportedTheme(theme) {
  for (const token of ALLOWED_TOKENS) document.documentElement.style.removeProperty(`--${token}`);
  for (const [token, value] of Object.entries(theme.tokens)) {
    document.documentElement.style.setProperty(`--${token}`, value);
  }
}

function parseJsonTheme(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('主题 JSON 格式无效');
  return { name: parsed.name, tokens: parsed.colors ?? parsed.tokens ?? parsed };
}

function parseCssTheme(text) {
  const tokens = {};
  for (const match of text.matchAll(/--([a-z0-9-]+)\s*:\s*([^;{}]+)\s*;?/gi)) {
    tokens[match[1]] = match[2].trim();
  }
  return { name: 'CSS theme', tokens };
}

function sanitizeTokens(raw) {
  const tokens = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const token = key.replace(/^--/, '').trim();
    const normalized = String(value).trim();
    if (ALLOWED_TOKENS.has(token) && SAFE_COLOR.test(normalized)) tokens[token] = normalized;
  }
  return tokens;
}

export const importedThemeStorageKey = STORAGE_KEY;
