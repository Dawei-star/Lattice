import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { EXPRESSIONS, HEAD_PATH } from './glimBotData.ts';
import {
  CIRCLE_RING,
  EYE_HALF,
  HEAD_C,
  PENCIL_RING,
  buildShape,
  centroid,
  lerpRing,
  ringOutline,
  ringPath,
} from './glimBotGeometry.ts';

/**
 * Glim —— Lattice AI 的机器人形象。
 *
 * 造型与动效移植自 Reproduce-grok-bot-icon
 * <https://github.com/sheng-yh/Reproduce-grok-bot-icon>（x.ai/bot 交互图标
 * 的忠实复刻，美术版权归 xAI，仅学习参考）。核心思路与旧版「CSS 动画机器人」
 * 完全不同：
 *
 * - 头部轮廓与 25 种眼睛表情都是「点环」（见 glimBotData.ts），相邻表情
 *   逐点插值，形变是液体般的「融化」而非切换素材；
 * - 所有动效由一个 rAF 循环里的临界阻尼弹簧驱动，每帧直接写 SVG 属性，
 *   动画期间 React 不重渲染；
 * - 状态机把业务状态映射到表情候选池、注视漂移、眨眼弹出节奏与环形特效
 *   （thinking → 头旁思考点，writing → 绕头铅笔轨迹）；
 * - 颜色只认 `--glim-fg`（头部）/ `--glim-bg`（眼睛）两个 CSS 变量，
 *   由 styles.css 按主题提供；
 * - `prefers-reduced-motion` 下动画折叠为静态表情。
 *
 * 对外 API 与旧版完全兼容：`GlimState` / `GlimSize` / `GLIM_STATES` /
 * `useGlimState` 语义不变，调用方（AIAssistantPanel、个性化弹窗）零改动。
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

/** `happy` 是瞬时反馈：到达后停留 `happyHoldMs` 再回落 idle，避免成功表情永久挂着。 */
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

/* ============================================================
 * 状态机数据（上游 f / A / m / L / T 表中本项目用到的子集）
 * ============================================================ */

/** 引擎状态：Lattice 业务状态到原型状态的映射目标。 */
type BotState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'writing'
  | 'happy'
  | 'celebrate'
  | 'sleeping'
  | 'angry';

/** 业务状态 → 引擎状态（linked 用庆祝、offline 用入睡、error 用生气）。 */
const BOT_STATE: Record<GlimState, BotState> = {
  idle: 'idle',
  thinking: 'thinking',
  listening: 'listening',
  writing: 'writing',
  happy: 'happy',
  linked: 'celebrate',
  offline: 'sleeping',
  error: 'angry',
};

/** 状态 → 表情候选池（引用 EXPRESSIONS 下标；每届随机切换一个）。 */
const EXPRESSION_POOL: Record<BotState, number[]> = {
  sleeping: [13, 22, 4],
  idle: [0, 8],
  listening: [10, 1, 19],
  thinking: [8, 16, 14, 17, 5],
  writing: [15, 9],
  happy: [2, 11, 17, 19],
  celebrate: [2, 8, 17],
  angry: [7, 16],
};

/** 状态 → 表情切换间隔 [min, max] ms。 */
const SWITCH_MS: Record<BotState, [number, number]> = {
  sleeping: [6000, 10000],
  idle: [9000, 16000],
  listening: [2800, 5000],
  thinking: [2000, 3600],
  writing: [4000, 8000],
  happy: [2500, 4500],
  celebrate: [1400, 2600],
  angry: [2200, 3800],
};

/** 状态 → 眨眼弹出节奏 [min, max] ms（null = 不自动眨眼）。 */
const BLINK_MS: Partial<Record<BotState, [number, number]>> = {
  idle: [6000, 14000],
  listening: [3000, 7000],
  thinking: [3500, 7000],
  happy: [2500, 5000],
  celebrate: [2200, 4500],
  angry: [3500, 7000],
};

/** 状态 → 环形特效（thinking 时头部吹成圆 + 两侧思考点；writing 变泪滴 + 铅笔）。 */
const RING_EFFECT: Partial<Record<BotState, 'dots' | 'pencil'>> = {
  thinking: 'dots',
  writing: 'pencil',
};

/** 特效激活时 viewBox 推近倍数（让特效环进入视野）。 */
const RING_ZOOM: Record<'dots' | 'pencil', number> = { dots: 1.5, pencil: 1.18 };

/** 特效期间头部微微放大的基准系数。 */
const RING_SIZE: Record<'dots' | 'pencil', number> = { dots: 22, pencil: 17 };

/* ============================================================
 * 物理与缓动（上游 _ / k / $ / D / P / S / el）
 * ============================================================ */

interface Spring {
  x: number;
  v: number;
  t: number;
}

const makeSpring = (x: number): Spring => ({ x, v: 0, t: x });

