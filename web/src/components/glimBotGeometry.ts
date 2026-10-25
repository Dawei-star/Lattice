/**
 * Glim 几何工具 —— 移植自 Reproduce-grok-bot-icon
 * <https://github.com/sheng-yh/Reproduce-grok-bot-icon> 的 src/shapes-module.js。
 * 上游是对 x.ai/bot 交互图标的忠实复刻（美术版权归 xAI，仅学习参考）。
 *
 * 这一层回答「图标长什么样」：头部轮廓与眼睛表情都是「点环」而非静态路径，
 * 引擎（GlimMascot.tsx）每帧对点环插值后重新生成路径，才有液体般的形变。
 * 移植时保留了上游的算法结构（路径采样 → 光线投射成环 → 跨度查找表 →
 * 眼位暴力搜索），变量改成了可读名字。
 */

export const HEAD_C = 114.2705;
export const EYE_HALF = 21;

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(100 * v) / 100;

/**
 * 点环：扁平坐标数组 [x0, y0, x1, y1, …]。
 * 两个等长点环按点插值 —— 表情之间「融化」过渡的唯一来源。
 */
export function lerpRing(a: Float64Array, b: Float64Array, t: number): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/** 点环质心（作为眼睛的摆放锚点）。 */
export function centroid(ring: Float64Array): [number, number] {
  let x = 0;
  let y = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i];
    y += ring[i + 1];
  }
  return [x / n, y / n];
}

/** 点环 → 直线多边形路径。48 个采样点在渲染尺寸下视觉即平滑。 */
export function ringPath(ring: Float64Array): string {
  let d = `M${ring[0].toFixed(2)} ${ring[1].toFixed(2)}`;
  for (let i = 2; i < ring.length; i += 2) {
    d += `L${ring[i].toFixed(2)} ${ring[i + 1].toFixed(2)}`;
  }
  return `${d}Z`;
}

/** 点环 → Catmull-Rom 平滑闭合贝塞尔（头部轮廓用，保证外缘圆润）。 */
export function ringOutline(ring: Float64Array): string {
  const n = ring.length / 2;
  const px = (i: number) => ring[((i % n) + n) % n * 2];
  const py = (i: number) => ring[((i % n) + n) % n * 2 + 1];
  let d = `M${round2(px(0))} ${round2(py(0))}`;
  for (let i = 0; i < n; i++) {
    const x0 = px(i - 1);
    const y0 = py(i - 1);
    const x1 = px(i);
    const y1 = py(i);
    const x2 = px(i + 1);
    const y2 = py(i + 1);
    const x3 = px(i + 2);
    const y3 = py(i + 2);
    d += `C${round2(x1 + (x2 - x0) / 6)} ${round2(y1 + (y2 - y0) / 6)} ${round2(x2 - (x3 - x1) / 6)} ${round2(y2 - (y3 - y1) / 6)} ${round2(x2)} ${round2(y2)}`;
  }
  return `${d}Z`;
}

/**
 * 路径采样：把 M/L/Q/C/Z 绝对坐标路径切成折线点列，曲线按弧长细分
 * （每 ~4px 一个点），后续所有几何都基于这份点列。
 */
