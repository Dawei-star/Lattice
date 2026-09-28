// 工作区布局：目录树 / 笔记列表 / 链接面板宽度与分栏比例。
// 拖动会高频调用 saveLayout，持久化做了 300ms 防抖；返回值始终是收敛到限制区间的完整布局。
const STORAGE_KEY = 'lattice-layout-v1';

export const DEFAULT_LAYOUT = Object.freeze({ tree: 236, list: 300, panel: 270, split: 50 });

const LIMITS = Object.freeze({
  tree: [180, 440],
  list: [248, 560],
  panel: [200, 460],
  split: [22, 78],
});

function clamp(value, [min, max]) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeLayout(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    tree: clamp(Number(source.tree ?? DEFAULT_LAYOUT.tree), LIMITS.tree),
    list: clamp(Number(source.list ?? DEFAULT_LAYOUT.list), LIMITS.list),
    panel: clamp(Number(source.panel ?? DEFAULT_LAYOUT.panel), LIMITS.panel),
    split: clamp(Number(source.split ?? DEFAULT_LAYOUT.split), LIMITS.split),
  };
}

export function loadLayout() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_LAYOUT };
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

let persistTimer = null;

export function saveLayout(next) {
  const merged = normalizeLayout(next);
  if (typeof window !== 'undefined') {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // 隐私模式写不进 localStorage 时只保留会话内状态。
      }
    }, 300);
  }
  return merged;
}
