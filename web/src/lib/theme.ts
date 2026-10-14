const STORAGE_KEY = 'lattice-imported-theme-v1';

const ALLOWED_TOKENS = new Set([
  'bg', 'bg-panel', 'bg-subtle', 'bg-hover', 'bg-active',
  'border', 'border-strong', 'text', 'text-secondary', 'text-tertiary',
  'accent', 'accent-hover', 'accent-soft', 'accent-contrast',
  'danger', 'danger-soft', 'success', 'success-soft', 'warning', 'warning-soft',
  'graph-edge', 'graph-edge-active', 'graph-node', 'graph-node-active', 'graph-label',
]);

const SAFE_COLOR = /^(transparent|currentColor|#[0-9a-f]{3,8}|rgba?\([^;{}]+\)|hsla?\([^;{}]+\))$/i;

/** 主题颜色令牌表：令牌名 → 合法 CSS 颜色值。 */
export type ThemeTokens = Record<string, string>;

/** 已应用/导入的主题：名称 + 令牌表。 */
export interface ImportedTheme {
  name: string;
  tokens: ThemeTokens;
}

/** 对比度不足的命中项。 */
export interface ContrastIssue {
  foreground: string;
  background: string;
  minimum: number;
  ratio: number;
}

interface ContrastRule {
  foreground: string;
  minimum: number;
  background?: string;
  backgrounds?: string[];
}

const CONTRAST_RULES: ContrastRule[] = [
  { foreground: 'text', minimum: 4.5, backgrounds: ['bg', 'bg-panel', 'bg-subtle'] },
  { foreground: 'text-secondary', minimum: 4.5, backgrounds: ['bg', 'bg-panel', 'bg-subtle'] },
  { foreground: 'text-tertiary', minimum: 3, backgrounds: ['bg', 'bg-panel', 'bg-subtle'] },
  { foreground: 'accent', minimum: 3, backgrounds: ['bg', 'bg-panel', 'bg-subtle'] },
  { foreground: 'accent-hover', minimum: 3, backgrounds: ['bg', 'bg-panel', 'bg-subtle'] },
  { foreground: 'accent-contrast', background: 'accent', minimum: 4.5 },
];

/** 解析后的 CSS 颜色通道值（r/g/b 0-255，a 0-1）。 */
interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export async function importThemeFile(file: File): Promise<ImportedTheme> {
  if (!file) throw new Error('请选择主题文件');
  if (file.size > 256 * 1024) throw new Error('主题文件不能超过 256 KB');

  const text = await file.text();
  const extension = file.name.toLowerCase().split('.').pop();
  const raw = extension === 'css' ? parseCssTheme(text) : parseJsonTheme(text);
  const tokens = sanitizeTokens(raw.tokens);
  if (Object.keys(tokens).length === 0) throw new Error('主题文件没有可识别的颜色令牌');

  const contrastIssues = validateThemeContrast(tokens);
  if (contrastIssues.length) throw new Error(formatContrastIssues(contrastIssues));

  const theme = {
    name: raw.name || file.name.replace(/\.[^.]+$/, ''),
    tokens,
  };
  applyImportedTheme(theme);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(theme)); } catch {}
  return theme;
}

export function loadImportedTheme(): ImportedTheme | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved?.tokens) return null;
    const theme = { name: saved.name || 'Imported theme', tokens: sanitizeTokens(saved.tokens) };
    if (!Object.keys(theme.tokens).length) return null;
    if (validateThemeContrast(theme.tokens).length) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    applyImportedTheme(theme);
    return theme;
  } catch {
    return null;
  }
}

export function clearImportedTheme(): void {
  for (const token of ALLOWED_TOKENS) document.documentElement.style.removeProperty(`--${token}`);
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export function applyImportedTheme(theme: ImportedTheme): void {
  for (const token of ALLOWED_TOKENS) document.documentElement.style.removeProperty(`--${token}`);
  for (const [token, value] of Object.entries(theme.tokens)) {
    document.documentElement.style.setProperty(`--${token}`, value);
  }
}

interface RawTheme {
  name: string;
  tokens: ThemeTokens;
}

function parseJsonTheme(text: string): RawTheme {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('主题 JSON 格式无效');
  return { name: parsed.name, tokens: parsed.colors ?? parsed.tokens ?? parsed };
}

function parseCssTheme(text: string): RawTheme {
  const tokens: ThemeTokens = {};
  for (const match of text.matchAll(/--([a-z0-9-]+)\s*:\s*([^;{}]+)\s*;?/gi)) {
    tokens[match[1]] = match[2].trim();
  }
  return { name: 'CSS theme', tokens };
}

function sanitizeTokens(raw: ThemeTokens | null | undefined): ThemeTokens {
  const tokens: ThemeTokens = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const token = key.replace(/^--/, '').trim();
    const normalized = String(value).trim();
    if (ALLOWED_TOKENS.has(token) && SAFE_COLOR.test(normalized)) tokens[token] = normalized;
  }
  return tokens;
}

