/**
 * 力导向布局（自研，不引入 d3）。
 *
 * 三种力叠加：
 *   斥力  —— 所有节点两两相斥（库仑定律），防止重叠
 *   弹簧力 —— 有连边的节点互相吸引，边越长拉力越强
 *   向心力 —— 整体轻微向画布中心收拢，避免孤立节点飘出视野
 *
 * 复杂度 O(n²)，对个人知识库（数百到数千节点）足够；若要到万级节点需要换
 * Barnes-Hut 四叉树近似，这里不做过度设计。
 */

const REPULSION = 5200;
const SPRING_LENGTH = 96;
const SPRING_STRENGTH = 0.012;
const CENTER_PULL = 0.006;
const DAMPING = 0.86;
const MAX_VELOCITY = 14;

/**
 * @param {Array<{ id: string, degree?: number }>} nodes
 * @param {Array<{ source: string, target: string }>} edges
 * @param {{ width: number, height: number }} viewport
 */
export function createForceLayout(nodes, edges, viewport) {
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  // 节点越多，初始半径越大，避免开局挤成一团
  const initialRadius = Math.min(viewport.width, viewport.height) * 0.3 * Math.min(1.6, 0.6 + nodes.length / 60);

  const byId = new Map();
  const list = nodes.map((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    const jitter = 0.75 + Math.random() * 0.5;
    const laid = {
      ...node,
      degree: node.degree ?? 0,
      radius: 4 + Math.min(14, Math.sqrt(node.degree ?? 0) * 3.2),
      x: centerX + Math.cos(angle) * initialRadius * jitter,
      y: centerY + Math.sin(angle) * initialRadius * jitter,
      vx: 0,
      vy: 0,
      fixed: false,
    };
    byId.set(node.id, laid);
    return laid;
  });

  const links = edges
    .map((edge) => ({ source: byId.get(edge.source), target: byId.get(edge.target) }))
    .filter((link) => link.source && link.target && link.source !== link.target);

  let alpha = 1;

  function step() {
    if (alpha < 0.004) return false;

    // 斥力：两两相斥
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSquared = dx * dx + dy * dy;

        if (distanceSquared < 0.01) {
          // 完全重合时给一个随机方向推开，否则会出现除零
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          distanceSquared = dx * dx + dy * dy;
        }

        const distance = Math.sqrt(distanceSquared);
        const force = (REPULSION / distanceSquared) * alpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;

        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // 弹簧力：连边互吸
    for (const link of links) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const distance = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
      const displacement = distance - SPRING_LENGTH;
      const force = displacement * SPRING_STRENGTH * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;

      link.source.vx += fx;
      link.source.vy += fy;
      link.target.vx -= fx;
      link.target.vy -= fy;
    }

    // 向心力 + 速度积分
    for (const node of list) {
      if (node.fixed) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }

      node.vx += (centerX - node.x) * CENTER_PULL * alpha;
      node.vy += (centerY - node.y) * CENTER_PULL * alpha;

      node.vx *= DAMPING;
      node.vy *= DAMPING;

      const speed = Math.hypot(node.vx, node.vy);
      if (speed > MAX_VELOCITY) {
        node.vx = (node.vx / speed) * MAX_VELOCITY;
        node.vy = (node.vy / speed) * MAX_VELOCITY;
      }

      node.x += node.vx;
      node.y += node.vy;
    }

    alpha *= 0.985;
    return true;
  }

  return {
    nodes: list,
    links,
    byId,
    step,
    /** 重新加热，用于用户拖拽节点后让布局继续收敛 */
    reheat(value = 0.4) {
      alpha = Math.max(alpha, value);
    },
    get alpha() {
      return alpha;
    },
  };
}

/**
 * 按视口尺寸计算缩放与平移，让图始终完整可见。
 * @param {Array<{x: number, y: number, radius: number}>} nodes
 */
export function computeFit(nodes, viewport, padding = 60) {
  if (nodes.length === 0) return { scale: 1, offsetX: 0, offsetY: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }

  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const scale = Math.min(
    (viewport.width - padding * 2) / graphWidth,
    (viewport.height - padding * 2) / graphHeight,
    1.4,
  );
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  return {
    scale: safeScale,
    offsetX: viewport.width / 2 - ((minX + maxX) / 2) * safeScale,
    offsetY: viewport.height / 2 - ((minY + maxY) / 2) * safeScale,
  };
}