/** 临界阻尼弹簧积分一步：v += (−2ζω·v − ω²(x − target))·dt。 */
function stepSpring(s: Spring, omega: number, zeta: number, dt: number) {
  s.v += (-2 * zeta * omega * s.v - omega * omega * (s.x - s.t)) * dt;
  s.x += s.v * dt;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = s.t;
    s.v = 0;
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const backOut = (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** 眨眼包络（庆祝反弹用）：4 段 {高度, 时长(s)} 的眼皮行程。 */
const BLINK_ENV = [
  { h: 48, d: 0.5 },
  { h: 28, d: 0.382 },
  { h: 14, d: 0.27 },
  { h: 6, d: 0.177 },
];
const BLINK_DUR = BLINK_ENV.reduce((sum, seg) => sum + seg.d, 0);

/** 铅笔_glyph：绕头书写的胶囊笔身（旋转跟随轨迹切线）。 */
const PENCIL_GLYPH = (() => {
  const top = HEAD_C - 44 + 15;
  const bottom = HEAD_C + 44 - 15;
  return `M${HEAD_C - 15} ${top}A15 15 0 0 1 ${HEAD_C + 15} ${top}L${HEAD_C + 15} ${bottom}A15 15 0 0 1 ${HEAD_C - 15} ${bottom}Z`;
})();

/** 模块级预计算：blob 头形状与平底圆轮廓。 */
const BLOB = buildShape(HEAD_PATH);
const CIRCLE_OUTLINE = ringOutline(CIRCLE_RING);

/* ============================================================
 * 组件
 * ============================================================ */

/**
 * 头像组件：只输出状态类名与 SVG，不参与布局。
 *
 * 无障碍语义：传 `title`（如「待命」「Lattice AI」）时容器是 `role="img"`，
 * 可访问名称为「<title> · Lattice AI」；不传时等同装饰，整块 `aria-hidden`，
 * 避免列表/八宫格里重复朗读。
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
  const label = title ? `${title} · Lattice AI` : null;
  const interactive = size !== 'tiny';
  const rootRef = useRef<HTMLSpanElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const headRef = useRef<SVGPathElement>(null);
  const clipRef = useRef<SVGPathElement>(null);
  const eyeRefs = useRef<Array<SVGPathElement | null>>([]);
  const dotRefs = useRef<Array<SVGPathElement | null>>([]);
  const glyphRef = useRef<SVGPathElement>(null);
  const trailRef = useRef<SVGPathElement>(null);
  const clipId = useGlimClipId();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    runGlimEngine({
      svgRef,
      bodyRef,
      headRef,
      clipRef,
      eyeRefs,
      dotRefs,
      glyphRef,
      trailRef,
      stateRef,
      interactive,
    });
    // 引擎与组件生命周期一致；state 经 ref 传入，不触发重启。
  }, []);

  return (
    <span
      ref={rootRef}
      className={`lattice-ai-avatar lattice-ai-avatar--${size} lattice-ai-avatar--${state}${className ? ` ${className}` : ''}`}
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      title={label ?? undefined}
    >
      <svg
        ref={svgRef}
        className={className ? `grok-bot-mark ${className}` : 'grok-bot-mark'}
        data-state={BOT_STATE[state]}
        viewBox="-15 -15 259 259"
        style={{ overflow: 'visible' }}
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clipId}>
            <path ref={clipRef} d={BLOB.path} />
          </clipPath>
        </defs>
        {/* 思考点（thinking）：两个缩小的头部剪影落在头两侧 */}
        <path ref={(el) => { dotRefs.current[0] = el; }} className="grok-bot-mark__head" d={CIRCLE_OUTLINE} style={{ display: 'none' }} />
        <path ref={(el) => { dotRefs.current[1] = el; }} className="grok-bot-mark__head" d={CIRCLE_OUTLINE} style={{ display: 'none' }} />
        <g ref={bodyRef}>
          <path ref={headRef} className="grok-bot-mark__head" d={BLOB.path} />
          <g clipPath={`url(#${clipId})`}>
            <path ref={(el) => { eyeRefs.current[0] = el; }} className="grok-bot-mark__eye" />
            <path ref={(el) => { eyeRefs.current[1] = el; }} className="grok-bot-mark__eye" />
          </g>
        </g>
        {/* writing：绕头书写的铅笔与笔迹 */}
        <path ref={glyphRef} style={{ display: 'none' }} />
        <path ref={trailRef} style={{ display: 'none' }} />
      </svg>
    </span>
  );
}

/** clipPath 唯一 id（SSR 安全的简易 useId 包装）。 */
function useGlimClipId(): string {
  const ref = useRef<string | null>(null);
  if (ref.current === null) {
    ref.current = `glim-clip-${Math.random().toString(36).slice(2, 9)}`;
  }
  return ref.current;
}

/* ============================================================
 * 引擎（上游组件内 rAF 循环的移植）
 * ============================================================ */

interface EngineRefs {
  svgRef: RefObject<SVGSVGElement | null>;
  bodyRef: RefObject<SVGGElement | null>;
  headRef: RefObject<SVGPathElement | null>;
  clipRef: RefObject<SVGPathElement | null>;
  eyeRefs: RefObject<Array<SVGPathElement | null>>;
  dotRefs: RefObject<Array<SVGPathElement | null>>;
  glyphRef: RefObject<SVGPathElement | null>;
  trailRef: RefObject<SVGPathElement | null>;
  stateRef: RefObject<GlimState>;
  interactive: boolean;
}