export function validateThemeContrast(rawTokens: ThemeTokens | Record<string, string> | null | undefined): ContrastIssue[] {
  const tokens = sanitizeTokens(rawTokens);
  const issues: ContrastIssue[] = [];

  for (const rule of CONTRAST_RULES) {
    const backgroundNames = rule.background ? [rule.background] : (rule.backgrounds as string[]);
    if (!tokens[rule.foreground]) continue;

    for (const backgroundName of backgroundNames) {
      if (!tokens[backgroundName]) continue;
      const background = resolveBackground(tokens, backgroundName);
      const foreground = resolveForeground(tokens[rule.foreground], background);
      if (!background || !foreground) continue;

      const ratio = contrastRatio(foreground, background);
      if (ratio < rule.minimum) {
        issues.push({
          foreground: rule.foreground,
          background: backgroundName,
          minimum: rule.minimum,
          ratio,
        });
      }
    }
  }

  return issues;
}

function formatContrastIssues(issues: ContrastIssue[]): string {
  const details = issues
    .slice(0, 5)
    .map((issue) => `${issue.foreground} / ${issue.background} ${issue.ratio.toFixed(2)}:1（至少 ${issue.minimum}:1）`)
    .join('；');
  const remainder = issues.length > 5 ? `；另有 ${issues.length - 5} 项` : '';
  return `主题对比度不足：${details}${remainder}`;
}

function resolveBackground(tokens: ThemeTokens, token: string): RgbaColor | null {
  const base = parseCssColor(tokens.bg);
  const color = parseCssColor(tokens[token]);
  if (!color) return null;
  if (token === 'bg') return toOpaque(color);
  return compositeColor(color, base);
}

function resolveForeground(value: string, background: RgbaColor | null): RgbaColor | null {
  const color = parseCssColor(value);
  if (!color || !background) return null;
  return compositeColor(color, background);
}

function parseCssColor(value: unknown): RgbaColor | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'currentcolor') return null;
  if (normalized === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hex = normalized.match(/^#([0-9a-f]+)$/i)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const expanded = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }

  const functionMatch = normalized.match(/^(rgb|rgba|hsl|hsla)\((.*)\)$/i);
  if (!functionMatch) return null;

  const [, type, body] = functionMatch;
  const [channelText, alphaText] = splitAlpha(body);
  const channels = channelText.includes(',')
    ? channelText.split(',').map((part) => part.trim())
    : channelText.trim().split(/\s+/);
  let alpha = alphaText ? parseAlpha(alphaText) : 1;
  if (channels.length === 4 && !alphaText) alpha = parseAlpha(channels.pop()!);
  if (channels.length !== 3 || alpha == null) return null;

  if (type.startsWith('rgb')) {
    const rgb = channels.map(parseRgbChannel);
    if (rgb.some((channel) => channel == null)) return null;
    return { r: rgb[0]!, g: rgb[1]!, b: rgb[2]!, a: alpha };
  }

  const hue = parseHue(channels[0]);
  const saturation = parsePercentage(channels[1]);
  const lightness = parsePercentage(channels[2]);
  if (hue == null || saturation == null || lightness == null) return null;
  const rgb = hslToRgb(hue, saturation, lightness);
  return { ...rgb, a: alpha };
}

function splitAlpha(body: string): [string, string] {
  const slashIndex = body.indexOf('/');
  if (slashIndex === -1) return [body, ''];
  return [body.slice(0, slashIndex).trim(), body.slice(slashIndex + 1).trim()];
}

function parseRgbChannel(value: string): number | null {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  return clamp(value.trim().endsWith('%') ? number * 2.55 : number, 0, 255);
}

function parseAlpha(value: string): number | null {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  return clamp(value.trim().endsWith('%') ? number / 100 : number, 0, 1);
}

function parsePercentage(value: string): number | null {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  return clamp(value.trim().endsWith('%') ? number / 100 : number, 0, 1);
}

function parseHue(value: string): number | null {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  const normalized = value.trim();
  if (normalized.endsWith('turn')) return number * 360;
  if (normalized.endsWith('rad')) return number * (180 / Math.PI);
  return number;
}

function hslToRgb(hue: number, saturation: number, lightness: number): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360 / 360;
  if (saturation === 0) {
    const gray = lightness * 255;
    return { r: gray, g: gray, b: gray };
  }

  const hueToRgb = (p: number, q: number, t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3) * 255,
    g: hueToRgb(p, q, h) * 255,
    b: hueToRgb(p, q, h - 1 / 3) * 255,
  };
}

function compositeColor(foreground: RgbaColor, background: RgbaColor | null): RgbaColor | null {
  if (!background) return foreground.a >= 1 ? foreground : null;
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return null;
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function toOpaque(color: RgbaColor): RgbaColor | null {
  return color.a >= 1 ? color : null;
}

function contrastRatio(foreground: RgbaColor, background: RgbaColor): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function relativeLuminance(color: RgbaColor): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export const importedThemeStorageKey: string = STORAGE_KEY;