function samplePath(path: string, step = 4): Array<[number, number]> {
  const tokens = path.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const pts: Array<[number, number]> = [];
  let k = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => parseFloat(tokens[k++]);
  const emit = (fn: (t: number) => [number, number], len: number) => {
    const segs = Math.max(2, Math.ceil(len / step));
    for (let s = 1; s <= segs; s++) pts.push(fn(s / segs));
  };
  while (k < tokens.length) {
    if (/[a-z]/i.test(tokens[k])) cmd = tokens[k++].toUpperCase();
    if ('Z' === cmd) {
      if (Math.hypot(sx - x, sy - y) > 0.01) {
        emit((t) => [x + (sx - x) * t, y + (sy - y) * t], Math.hypot(sx - x, sy - y));
        x = sx;
        y = sy;
      }
      continue;
    }
    if (k >= tokens.length) break;
    if ('M' === cmd) {
      x = num();
      y = num();
      sx = x;
      sy = y;
      pts.push([x, y]);
      cmd = 'L';
    } else if ('L' === cmd) {
      const nx = num();
      const ny = num();
      emit((t) => [x + (nx - x) * t, y + (ny - y) * t], Math.hypot(nx - x, ny - y));
      x = nx;
      y = ny;
    } else if ('Q' === cmd) {
      const qx = num();
      const qy = num();
      const nx = num();
      const ny = num();
      const ox = x;
      const oy = y;
      emit(
        (t) => {
          const s = 1 - t;
          return [
            s * s * ox + 2 * s * t * qx + t * t * nx,
            s * s * oy + 2 * s * t * qy + t * t * ny,
          ];
        },
        Math.hypot(qx - x, qy - y) + Math.hypot(nx - qx, ny - qy),
      );
      x = nx;
      y = ny;
    } else if ('C' === cmd) {
      const c1x = num();
      const c1y = num();
      const c2x = num();
      const c2y = num();
      const nx = num();
      const ny = num();
      const ox = x;
      const oy = y;
      emit(
        (t) => {
          const s = 1 - t;
          return [
            s * s * s * ox + 3 * s * s * t * c1x + 3 * s * t * t * c2x + t * t * t * nx,
            s * s * s * oy + 3 * s * s * t * c1y + 3 * s * t * t * c2y + t * t * t * ny,
          ];
        },
        Math.hypot(c1x - x, c1y - y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(nx - c2x, ny - c2y),
      );
      x = nx;
      y = ny;
    } else {
      k++;
    }
  }
  return pts;
}

/**
 * 微型路径构建器（只实现 teardrop 需要的命令：move/line/curve/corner/arc/close）。
 * corner = 直线进 + 二次贝塞尔圆角；arc = 立方贝塞尔逼近的椭圆弧。
 */
class PathBuilder {
  d = '';
  x = 0;
  y = 0;
  move(x: number, y: number) {
    this.d += `M${round2(x)} ${round2(y)}`;
    this.x = x;
    this.y = y;
    return this;
  }
  line(x: number, y: number) {
    this.d += `L${round2(x)} ${round2(y)}`;
    this.x = x;
    this.y = y;
    return this;
  }
  curve(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
    this.d += `C${round2(c1x)} ${round2(c1y)} ${round2(c2x)} ${round2(c2y)} ${round2(x)} ${round2(y)}`;
    this.x = x;
    this.y = y;
    return this;
  }
  corner(prev: [number, number], at: [number, number], next: [number, number], r: number) {
    const dir = (a: [number, number], b: [number, number]): [number, number] => {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const len = Math.hypot(dx, dy) || 1;
      return [dx / len, dy / len];
    };
    const d1 = dir(prev, at);
    const d2 = dir(next, at);
    const p1: [number, number] = [at[0] + d1[0] * r, at[1] + d1[1] * r];
    const p2: [number, number] = [at[0] + d2[0] * r, at[1] + d2[1] * r];
    if (this.d) this.line(p1[0], p1[1]);
    else this.move(p1[0], p1[1]);
    this.d += `Q${round2(at[0])} ${round2(at[1])} ${round2(p2[0])} ${round2(p2[1])}`;
    this.x = p2[0];
    this.y = p2[1];
    return this;
  }
  arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number) {
    const segs = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 2)));
    const step = (to - from) / segs;
    const k = (4 / 3) * Math.tan(step / 2);
    let a = from;
    for (let s = 0; s < segs; s++) {
      const b = a + step;
      const p1: [number, number] = [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
      const p2: [number, number] = [cx + rx * Math.cos(b), cy + ry * Math.sin(b)];
      this.curve(
        p1[0] - k * rx * Math.sin(a),
        p1[1] + k * ry * Math.cos(a),
        p2[0] + k * rx * Math.sin(b),
        p2[1] - k * ry * Math.cos(b),
        p2[0],
        p2[1],
      );
      a = b;
    }
    return this;
  }
  close() {
    return `${this.d}Z`;
  }
}

/**
 * 归一化：把任意路径居中到 HEAD_C 并缩放到 ~228px 视野（0.9..1.35 钳制）。
 * 与上游一致：直接对路径字符串里的数字做奇偶交替 x/y 平移缩放。
 */
function normalizePath(path: string): string {
  const pts = samplePath(path);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [px, py] of pts) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const dx = HEAD_C - (minX + maxX) / 2;
  const dy = HEAD_C - (minY + maxY) / 2;
  const scale = clamp(228.44 / Math.max(maxX - minX, maxY - minY), 0.9, 1.35);
  if (Math.abs(scale - 1) < 0.005 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return path;
  let alt = 0;
  return path.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (raw) => {
    alt ^= 1;
    const shift = alt ? dx : dy;
    return String(round2(HEAD_C + (parseFloat(raw) + shift - HEAD_C) * scale));
  });
}

