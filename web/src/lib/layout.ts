// 工作区布局：目录树 / 笔记列表 / 链接面板宽度与分栏比例。
// 拖动会高频调用 saveLayout，持久化做了 300ms 防抖；返回值始终是收敛到限制区间的完整布局。

/** 工作区布局快照。 */
export interface WorkspaceLayout {
  tree: number;
  list: number;
  panel: number;
  split: number;
}

const STORAGE_KEY = 'lattice-layout-v1';

export const DEFAULT_LAYOUT: WorkspaceLayout = Object.freeze({ tree: 236, list: 300, panel: 270, split: 50 });

const LIMITS = Object.freeze({
  tree: [180, 440],
  list: [248, 560],
  panel: [200, 460],
  split: [22, 78],
}) as Record<keyof WorkspaceLayout, [number, number]>;

function clamp(value: number, [min, max]: [number, number]): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeLayout(value: unknown): WorkspaceLayout {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<WorkspaceLayout>;
  return {
    tree: clamp(Number(source.tree ?? DEFAULT_LAYOUT.tree), LIMITS.tree),
    list: clamp(Number(source.list ?? DEFAULT_LAYOUT.list), LIMITS.list),
    panel: clamp(Number(source.panel ?? DEFAULT_LAYOUT.panel), LIMITS.panel),
    split: clamp(Number(source.split ?? DEFAULT_LAYOUT.split), LIMITS.split),
  };
}

export function loadLayout(): WorkspaceLayout {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_LAYOUT };
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

let persistTimer: number | undefined;

export function saveLayout(next: Partial<WorkspaceLayout>): WorkspaceLayout {
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
