import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeFit, createForceLayout } from '../lib/forceGraph.js';

const MIN_SCALE = 0.25;
const MAX_SCALE = 3.5;
// Showing every title for a medium-sized graph turns the canvas into an unreadable
// block. Larger graphs reveal labels for important nodes and on hover instead.
const LABEL_ALWAYS_LIMIT = 18;
const ALPHA_REHEAT = { drag: 0.5, hover: 0, click: 0.35 };
// 力导向整体收敛很快（125 节点 ≈ 35ms）：开图先在离线状态推进到位再首绘，
// 而不是把 300+ 帧收敛过程逐帧演给用户看（那正是「一卡一卡」的来源）。
// 收敛步数约 366 步且代价 O(n²)，按节点数给足迭代次数；墙钟上限只是超大图的 runaway 兜底。
const LAYOUT_PRECOMPUTE_MAX_TICKS = 600;
const LAYOUT_PRECOMPUTE_BUDGET_MS = 300;
const GRAPH_COLOR_FALLBACKS = {
  edge: '#c9d1da',
  edgeActive: '#4a6cf7',
  node: '#8b95a1',
  nodeActive: '#4a6cf7',
  label: '#3d4653',
  surface: '#ffffff',
};

function readGraphColors(canvas) {
  const styles = getComputedStyle(canvas);
  const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    edge: color('--graph-edge', GRAPH_COLOR_FALLBACKS.edge),
    edgeActive: color('--graph-edge-active', GRAPH_COLOR_FALLBACKS.edgeActive),
    node: color('--graph-node', GRAPH_COLOR_FALLBACKS.node),
    nodeActive: color('--graph-node-active', GRAPH_COLOR_FALLBACKS.nodeActive),
    label: color('--graph-label', GRAPH_COLOR_FALLBACKS.label),
    surface: color('--bg-panel', GRAPH_COLOR_FALLBACKS.surface),
  };
}

/**
 * 关系图谱。
 *
 * 用原生 Canvas 手写渲染与力导向布局，不引入 d3：
 * 需求只有「画点、画线、拖拽、缩放、点击跳转」，
 * 一个图表库带来的体积与抽象成本高于它节省的代码量。
 *
 * 数据流：graph / 容器尺寸变化 → 重建布局 → rAF 循环推进模拟并重绘；
 * alpha 衰减到阈值后自动停帧，避免空闲时持续占用 CPU。
 */