export interface Shape {
  /** 归一化后的静态路径（静止时的头部外形）。 */
  path: string;
  /** 96 点可插值轮廓（特效把头部「吹」成圆环 / 泪滴环时使用）。 */
  ring: Float64Array;
  top: number;
  bottom: number;
  /** 头部在高度 y 处的内缘 [left, right]，用于把眼睛钳制在轮廓内。 */
  spanAt: (y: number) => [number, number];
  /** 同上，但到外缘（含凸出部分）。 */
  outerAt: (y: number) => [number, number];
  radius: number;
  beltRadius: number;
  tiltScale: number;
  /** 眼睛的最佳摆放（相对中心的偏移与缩放）。 */
  face: { x: number; y: number; sx: number; sy: number; eye: number };
}

/**
 * 形状构建器（上游 E() 的移植）：从路径生成引擎运行时需要的全部预计算。
 * 眼位搜索在「尽量贴近中心」的前提下最大化眼睛面积 —— 决定了这枚图标
 * 五官的位置感。
 */
export function buildShape(rawPath: string): Shape {
  const path = normalizePath(rawPath);
  const pts = samplePath(path);

  // 半径（离中心最远点）
  let radius = 0;
  for (const [px, py] of pts) radius = Math.max(radius, Math.hypot(px - HEAD_C, py - HEAD_C));

  // 垂直跨度 + 水平跨度查找表（160 档，双线性插值）
  const BINS = 160;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [, py] of pts) {
    if (py < top) top = py;
    if (py > bottom) bottom = py;
  }
  const height = bottom - top;
  const yAt = (bin: number) => top + (height * (bin + 0.5)) / BINS;
  const innerL = new Float64Array(BINS);
  const innerR = new Float64Array(BINS);
  const outerL = new Float64Array(BINS);
  const outerR = new Float64Array(BINS);
  for (let bin = 0; bin < BINS; bin++) {
    const yy = yAt(bin);
    let li = -Infinity;
    let ri = Infinity;
    let lo = Infinity;
    let ro = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (a[1] <= yy === b[1] <= yy) continue;
      const xx = a[0] + ((b[0] - a[0]) * (yy - a[1])) / (b[1] - a[1]);
      if (xx <= HEAD_C ? xx > li : xx < ri) {
        if (xx <= HEAD_C) li = xx;
        else ri = xx;
      }
      if (xx < lo) lo = xx;
      if (xx > ro) ro = xx;
    }
    innerL[bin] = Number.isFinite(li) ? li : HEAD_C;
    innerR[bin] = Number.isFinite(ri) ? ri : HEAD_C;
    outerL[bin] = Number.isFinite(lo) ? lo : HEAD_C;
    outerR[bin] = Number.isFinite(ro) ? ro : HEAD_C;
  }
  const tableLookup = (lo: Float64Array, hi: Float64Array) => (y: number): [number, number] => {
    const pos = clamp(((y - top) / height) * BINS - 0.5, 0, BINS - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    const j = Math.min(i + 1, BINS - 1);
    return [lo[i] + (lo[j] - lo[i]) * f, hi[i] + (hi[j] - hi[i]) * f];
  };
  const spanAt = tableLookup(innerL, innerR);
  const outerAt = tableLookup(outerL, outerR);

  // 96 点环：沿 96 个方向对轮廓做光线投射
  const RING_N = 96;
  const ring = new Float64Array(RING_N * 2);
  for (let i = 0; i < RING_N; i++) {
    const ang = (i / RING_N) * TAU;
    const cx = Math.cos(ang);
    const cy = Math.sin(ang);
    let far = 0;
    for (let j = 0; j < pts.length; j++) {
      const a = pts[j];
      const b = pts[(j + 1) % pts.length];
      const ax = a[0] - HEAD_C;
      const ay = a[1] - HEAD_C;
      const bx = b[0] - HEAD_C;
      const by = b[1] - HEAD_C;
      const denom = (bx - ax) * cy - (by - ay) * cx;
      if (Math.abs(denom) < 1e-9) continue;
      const tt = -((ax * cy - ay * cx) / denom);
      if (tt < 0 || tt > 1) continue;
      const dist = (ax + (bx - ax) * tt) * cx + (ay + (by - ay) * tt) * cy;
      if (dist > far) far = dist;
    }
    ring[i * 2] = HEAD_C + cx * far;
    ring[i * 2 + 1] = HEAD_C + cy * far;
  }

  // 腰线半径：最宽处的半宽（轨道类特效用）
  let beltRadius = 0;
  for (let y = top; y <= bottom; y += 2) {
    const [l, r] = outerAt(y);
    beltRadius = Math.max(beltRadius, (r - l) / 2);
  }

  // 倾斜敏感度：底缘越「肩宽」的头，旋转时越要压扁
  const widthAt = (y: number) => {
    const [l, r] = outerAt(y);
    return r - l;
  };
  const wide = widthAt(bottom - 9);
  const tiltScale = round2(
    clamp(1 - 1.9 * ((wide < 1 ? 0 : widthAt(bottom - 1) / wide) - 0.36), 0.15, 1),
  );

  // 眼位搜索：粗扫（x∈[98,130] y∈[58,170] 步长 8）+ 以最优解为中心的精扫（步长 2）
  const ASPECTS = [1 / 1.45, 0.8, 1 / 1.12, 1, 1.12, 1.25, 1.45];
  const sparse: Array<[number, number]> = [];
  const sparseStep = Math.max(1, Math.round(pts.length / 110));
  for (let i = 0; i < pts.length; i += sparseStep) sparse.push(pts[i]);
  let best = { score: -1, x: HEAD_C, y: HEAD_C, a: 1, b: 1 };
  const consider = (x: number, y: number, aspect: number) => {
    let minD2 = Infinity;
    for (const [px, py] of sparse) {
      const dx = px - x;
      const dy = (py - y) * aspect;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) minD2 = d2;
    }
    const d = Math.sqrt(minD2);
    const h = d / aspect;
    const score = d * h * (1 - 0.0018 * Math.abs(y - HEAD_C) - 0.004 * Math.abs(x - HEAD_C));
    if (score > best.score) best = { score, x, y, a: d, b: h };
  };
  for (let y = HEAD_C - 56; y <= HEAD_C + 56; y += 8) {
    for (let x = HEAD_C - 16; x <= HEAD_C + 16; x += 8) {
      for (const aspect of ASPECTS) consider(x, y, aspect);
    }
  }
  for (let y = best.y - 8; y <= best.y + 8; y += 2) {
    for (let x = best.x - 8; x <= best.x + 8; x += 2) {
      for (const aspect of ASPECTS) consider(x, y, aspect);
    }
  }
  const face = {
    x: round2(best.x - HEAD_C),
    y: round2(best.y - HEAD_C),
    sx: round2(clamp(best.a / HEAD_C, 0.3, 1)),
    sy: round2(clamp(best.b / HEAD_C, 0.3, 1)),
    eye: round2(clamp((0.7 * Math.min(best.a, best.b) + 0.3 * Math.max(best.a, best.b)) * 1.12, 0.64, 1)),
  };

  return { path, ring, top: round2(top), bottom: round2(bottom), spanAt, outerAt, radius: round2(radius), beltRadius: round2(beltRadius), tiltScale, face };
}