function runGlimEngine(refs: EngineRefs): () => void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PHYS_DT = 1 / 120;

  /* ---- 弹簧 ---- */
  const morphSpr = makeSpring(1); // 表情过渡进度 0→1
  let morphStiff = 7;
  const tiltSpr = makeSpring(0); // 头部倾角（度）
  const shiftSpr = makeSpring(0); // 身体横移（眼动连带）
  const lidSpr = makeSpring(0); // 眼皮下沉（身体纵移来源）
  const scaleSpr = makeSpring(1); // 整体缩放
  const eyeSizeSpr = makeSpring(1); // 眼尺寸（眨眼=弹到 0.05 再回来）
  const squashSpr = makeSpring(1); // 挤压
  const driftXSpr = makeSpring(0); // 走神注视 X
  const driftYSpr = makeSpring(0); // 走神注视 Y
  const ringOnSpr = makeSpring(0); // 特效在场度
  const ringFadeSpr = makeSpring(1); // 特效切换交叉淡化
  let spin: Spring | null = null; // 庆祝旋转（一次性）

  /* ---- 表情过渡 ---- */
  let exprFrom: readonly [Float64Array, Float64Array] = [EXPRESSIONS[0][0], EXPRESSIONS[0][1]];
  let exprTo: readonly [Float64Array, Float64Array] = exprFrom;
  let curExpr = 0;
  let exprIdx = 0;

  const morphTo = (idx: number, stiff = 7) => {
    if (idx === curExpr && morphSpr.t === 1) return;
    const m = clamp(morphSpr.x, 0, 1);
    exprFrom = [lerpRing(exprFrom[0], exprTo[0], m), lerpRing(exprFrom[1], exprTo[1], m)];
    exprTo = [EXPRESSIONS[idx][0], EXPRESSIONS[idx][1]];
    curExpr = idx;
    morphSpr.x = 0;
    morphSpr.v = 0;
    morphSpr.t = 1;
    morphStiff = stiff;
  };

  /* ---- 节奏计时器（全部以 rAF 时间戳为基准） ---- */
  let lastState: BotState | null = null;
  let switchAt = 0; // 下次表情切换
  let popAt = 0; // 下次眨眼弹出
  let wanderAt = 0; // 下次走神注视
  let winkAt = -1e9; // 眨单眼起点
  let winkEye = 0;
  let winkDue = 0;
  let twitchAt = 0; // angry 抖动
  let twitchT0 = 0;
  let nodAt = 0; // listening 点头
  let nodUntil = 0;
  let celebrateAt = 0; // happy 随机庆祝
  let blinkStart = -1; // 完整眨眼（庆祝反弹）
  let blinkOffset = 0;
  const popQueue: Array<{ at: number; v: number }> = [];

  const schedulePop = (now: number) => {
    popQueue.push(
      { at: now, v: 0.05 },
      { at: now + 70, v: 0.05 },
      { at: now + 150, v: 1.08 },
      { at: now + 300, v: 1 },
    );
    if (Math.random() < 0.14) popQueue.push({ at: now + 370, v: 0.05 }, { at: now + 480, v: 1 });
  };
  const startBlink = () => {
    if (!reduceMotion && blinkStart < 0) blinkStart = performance.now();
  };
  const startSpin = (turns = 1) => {
    if (!spin) spin = { x: 0, v: 0, t: turns * Math.PI * 2 * (Math.random() < 0.5 ? 1 : -1) };
  };

  /* ---- 特效状态 ---- */
  let curEffect: 'dots' | 'pencil' | null = null;
  let prevEffect: 'dots' | 'pencil' | null = null;
  let effectSince = 0;

  /** 共振：特效环周期性「呼吸」的强度。 */
  const resonance = (now: number, phase: number, presence: number) => {
    let a = Math.abs(((((now - effectSince) / 1400 + 0.119) % 1) + 1) % 1 - phase / 3);
    a = Math.min(a, 1 - a);
    const n = reduceMotion ? 1 : Math.exp(-(a * a) / 0.045);
    const s = reduceMotion ? 0 : 1;
    return { lift: 9 * n * presence * s, pop: 1 + s * (0.84 + 0.22 * n - 1), tone: 1 - 0.5 * s * (1 - n) };
  };

  /** 铅笔轨迹相位（2500ms 一轮：写一行 → 提笔返回）。 */
  const pencilPose = (now: number) => {
    const e = now - effectSinceStateStart;
    const r = (((e / 2500) % 1) + 1) % 1;
    if (r < 0.68) {
      const t = r / 0.68;
      const damp = clamp(t / 0.08, 0, 1) * clamp((1 - t) / 0.08, 0, 1);
      return { x: -54 + t * t * (3 - 2 * t) * 118, y: 26, wig: 3.2 * Math.sin(24 * t) * damp, rot: 17 + Math.sin(6e-4 * e), lift: false };
    }
    const t = easeInOutCubic((r - 0.68) / 0.32);
    return { x: 64 - 118 * t, y: 26 - 20 * Math.sin(t * Math.PI), wig: 0, rot: 17 - 2 * Math.sin(t * Math.PI) + Math.sin(6e-4 * e), lift: true };
  };

  /** effectSince 以状态进入时刻为相位基准（与上游 tM 一致）。 */
  let effectSinceStateStart = 0;
  let stateStart = 0;

  /* ---- 指针注视 ---- */
  const gaze = { x: 0, y: 0, tx: 0, ty: 0 };
  let pointer: { x: number; y: number } | null = null;
  let visible = true;
  let rect: DOMRect | null = null;
  let rectAt = -1e9;
  let widthPx = 380;
  let sizeCheckedAt = 0;
  let lastDt = 1 / 60;

  const onPointerMove = (event: PointerEvent) => {
    if (!pointer) pointer = { x: 0, y: 0 };
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  };

  if (refs.interactive) {
    window.addEventListener('pointermove', onPointerMove, { passive: true });
  }
  const observer =
    refs.interactive && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
        })
      : null;
  if (observer && refs.svgRef.current) observer.observe(refs.svgRef.current);

  /* ---- 渲染缓存 ---- */
  let lastViewBox = '';
  let lastHeadKey = '';
  let rafId = 0;

  const pencilTrail: Array<[number, number]> = [];

  const frame = (now: number) => {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min((now - lastTs) / 1000, 0.1);
    lastTs = now;
    lastDt = dt;
    if (!visible) return;

    const eyeEls = refs.eyeRefs.current;
    const dotEls = refs.dotRefs.current;
    if (!eyeEls || !dotEls) return;
    const state = BOT_STATE[refs.stateRef.current ?? 'idle'];
    const tSec = (now - mountAt) / 1000; // 距挂载
    const inState = (now - stateStart) / 1000; // 距进入当前状态

    /* ---- 特效在场与切换 ---- */
    const effect = RING_EFFECT[state] ?? null;
    if (effect !== curEffect) {
      effectSince = now;
      if (effect && curEffect && ringFadeSpr.x > 0.02) {
        prevEffect = curEffect;
        ringFadeSpr.x = 0;
        ringFadeSpr.v = 0;
        ringFadeSpr.t = 1;
      } else {
        prevEffect = null;
        ringFadeSpr.x = 1;
        ringFadeSpr.v = 0;
        ringFadeSpr.t = 1;
      }
      curEffect = effect;
    }
    if (!effect && ringOnSpr.x < 0.004) {
      curEffect = null;
      prevEffect = null;
    }
    if (ringFadeSpr.x > 0.996) prevEffect = null;
    ringOnSpr.t = effect ? 1 : 0;

    /* ---- 行为（reduced-motion 折叠为静态） ---- */
    if (reduceMotion) {
      morphTo(EXPRESSION_POOL[state][0]);
      driftXSpr.t = 0;
      driftYSpr.t = 0;
      tiltSpr.t = 0;
      shiftSpr.t = 0;
      lidSpr.t = 0;
      scaleSpr.t = 1;
      eyeSizeSpr.t = 1;
      squashSpr.t = 1;
    } else {
      /* 状态切换：重置全部节奏计时器并弹一下 */
      if (lastState !== state) {
        lastState = state;
        stateStart = now;
        effectSinceStateStart = now;
        exprIdx = 0;
        switchAt = now + rand(...SWITCH_MS[state]);
        popAt = now + rand(1500, 7000);
        twitchAt = now + rand(500, 1200);
        nodAt = now + rand(1200, 2200);
        nodUntil = 0;
        wanderAt = now + rand(500, 1400);
        winkDue = now + rand(3000, 8000);
        celebrateAt = state === 'happy' ? mountAt + rand(2500, 5000) : Infinity;
        popQueue.length = 0;
        pencilTrail.length = 0;
        if (state !== 'sleeping') {
          schedulePop(now);
          morphTo(EXPRESSION_POOL[state][0], 8);
        }
      }

      /* happy 的随机庆祝：转一圈或眨一下眼 */
      if (now >= celebrateAt) {
        if (state === 'happy' && !spin && blinkStart < 0) {
          if (Math.random() < 0.55) startSpin(1);
          else startBlink();
        }
        celebrateAt = now + rand(9000, 18000);
      }

      /* 逐状态动作目标（正弦组合 + 弹簧平滑 = 有机运动） */
      let eyeScaleLocal = 1;
      let squashLocal = 1;
      switch (state) {
        case 'sleeping': {
          if (EXPRESSION_POOL.sleeping.includes(curExpr)) {
            eyeScaleLocal = morphSpr.x > 0.85 ? 1 : 0.08;
          } else if (inState < 1.2) {
            eyeScaleLocal = Math.max(0.08, 1 - Math.min(1, inState) * (1 + 0.15 * Math.sin(6.5 * inState)));
          } else {
            eyeScaleLocal = 0.08;
            if (eyeSizeSpr.x < 0.18) morphTo(13, 11);
          }
          const settle = Math.min(inState / 2, 1);
          const breath = Math.sin(clamp(inState / 0.5, 0, 1) * Math.PI);
          tiltSpr.t = 4 * settle + 2 * Math.sin(0.25 * tSec);
          shiftSpr.t = -2 * settle;
          lidSpr.t = 8 * settle + 3 * Math.sin(0.55 * tSec) - 5 * breath;
          scaleSpr.t = 1 + 0.016 * Math.sin(0.55 * tSec) + 0.05 * breath;
          break;
        }
        case 'idle':
          tiltSpr.t = 1.5 * Math.sin(0.5 * tSec) + 0.6 * Math.sin(0.17 * tSec);
          shiftSpr.t = Math.sin(0.27 * tSec);
          lidSpr.t = 1.2 * Math.sin(0.85 * tSec);
          scaleSpr.t = 1 + 0.007 * Math.sin(0.85 * tSec);
          break;
        case 'listening':
          tiltSpr.t = 8 + 1.5 * Math.sin(0.5 * tSec);
          shiftSpr.t = 2;
          lidSpr.t = -2 + 0.8 * Math.sin(0.8 * tSec);
          scaleSpr.t = 1.015;
          if (now >= nodAt) {
            nodUntil = now + 380;
            nodAt = now + rand(1800, 3200);
          }
          if (now < nodUntil) {
            const e = 1 - (nodUntil - now) / 380;
            lidSpr.t += 4.5 * Math.sin(e * Math.PI);
            tiltSpr.t += 2 * Math.sin(e * Math.PI);
          }
          break;
        case 'thinking':
          tiltSpr.t = -9 + 5 * Math.sin(0.35 * tSec);
          shiftSpr.t = 5 * Math.sin(0.3 * tSec);
          lidSpr.t = 2.5 * Math.sin(0.6 * tSec);
          scaleSpr.t = 1;
          break;
        case 'happy': {
          const bob = Math.sin(2.4 * tSec);
          tiltSpr.t = 3 * Math.sin(1.2 * tSec);
          shiftSpr.t = 2.5 * Math.sin(1.1 * tSec);
          lidSpr.t = -3 * Math.abs(bob);
          scaleSpr.t = 1 + 0.02 * bob;
          squashLocal = 1.05;
          break;
        }
        case 'celebrate':
          tiltSpr.t = 0;
          shiftSpr.t = 0;
          lidSpr.t = -2.5 * Math.abs(Math.sin(1.6 * tSec));
          scaleSpr.t = 1;
          squashLocal = 1.1;
          eyeScaleLocal = 1.1;
          break;
        case 'angry':
          if (now >= twitchAt) {
            twitchT0 = now + 420;
            lidSpr.v += 70;
            twitchAt = now + rand(1800, 3200);
          }
          tiltSpr.t = now < twitchT0 ? 4.5 * Math.sin(0.05 * now) : 0;
          shiftSpr.t = 0;
          lidSpr.t = 3.5;
          scaleSpr.t = 0.975;
          break;
        default:
          // writing 等特效态：身体归零，戏份全在环与铅笔上
          tiltSpr.t = 0;
          shiftSpr.t = 0;
          lidSpr.t = 0;
          scaleSpr.t = 1;
          break;
      }

      /* 走神注视：每隔一阵随机看一处，避免死盯正前方 */
      if (now >= wanderAt) {
        const sign = () => (Math.random() < 0.5 ? -1 : 1);
        let dx = 0;
        let dy = 0;
        let holdMin = 2500;
        let holdMax = 5000;
        switch (state) {
          case 'idle':
            dx = 0;
            dy = 0;
            holdMin = 2500;
            holdMax = 5500;
            break;
          case 'listening':
            dx = 15 * rand(-0.3, 0.3);
            dy = 9 * rand(-0.25, 0.25);
            holdMin = 2200;
            holdMax = 4200;
            break;
          case 'thinking':
            dx = sign() * rand(0.5, 1) * 15;
            dy = -9 * rand(0.4, 1);
            holdMin = 1500;
            holdMax = 2800;
            break;
          case 'happy':
            dx = 15 * rand(-0.7, 0.7);
            dy = -9 * rand(0, 0.6);
            holdMin = 1800;
            holdMax = 3400;
            break;
          case 'angry':
            dx = 15 * rand(-0.2, 0.2);
            dy = 1.8;
            holdMin = 1800;
            holdMax = 3200;
            break;
          default:
            dx = 15 * rand(-0.4, 0.4);
            dy = 9 * rand(-0.3, 0.3);
            break;
        }
        driftXSpr.t = dx;
        driftYSpr.t = dy;
        wanderAt = now + rand(holdMin, holdMax);
      }

      /* 眨单眼（idle / happy 的小俏皮） */
      if ((state === 'idle' || state === 'happy') && now >= winkDue) {
        winkAt = now;
        winkEye = Math.random() < 0.5 ? 0 : 1;
        winkDue = now + rand(4500, 10000);
      }

      /* 完整眨眼包络（庆祝反弹触发） */
      if (blinkStart >= 0) {
        const e = (now - blinkStart) / 1000;
        if (e >= BLINK_DUR) {
          blinkStart = -1;
          blinkOffset = 0;
        } else {
          let segAt = 0;
          let seg = 0;
          while (seg < BLINK_ENV.length && e >= segAt + BLINK_ENV[seg].d) {
            segAt += BLINK_ENV[seg].d;
            seg++;
          }
          if (seg >= BLINK_ENV.length) {
            blinkOffset = 0;
          } else {
            const { h, d } = BLINK_ENV[seg];
            const n = (e - segAt) / d;
            blinkOffset = -4 * h * n * (1 - n);
          }
        }
      } else {
        blinkOffset = 0;
      }

      /* 表情轮换（sleeping 例外：由它的动作 case 手动切） */
      if (state !== 'sleeping' && now >= switchAt) {
        const pool = EXPRESSION_POOL[state];
        exprIdx = (exprIdx + 1 + Math.floor(rand(0, pool.length - 1))) % pool.length;
        morphTo(pool[exprIdx], 6);
        switchAt = now + rand(...SWITCH_MS[state]);
      }

      /* 眨眼弹出节奏（eP 弹出队列驱动 eyeSizeSpr） */
      const cadence = BLINK_MS[state];
      if (cadence && now >= popAt) {
        schedulePop(now);
        popAt = now + rand(cadence[0], cadence[1]);
      }
      let popValue: number | null = null;
      while (popQueue.length && now >= popQueue[0].at) {
        popValue = popQueue[0].v;
        popQueue.shift();
      }
      eyeSizeSpr.t = popValue ?? (popQueue.length ? eyeSizeSpr.t : eyeScaleLocal);
      squashSpr.t = squashLocal;
    }

    /* ---- 弹簧积分（固定步长子步） ---- */
    const steps = Math.max(1, Math.ceil(dt / PHYS_DT));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      stepSpring(morphSpr, morphStiff, 1, h);
      if (spin) stepSpring(spin, 6.2, 1, h);
      stepSpring(tiltSpr, 5, 0.9, h);
      stepSpring(shiftSpr, 3.5, 1, h);
      stepSpring(lidSpr, 4, 1, h);
      stepSpring(scaleSpr, 10, 0.8, h);
      stepSpring(eyeSizeSpr, 26, 1, h);
      stepSpring(squashSpr, 9, 0.85, h);
      stepSpring(driftXSpr, 13, 1, h);
      stepSpring(driftYSpr, 13, 1, h);
      stepSpring(ringOnSpr, 14, 1, h);
      stepSpring(ringFadeSpr, 11, 1, h);
    }
    if (reduceMotion) {
      ringFadeSpr.x = 1;
      ringOnSpr.x = ringOnSpr.t;
    }

    /* ---- 渲染 ---- */
    const morphT = clamp(morphSpr.x, 0, 1);
    const rings = [
      lerpRing(exprFrom[0], exprTo[0], morphT),
      lerpRing(exprFrom[1], exprTo[1], morphT),
    ];
    const cens = [centroid(rings[0]), centroid(rings[1])];

    let spinVal = 0;
    let spinActive = false;
    if (spin) {
      spinVal = spin.x;
      spinActive = true;
      if (Math.abs(spin.t - spin.x) < 0.004 && Math.abs(spin.v) < 0.015) {
        spin = null;
        spinVal = 0;
        spinActive = false;
      }
    }

    const effectFade = clamp(ringOnSpr.x, 0, 1);
    const crossfade = clamp(ringFadeSpr.x, 0, 1);
    const prevE = crossfade < 0.999 ? prevEffect : null;
    const effectActive = ringOnSpr.x > 0.001;

    const fadeOf = (name: 'dots' | 'pencil' | null): number =>
      name == null
        ? 0
        : name === curEffect
          ? effectFade * crossfade
          : name === prevE
            ? effectFade * (1 - crossfade)
            : 0;

    /* 头部路径：静止 = blob；特效 = blob 环 → 圆环 / 泪滴环 */
    const headFade = clamp(effectFade / 0.62, 0, 1);
    const pencilActive = curEffect === 'pencil' || prevE === 'pencil';
    const targetRing = pencilActive
      ? crossfade >= 0.999
        ? PENCIL_RING
        : lerpRing(prevE === 'pencil' ? PENCIL_RING : CIRCLE_RING, curEffect === 'pencil' ? PENCIL_RING : CIRCLE_RING, easeInOutCubic(crossfade))
      : CIRCLE_RING;
    const headKey = `${headFade.toFixed(3)}|${pencilActive ? 1 : 0}|${crossfade.toFixed(3)}`;
    if (headKey !== lastHeadKey) {
      lastHeadKey = headKey;
      let d: string;
      if (headFade >= 1) {
        d = pencilActive ? ringOutline(targetRing) : CIRCLE_OUTLINE;
      } else if (headFade <= 0) {
        d = BLOB.path;
      } else {
        d = ringOutline(lerpRing(BLOB.ring, targetRing, easeInOutCubic(headFade)));
      }
      refs.headRef.current?.setAttribute('d', d);
      refs.clipRef.current?.setAttribute('d', d);
    }

    /* ---- 眼睛 ---- */
    const face = BLOB.face;
    const top = BLOB.top;
    const bottom = BLOB.bottom;
    const elFactor = (rate: number) => 1 - Math.exp(60 * Math.log(1 - rate) * lastDt);

    // 指针注视目标（±0.6 视野钳制 → ±22/±14px）
    if (pointer && refs.svgRef.current) {
      if (!rect || now - rectAt > 200) {
        rect = refs.svgRef.current.getBoundingClientRect();
        rectAt = now;
      }
      if (rect.width) {
        gaze.tx = 22 * clamp((pointer.x - (rect.left + rect.width / 2)) / rect.width, -0.6, 0.6);
        gaze.ty = 14 * clamp((pointer.y - (rect.top + rect.height / 2)) / rect.height, -0.6, 0.6);
      }
    } else {
      gaze.tx = 0;
      gaze.ty = 0;
    }
    const gazeSmooth = elFactor(0.09);
    gaze.x += (gaze.tx - gaze.x) * gazeSmooth;
    gaze.y += (gaze.ty - gaze.y) * gazeSmooth;
    const driftScale = pointer ? 0.2 : 1;

    let ex0 = 0;
    let ex1 = 0;
    for (let i = 0; i < rings[0].length; i += 2) ex0 = Math.max(ex0, Math.abs(rings[0][i] - cens[0][0]));
    for (let i = 0; i < rings[1].length; i += 2) ex1 = Math.max(ex1, Math.abs(rings[1][i] - cens[1][0]));
    const eyeGap = Math.abs(cens[1][0] - cens[0][0]) * face.sx;
    const sepFactor = ex0 + ex1 > 0.5 ? clamp((eyeGap - 5) / (ex0 + ex1), 0.35, 4) : 4;

    for (let idx = 0; idx < 2; idx++) {
      const eye = eyeEls[idx];
      if (!eye) continue;
      const [cx, cy] = cens[idx];
      let eyeN = Math.max(eyeSizeSpr.x, 0.04);
      // 眨单眼：320ms 内这只眼按包络收缩
      if (idx === winkEye && now < winkAt + 320) {
        const w = (now - winkAt) / 320;
        eyeN = Math.max(eyeN * (w < 0.42 ? 1 - w / 0.42 : (w - 0.42) / 0.58), 0.04);
      }
      eye.setAttribute('d', ringPath(rings[idx]));

      let baseX = HEAD_C + face.x;
      let offX = (cx - HEAD_C) * face.sx;
      let front = true;
      let turnCos = 1;
      let turnBlend = 1;
      let rot: number | null = effectActive ? 0 : null;
      if (spinActive) rot = (rot ?? 0) + spinVal;
      if (rot !== null) {
        // 旋转时把眼睛约束在头的可见半侧
        const [sl, sr] = BLOB.spanAt(clamp(HEAD_C + face.y + (cy - HEAD_C) * face.sy, top + 2, bottom - 2));
        const rr = Math.max((sr - sl) / 2, 12);
        baseX = (sl + sr) / 2;
        const a = Math.asin(clamp(offX / rr, -1, 1));
        const b = a + rot;
        const cosB = Math.cos(b);
        const cosA = Math.max(Math.cos(a), 0.02);
        front = cosB > 0.02;
        turnCos = Math.max(cosB, 0.02) / cosA;
        offX = rr * Math.sin(b);
        turnBlend = smoothstep(clamp(cosB / 0.5, 0, 1));
      }

      const morphPop = 1 + 0.07 * Math.sin(morphT * Math.PI);
      let m = 1.4 * Math.sin(4.2e-4 * now + idx) + 0.5 * Math.sin(0.001 * now + 2 * idx);
      let f = 0.9 * Math.sin(5.8e-4 * now + idx);
      m += gaze.x;
      f += gaze.y;
      m += driftXSpr.x * driftScale;
      f += driftYSpr.x * driftScale;

      const sizeD = Math.min(clamp(squashSpr.x, 0.2, 2) * face.eye, sepFactor / morphPop);
      const scaleX = clamp(turnCos * sizeD * morphPop, 0.02, 2.4);
      const scaleY = clamp(eyeN * sizeD * morphPop, 0.02, 2.4);
      eye.style.display = front && ringOnSpr.x < 0.5 ? '' : 'none';

      // 把眼睛钳制在头部轮廓内（spanAt 查找表）
      const margin = EYE_HALF * scaleY + 2;
      const eyeY = clamp(HEAD_C + face.y + (cy + f - HEAD_C) * face.sy, top + margin, bottom - margin);
      let lo = -Infinity;
      let hi = Infinity;
      const ring = rings[idx];
      for (let i = 0; i < ring.length; i += 4) {
        const ex = (ring[i] - cx) * scaleX;
        const [sl, sr] = BLOB.spanAt(eyeY + (ring[i + 1] - cy) * scaleY);
        if (sl - ex > lo) lo = sl - ex;
        if (sr - ex < hi) hi = sr - ex;
      }
      const wantX = baseX + offX + m * face.sx;
      const clampedX = lo <= hi ? clamp(wantX, lo, hi) : (lo + hi) / 2;
      const eyeX = clampedX + (wantX - clampedX) * (1 - turnBlend);
      eye.setAttribute(
        'transform',
        `translate(${eyeX.toFixed(2)} ${eyeY.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})`,
      );
    }

    /* ---- 环特效 ---- */
    const dotsFade = fadeOf('dots');
    const pencilFade = fadeOf('pencil');
    const res = resonance(now, 1, effectFade);
    const dotsActive = curEffect === 'dots' || prevE === 'dots';
    const popFactor = dotsActive ? 1 + (res.pop - 1) * (dotsFade / Math.max(effectFade, 0.001)) : 1;
    const ringBase = curEffect
      ? RING_SIZE[curEffect] * crossfade + (prevE ? RING_SIZE[prevE] : RING_SIZE[curEffect]) * (1 - crossfade)
      : 19;

    let pencilX = 0;
    let pencilY = 0;
    let pencilRot = 0;

    // 隐藏所有特效节点，再按激活状态重画
    for (const dot of dotEls) dot && (dot.style.display = 'none');
    if (refs.glyphRef.current) refs.glyphRef.current.style.display = 'none';
    if (refs.trailRef.current) refs.trailRef.current.style.display = 'none';

    if (dotsFade > 0.004) {
      for (let i = 0; i < 2; i++) {
        const dot = dotEls[i];
        if (!dot) continue;
        const n = clamp((dotsFade - 0.12 * i) / (1 - 0.12 * i), 0, 1);
        if (n <= 0.004) {
          dot.style.display = 'none';
          continue;
        }
        const s = easeOutCubic(n);
        const l = backOut(n);
        const r = resonance(now, 2 * (i !== 0 ? 1 : 0), dotsFade);
        const scale = ((22 * s * r.pop) / HEAD_C) * 1.02;
        dot.style.display = '';
        dot.setAttribute(
          'transform',
          `translate(${(HEAD_C + (i === 0 ? -62 : 62) * l).toFixed(1)} ${(HEAD_C - r.lift).toFixed(1)}) scale(${scale.toFixed(4)}) translate(${(-HEAD_C).toFixed(1)} ${(-HEAD_C).toFixed(1)})`,
        );
        dot.setAttribute('opacity', (s * r.tone).toFixed(3));
      }
    }

    if (pencilFade > 0.004) {
      const pose = pencilPose(now);
      const glyph = refs.glyphRef.current;
      if (glyph) {
        const rotRad = ((pose.rot - 90) * Math.PI) / 180;
        const dx = 68 * Math.cos(rotRad);
        const dy = 68 * Math.sin(rotRad);
        glyph.style.display = '';
        glyph.setAttribute('d', PENCIL_GLYPH);
        glyph.style.fill = 'var(--glim-fg)';
        glyph.setAttribute(
          'transform',
          `translate(${(HEAD_C + (pose.x + dx) * pencilFade).toFixed(1)} ${(HEAD_C + (pose.y + 0.15 * pose.wig + dy) * pencilFade).toFixed(1)}) rotate(${(pose.rot * pencilFade).toFixed(1)}) scale(${easeOutCubic(pencilFade).toFixed(3)}) translate(${(-HEAD_C).toFixed(1)} ${(-HEAD_C).toFixed(1)})`,
        );
        glyph.setAttribute('opacity', clamp(1.6 * pencilFade - 0.3, 0, 1).toFixed(3));
      }
      // 笔迹：笔尖落纸时记录轨迹点，画平滑曲线
      if (pencilFade > 0.6 && !pose.lift) {
        const px = HEAD_C + pose.x;
        const py = HEAD_C + pose.y + pose.wig + 19;
        const lastPt = pencilTrail[pencilTrail.length - 1];
        if (!lastPt || Math.hypot(px - lastPt[0], py - lastPt[1]) > 2.4) {
          pencilTrail.push([px, py]);
          if (pencilTrail.length > 64) pencilTrail.shift();
        } else if (lastPt) {
          lastPt[0] = px;
          lastPt[1] = py;
        }
      } else if (pencilTrail.length) {
        pencilTrail.splice(0, 2);
      }
      const trail = refs.trailRef.current;
      if (trail) {
        if (pencilTrail.length < 2) {
          trail.style.display = 'none';
        } else {
          trail.style.display = '';
          trail.style.fill = 'none';
          trail.style.stroke = 'var(--glim-fg)';
          trail.setAttribute('stroke-width', '6');
          trail.setAttribute('stroke-linecap', 'round');
          trail.setAttribute('stroke-linejoin', 'round');
          trail.setAttribute('d', catmullRomOpen(pencilTrail));
          trail.setAttribute('opacity', clamp(1.2 * pencilFade, 0, 1).toFixed(3));
        }
      }
      pencilX = pose.x * pencilFade;
      pencilY = (pose.y + 0.5 * pose.wig) * pencilFade;
      pencilRot = pose.rot * pencilFade;
    }

    /* ---- 身体变换 ---- */
    if (refs.bodyRef.current) {
      const t = 1 - effectFade;
      const tx = shiftSpr.x * t + pencilX * effectFade;
      const ty = (lidSpr.x + blinkOffset) * t - res.lift * dotsFade + pencilY * effectFade;
      const rot = tiltSpr.x * t * BLOB.tiltScale + pencilRot * effectFade;
      const t1 = (ringBase / HEAD_C) * popFactor;
      const sx = t + t1 * effectFade;
      const sy = scaleSpr.x * t + t1 * effectFade;
      refs.bodyRef.current.setAttribute(
        'transform',
        `translate(${(HEAD_C + tx).toFixed(2)} ${(HEAD_C + ty).toFixed(2)}) rotate(${rot.toFixed(2)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${(-HEAD_C).toFixed(2)} ${(-HEAD_C).toFixed(2)})`,
      );
      refs.bodyRef.current.style.opacity = (1 - (1 - res.tone) * dotsFade).toFixed(3);
    }

    /* ---- 呼吸缩放（小尺寸下收敛，避免噪点） ---- */
    if (refs.svgRef.current) {
      if (now - sizeCheckedAt > 500) {
        sizeCheckedAt = now;
        const w = refs.svgRef.current.getBoundingClientRect().width;
        if (w > 0) widthPx = w;
      }
      const damp = 1 - smoothstep(clamp((widthPx - 44) / 90, 0, 1));
      const zoomCur = curEffect ? RING_ZOOM[curEffect] : 1;
      const zoomPrev = prevE ? RING_ZOOM[prevE] : zoomCur;
      const half = 129.5 / (1 + (zoomCur * crossfade + zoomPrev * (1 - crossfade) - 1) * effectFade * damp);
      const vb = `${(114.5 - half).toFixed(2)} ${(114.5 - half).toFixed(2)} ${(2 * half).toFixed(2)} ${(2 * half).toFixed(2)}`;
      if (vb !== lastViewBox) {
        lastViewBox = vb;
        refs.svgRef.current.setAttribute('viewBox', vb);
      }
    }
  };

  /** 开放曲线的 Catmull-Rom 平滑（铅笔笔迹）。 */
  function catmullRomOpen(pts: Array<[number, number]>): string {
    const n = pts.length;
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    if (n === 2) return `${d}L${pts[1][0].toFixed(1)} ${pts[1][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, n - 1)];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }

  const mountAt = performance.now();
  let lastTs = mountAt;
  rafId = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('pointermove', onPointerMove);
    observer?.disconnect();
  };
}
