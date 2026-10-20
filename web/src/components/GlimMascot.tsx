import { useEffect, useState } from 'react';

/**
 * Lattice AI 训练家：主视觉直接使用用户提供的全身参考图。
 *
 * 参考图作为本地项目素材使用；状态化的小尺寸资源仍由本地 SVG 表达。
 *
 * 状态矢量源在 `web/public/mascot/`，由 `FILES/AI-mascot/tools/generate.mjs` 生成，
 * 主视觉位于 `glim-reference-full.png`。文件名沿用历史的 `glim-*`，避免运行时改路径、
 * 改动既有缓存与深链；页面里显示为「Lattice AI」。
 *
 * 画布有两种：全身状态是 256×320（4:5），`tiny` 用的 compact 是 128×128（1:1）。
 * 外层 `.lattice-ai-avatar` 是方形占位，`<img>` 以 contain 方式等比放入，4:5 的
 * 全身稿会在容器内自动左右留白——所以 48px 与 hero 都不裁切、不变形。
 * 状态差异由表情和全息道具承担：检索卡片、倾听信号弧、写入笔迹、完成勾选、
 * 连接节点、离线静音线与异常断点。形象不是装饰，状态要能被读出来。
 */
export type GlimState =
  | 'idle'
  | 'thinking'
  | 'listening'
  | 'writing'
  | 'happy'
  | 'linked'
  | 'offline'
  | 'error';

export type GlimSize = 'tiny' | 'small' | 'large' | 'hero';

/** 小到 24px 时，4:5 的全身稿会缩成一条噪点；改用 1:1 compact 半身像，
    红帽、蓝背心与脸仍然读得出来。 */
const COMPACT_MAX_SIZE = 24;

/** 未指定 `title` 时，屏幕阅读器与浏览器 tooltip 使用的统一称呼。 */
const MASCOT_NAME = 'Lattice AI 训练家';

const STATE_FILES: Record<GlimState, string> = {
  idle: 'glim',
  thinking: 'glim-thinking',
  listening: 'glim-listening',
  writing: 'glim-writing',
  happy: 'glim-happy',
  linked: 'glim-linked',
  offline: 'glim-offline',
  error: 'glim-error',
};

/** 个性化弹窗里可选的状态家族（顺序即展示顺序）。 */
export const GLIM_STATES: Array<{ state: GlimState; label: string; note: string }> = [
  { state: 'idle', label: '待命', note: '等待你的任务' },
  { state: 'thinking', label: '检索', note: '正在整理相关内容' },
  { state: 'listening', label: '倾听', note: '正在接收你的问题' },
  { state: 'writing', label: '写入', note: '正在把结果写回空间' },
  { state: 'happy', label: '完成', note: '结果已经清晰' },
  { state: 'linked', label: '连接', note: '已经建立内容关系' },
  { state: 'offline', label: '离线', note: '当前只使用本地能力' },
  { state: 'error', label: '异常', note: '有一条路径需要修复' },
];

/**
 * 状态 → 文件名映射：tiny（22px）统一取 compact 半身像；其余按尺寸取全身稿，
 * hero 直接走用户指定的全身图（用于空态、个性化预览）。
 * 所有文件都是同一套几何，切换状态只换文件，不动布局。
 */
export function glimSrc(state: GlimState, size: GlimSize): string {
  const px = size === 'tiny' ? 22 : size === 'small' ? 48 : size === 'large' ? 82 : 148;
  if (px <= COMPACT_MAX_SIZE) return '/mascot/glim-compact.svg';
  if (size === 'hero') return '/mascot/glim-reference-full.png';
  return `/mascot/${STATE_FILES[state]}.svg`;
}

/**
 * `happy` 是瞬时反馈：调用方把它作为目标状态传进来，组件在 `happyHoldMs`
 * 之后自行回落到 idle，避免"成功表情永久挂在头像上"。
 */
export function useGlimState(base: GlimState, happyHoldMs = 1200): GlimState {
  const [state, setState] = useState(base);
  useEffect(() => {
    if (base !== 'happy') {
      setState(base);
      return;
    }
    setState('happy');
    const timer = window.setTimeout(() => setState('idle'), happyHoldMs);
    return () => window.clearTimeout(timer);
  }, [base, happyHoldMs]);
  return state;
}

/**
 * 头像组件：只输出状态类名与文件名，不参与布局。
 *
 * 无障碍语义：传 `title`（如「待命」「Lattice AI」）时，容器是 `role="img"`，
 * 可访问名称为「<title> · Lattice AI 训练家」并作为 tooltip；不传时等同于装饰，
 * 整块 `aria-hidden`，读屏语境交给外层的按钮/标题，避免 8 宫格重复朗读。
 */
export default function GlimMascot({
  size = 'small',
  state = 'idle',
  title,
  className = '',
}: {
  size?: GlimSize;
  state?: GlimState;
  title?: string;
  className?: string;
}) {
  const label = title ? `${title} · ${MASCOT_NAME}` : null;
  return (
    <span
      className={`lattice-ai-avatar lattice-ai-avatar--${size} lattice-ai-avatar--${state}${className ? ` ${className}` : ''}`}
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      title={label ?? undefined}
    >
      <img src={glimSrc(state, size)} alt="" draggable={false} />
    </span>
  );
}