/** 平底圆（环形特效的基准目标环）。 */
export const CIRCLE_RING = (() => {
  const ring = new Float64Array(96 * 2);
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * TAU;
    ring[i * 2] = HEAD_C + HEAD_C * Math.cos(a);
    ring[i * 2 + 1] = HEAD_C + HEAD_C * Math.sin(a);
  }
  return ring;
})();

/**
 * teardrop（泪滴）轮廓 —— writing 状态的头部会朝这个形状收拢，
 * 配合绕头的铅笔轨迹构成「正在写字」的剪影。
 */
export const TEARDROP_PATH = (() => {
  const l = clamp(88 / (140.2705 - (HEAD_C - 114)), -1, 1);
  const n = Math.sqrt(1 - l * l);
  const tipY = HEAD_C - 114;
  const h: [number, number] = [HEAD_C + 88 * n, 140.2705 - 88 * l];
  const s: [number, number] = [HEAD_C - 88 * n, 140.2705 - 88 * l];
  const o = Math.atan2(h[1] - 140.2705, h[0] - HEAD_C);
  return new PathBuilder()
    .corner(h, [HEAD_C, tipY], s, 18)
    .line(s[0], s[1])
    .arc(HEAD_C, 140.2705, 88, 88, Math.PI - o, o)
    .close();
})();

/** 泪滴形状（模块加载时预计算）。 */
export const TEARDROP = buildShape(TEARDROP_PATH);

/**
 * 铅笔环：teardrop 的 96 点环旋转 π —— writing 特效里头部形变的目标环
 * （尖朝上，铅笔画到头顶的感觉）。
 */
export const PENCIL_RING = (() => {
  const src = TEARDROP.ring;
  const n = src.length / 2;
  const half = n / 2;
  const ang = ((half / n) * TAU) as number;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const out = new Float64Array(src.length);
  for (let i = 0; i < n; i++) {
    const j = ((i - half) % n + n) % n;
    const dx = src[j * 2] - HEAD_C;
    const dy = src[j * 2 + 1] - HEAD_C;
    out[i * 2] = HEAD_C + dx * cos - dy * sin;
    out[i * 2 + 1] = HEAD_C + dx * sin + dy * cos;
  }
  return out;
})();