export default function GraphView({
  graph,
  loading,
  activeNoteId,
  onOpenNote,
  onCreateNoteByTitle,
  onRefresh,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const layoutRef = useRef(null);
  const frameRef = useRef(0);
  const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const dragRef = useRef(null);
  const hoverRef = useRef(null);
  const needFitRef = useRef(true);
  const settledRef = useRef(false);
  const colorsRef = useRef(null);
  // 标签宽度缓存：draw 每帧全量重绘，measureText 只需对同一 (字号, 文本) 做一次
  const labelMetricsRef = useRef(new Map());

  const [hovered, setHovered] = useState(null);
  const [settled, setSettled] = useState(false);
  const [danglingOpen, setDanglingOpen] = useState(true);
  const [zoomPercent, setZoomPercent] = useState(100);

  // graph 为 null 时 `?? []` 每次渲染都会产生新数组，会让布局 effect 反复重建，
  // 必须 memo 化以保证引用稳定
  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const edges = useMemo(() => graph?.edges ?? [], [graph]);
  const dangling = useMemo(() => graph?.dangling ?? [], [graph]);

  // 用 ref 持有最新图数据，供 ResizeObserver 回调读取，避免把它加进依赖导致重复重建
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  /** 只在取值真正变化时更新 state，避免每帧都触发一次渲染 */
  const setSettledOnce = useCallback((value) => {
    if (settledRef.current === value) return;
    settledRef.current = value;
    setSettled(value);
  }, []);

  /** 当前打开笔记的邻域，非邻域节点会被淡化 */
  const activeNeighborhood = useMemo(() => {
    if (!activeNoteId) return null;
    const set = new Set([activeNoteId]);
    for (const edge of edges) {
      if (edge.source === activeNoteId) set.add(edge.target);
      if (edge.target === activeNoteId) set.add(edge.source);
    }
    return set;
  }, [activeNoteId, edges]);

  // ── 绘制 ────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return;

    const ctx = canvas.getContext('2d');
    const { width, height } = sizeRef.current;
    if (width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.floor(width * dpr);
    const pixelHeight = Math.floor(height * dpr);

    // 按设备像素比放大后备缓冲，高分屏下文字与线条才不会发虚
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 颜色全部取自 CSS 变量，主题切换时自动跟随
    const colors = colorsRef.current ?? GRAPH_COLOR_FALLBACKS;
    const colorEdge = colors.edge;
    const colorEdgeActive = colors.edgeActive;
    const colorNode = colors.node;
    const colorNodeActive = colors.nodeActive;
    const colorLabel = colors.label;
    const colorSurface = colors.surface;

    const { scale, offsetX, offsetY } = viewRef.current;
    const toScreen = (node) => ({ x: node.x * scale + offsetX, y: node.y * scale + offsetY });
    const focusId = hoverRef.current ?? activeNoteId ?? null;

    // 先画边，让节点覆盖在连线之上
    ctx.lineWidth = 1;
    for (const link of layout.links) {
      const a = toScreen(link.source);
      const b = toScreen(link.target);
      const connected = focusId && (link.source.id === focusId || link.target.id === focusId);

      ctx.strokeStyle = connected ? colorEdgeActive : colorEdge;
      ctx.globalAlpha = connected ? 0.85 : focusId ? 0.22 : 0.55;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const showAllLabels = layout.nodes.length <= LABEL_ALWAYS_LIMIT;
    const occupiedLabels = [];
    // measureText 是逐帧重绘里最贵的一步：同一字号同一文本只量一次
    const labelMetrics = labelMetricsRef.current;
    let currentFontKey = '';

    for (const node of layout.nodes) {
      const point = toScreen(node);
      const isFocus = node.id === focusId;
      const isActive = node.id === activeNoteId;
      const inNeighborhood = !activeNeighborhood || activeNeighborhood.has(node.id);
      const radius = Math.max(2.5, node.radius * scale);

      ctx.globalAlpha = focusId && !isFocus && !inNeighborhood ? 0.28 : 1;

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isFocus || isActive ? colorNodeActive : colorNode;
      ctx.fill();

      if (isFocus || isActive) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = colorSurface;
        ctx.stroke();
      }

      const shouldShowLabel = isFocus || isActive || showAllLabels || node.degree >= 3;
      if (shouldShowLabel) {
        const label = node.title.length > 14 ? `${node.title.slice(0, 14)}…` : node.title;
        const fontSize = Math.max(10, Math.min(14, 11 + scale));
        const fontKey = `${isFocus ? 600 : 400}|${fontSize}`;
        if (fontKey !== currentFontKey) {
          ctx.font = `${isFocus ? 600 : 400} ${fontSize}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
          currentFontKey = fontKey;
        }
        const metricKey = `${fontKey}|${label}`;
        let labelWidth = labelMetrics.get(metricKey);
        if (labelWidth === undefined) {
          labelWidth = Math.min(180, Math.max(24, ctx.measureText(label).width));
          if (labelMetrics.size > 600) labelMetrics.clear();
          labelMetrics.set(metricKey, labelWidth);
        }
        const labelTop = point.y + radius + 3;
        const labelBox = { left: point.x - labelWidth / 2, right: point.x + labelWidth / 2, top: labelTop, bottom: labelTop + fontSize + 4 };
        const collides = occupiedLabels.some((box) => (
          labelBox.left < box.right && labelBox.right > box.left && labelBox.top < box.bottom && labelBox.bottom > box.top
        ));
        if (collides && !isFocus && !isActive) continue;
        occupiedLabels.push(labelBox);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        ctx.globalAlpha = focusId && !isFocus && !inNeighborhood ? 0.3 : 0.95;
        // 先描白边再填字，避免标签压在连线上读不清
        ctx.lineWidth = 3;
        ctx.strokeStyle = colorSurface;
        ctx.strokeText(label, point.x, labelTop);
        ctx.fillStyle = colorLabel;
        ctx.fillText(label, point.x, labelTop);
      }
    }

    ctx.globalAlpha = 1;
  }, [activeNoteId, activeNeighborhood]);

  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const refreshColors = () => {
      colorsRef.current = readGraphColors(canvas);
      drawRef.current();
    };
    refreshColors();
    if (typeof globalThis.MutationObserver !== 'function') return undefined;
    const observer = new MutationObserver(refreshColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => observer.disconnect();
  }, []);

  // ── 视图适配 ────────────────────────────────────────────────
  const applyFit = useCallback(() => {
    const layout = layoutRef.current;
    if (!layout || sizeRef.current.width === 0) return;
    viewRef.current = { ...computeFit(layout.nodes, sizeRef.current) };
  }, []);

  // ── 模拟 + 重绘循环 ─────────────────────────────────────────
  const startLoop = useCallback(() => {
    setSettledOnce(false);
    if (frameRef.current) return;

    const tick = () => {
      const layout = layoutRef.current;
      if (!layout) {
        frameRef.current = 0;
        return;
      }

      const stillMoving = layout.step();

      // 等节点散开一点再适配视图，否则会贴着初始的紧凑布局缩放
      if (needFitRef.current && layout.alpha < 0.08) {
        applyFit();
        setZoomPercent(Math.round(viewRef.current.scale * 100));
        needFitRef.current = false;
      }

      draw();

      if (stillMoving || dragRef.current) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        frameRef.current = 0;
        setSettledOnce(true);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
  }, [applyFit, draw, setSettledOnce]);

  /** 尺寸或数据变化时重建布局。两个触发源共用，避免首帧宽高为 0 导致布局永不建立。 */
  const rebuildLayout = useCallback(
    (sourceNodes, sourceEdges) => {
      const { width, height } = sizeRef.current;
      if (width === 0 || height === 0) return;

      const layout = createForceLayout(sourceNodes, sourceEdges, { width, height });
      // 离线推进到收敛（或预算用尽）再首绘：图谱打开即是排好的布局。
      // 步数按节点数给足（收敛约需 366 步、每步 O(n²)），墙钟只是兜底——
      // 用墙钟当主预算会在页面繁忙时推不满，退化成肉眼可见的慢速蠕动。
      const maxTicks = Math.min(
        LAYOUT_PRECOMPUTE_MAX_TICKS,
        Math.max(60, Math.round(12_000_000 / Math.max(1, sourceNodes.length * sourceNodes.length))),
      );
      const deadline = performance.now() + LAYOUT_PRECOMPUTE_BUDGET_MS;
      let convergedOffline = true;
      for (let tick = 0; tick < maxTicks; tick += 1) {
        if (performance.now() >= deadline || !layout.step()) break;
        convergedOffline = false;
      }
      layoutRef.current = layout;

      needFitRef.current = false;
      applyFit();
      setZoomPercent(Math.round(viewRef.current.scale * 100));
      draw();
      setSettledOnce(convergedOffline);
      if (!convergedOffline) startLoop();
    },
    [applyFit, draw, setSettledOnce, startLoop],
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;

    const measure = () => {
      const rect = wrap.getBoundingClientRect();
      const next = { width: Math.floor(rect.width), height: Math.floor(rect.height) };
      const changed = next.width !== sizeRef.current.width || next.height !== sizeRef.current.height;
      sizeRef.current = next;
      if (changed) rebuildLayout(nodesRef.current, edgesRef.current);
    };

    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    measure();

    return () => observer.disconnect();
  }, [rebuildLayout]);

  useEffect(() => {
    rebuildLayout(nodes, edges);
    // frameRef 必须归零：只 cancel 不清零的话，startLoop 会误以为循环还在跑而拒绝重启
    return () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [nodes, edges, rebuildLayout]);

  // ── 交互 ────────────────────────────────────────────────────
  const worldFromEvent = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const { scale, offsetX, offsetY } = viewRef.current;
    return {
      screenX: event.clientX - rect.left,
      screenY: event.clientY - rect.top,
      worldX: (event.clientX - rect.left - offsetX) / scale,
      worldY: (event.clientY - rect.top - offsetY) / scale,
    };
  };

  const findNodeAt = (screenX, screenY) => {
    const layout = layoutRef.current;
    if (!layout) return null;

    const { scale, offsetX, offsetY } = viewRef.current;
    // 反向遍历：后绘制的节点视觉上更靠前，优先命中
    for (let index = layout.nodes.length - 1; index >= 0; index -= 1) {
      const node = layout.nodes[index];
      const x = node.x * scale + offsetX;
      const y = node.y * scale + offsetY;
      if (Math.hypot(screenX - x, screenY - y) <= Math.max(6, node.radius * scale)) return node;
    }
    return null;
  };

  const handlePointerDown = (event) => {
    const { screenX, screenY, worldX, worldY } = worldFromEvent(event);
    const node = findNodeAt(screenX, screenY);

    if (node) {
      node.fixed = true;
      dragRef.current = { kind: 'node', node, moved: false, startX: screenX, startY: screenY, worldX, worldY };
    } else {
      dragRef.current = {
        kind: 'pan',
        startX: screenX,
        startY: screenY,
        originX: viewRef.current.offsetX,
        originY: viewRef.current.offsetY,
      };
    }

    event.currentTarget.setPointerCapture?.(event.pointerId);
    layoutRef.current?.reheat(ALPHA_REHEAT.drag);
    startLoop();
  };

  const handlePointerMove = (event) => {
    const { screenX, screenY, worldX, worldY } = worldFromEvent(event);
    const drag = dragRef.current;

    if (!drag) {
      const node = findNodeAt(screenX, screenY);
      const nextId = node?.id ?? null;
      if (hoverRef.current !== nextId) {
        hoverRef.current = nextId;
        setHovered(node ? { id: node.id, title: node.title, degree: node.degree, wordCount: node.wordCount } : null);
        draw();
      }
      return;
    }

    if (drag.kind === 'node') {
      drag.node.x = worldX;
      drag.node.y = worldY;
      drag.node.vx = 0;
      drag.node.vy = 0;
      if (Math.hypot(screenX - drag.startX, screenY - drag.startY) > 3) drag.moved = true;
      layoutRef.current?.reheat(ALPHA_REHEAT.click);
    } else {
      viewRef.current.offsetX = drag.originX + (screenX - drag.startX);
      viewRef.current.offsetY = drag.originY + (screenY - drag.startY);
    }

    startLoop();
  };

  const handlePointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (drag?.kind === 'node') {
      drag.node.fixed = false;
      // 没有明显位移就当作点击 → 打开这篇笔记
      if (!drag.moved) onOpenNote(drag.node.id);
    }

    layoutRef.current?.reheat(0.25);
    startLoop();
  };

  // 指针滑出画布只终止拖拽，不触发"点击打开"语义
  const handlePointerLeave = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag?.kind === 'node') drag.node.fixed = false;
    layoutRef.current?.reheat(0.25);
    startLoop();
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const view = viewRef.current;

    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));

    // 以指针位置为锚点缩放，视觉上更自然
    view.offsetX = pointerX - ((pointerX - view.offsetX) / view.scale) * nextScale;
    view.offsetY = pointerY - ((pointerY - view.offsetY) / view.scale) * nextScale;
    view.scale = nextScale;
    setZoomPercent(Math.round(nextScale * 100));

    draw();
  };

  // React 的 onWheel 是被动监听，preventDefault 不生效（Ctrl+滚轮会连页面一起缩放）；
  // 改挂原生 wheel 监听并声明 passive: false
  const handleWheelRef = useRef(handleWheel);
  useEffect(() => {
    handleWheelRef.current = handleWheel;
  });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handler = (event) => handleWheelRef.current(event);
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, []);

  const resetView = () => {
    layoutRef.current?.reheat(0.7);
    needFitRef.current = true;
    startLoop();
  };

  const stats = graph?.stats;

  return (
    <section className="graph" aria-label="关系图谱">
      <div className="graph__toolbar">
        <div className="graph__stats">
          <span><strong>{stats?.nodeCount ?? 0}</strong> 节点</span>
          <span><strong>{stats?.edgeCount ?? 0}</strong> 连线</span>
          <span><strong>{stats?.isolatedCount ?? 0}</strong> 孤立</span>
          {dangling.length ? <span className="graph__warn"><strong>{dangling.length}</strong> 悬空引用</span> : null}
        </div>

        <div className="graph__actions">
          <span className="graph__zoom" aria-label={`当前缩放 ${zoomPercent}%`}>{zoomPercent}%</span>
          <span className="graph__legend" aria-label="图谱图例">
            <span><i className="graph__legend-dot graph__legend-dot--active" />当前/聚焦</span>
            <span><i className="graph__legend-dot" />普通节点</span>
          </span>
          <span className="graph__hint">拖动节点 · 滚轮缩放 · 点击打开</span>
          <button type="button" className="btn btn--sm" onClick={resetView}>重置视图</button>
          <button type="button" className="btn btn--sm" onClick={onRefresh} disabled={loading}>
            {loading ? '刷新中…' : '刷新图谱'}
          </button>
        </div>
      </div>

      <div className="graph__canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="graph__canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
        />

        {loading && !graph ? <div className="graph__overlay">正在加载图谱…</div> : null}

        {hovered ? (
          <div className="graph__tooltip">
            <strong>{hovered.title}</strong>
            <span>{hovered.degree} 条关联 · {hovered.wordCount} 字</span>
          </div>
        ) : null}

        {settled && nodes.length > 0 && nodes.length <= 3 ? (
          <div className="graph__tip">
            在笔记正文里写 <code>[[另一篇笔记的标题]]</code>，图谱就会连起来。
          </div>
        ) : null}

        {dangling.length ? (
          <div className={`graph__dangling ${danglingOpen ? 'is-open' : 'is-collapsed'}`}>
            <button
              type="button"
              className="graph__dangling-toggle"
              aria-expanded={danglingOpen}
              onClick={() => setDanglingOpen((current) => !current)}
            >
              <span className="graph__dangling-title">悬空引用 <strong>{dangling.length}</strong></span>
              <span aria-hidden="true">{danglingOpen ? '收起' : '展开'}</span>
            </button>
            {danglingOpen ? (
              <ul>
                {dangling.slice(0, 8).map((item) => (
                  <li key={item.targetTitle}>
                    <button
                      type="button"
                      title="点击创建这篇笔记"
                      onClick={() => onCreateNoteByTitle(item.targetTitle)}
                    >
                      <span>{item.targetTitle}</span>
                      <span className="graph__dangling-count">×{item.referenceCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
