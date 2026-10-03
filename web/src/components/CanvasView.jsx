import { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import ContextMenu from '../ui/ContextMenu.jsx';
import Modal from '../ui/Modal.jsx';
import { canvasApi } from '../api/canvas.js';
import { vaultAssetsApi, vaultAttachmentsApi, vaultFiles } from '../api/vault-files.js';
import { getClipboardImageFiles } from '../lib/clipboard.js';

const EMPTY_DOCUMENT = { nodes: [], edges: [] };
const NODE_WIDTH = 248;
const NODE_HEIGHT = 140;
// 上下限对齐 Obsidian：导入的画布节点尺寸跨度很大（贴图/大分组常远超 720px）
const MIN_NODE_WIDTH = 40;
const MAX_NODE_WIDTH = 4000;
const MIN_NODE_HEIGHT = 40;
const MAX_NODE_HEIGHT = 4000;
const SNAP_DISTANCE = 10;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
const DRAG_THRESHOLD = 4;
const HISTORY_LIMIT = 100;
const PORT_SIDES = ['top', 'right', 'bottom', 'left'];
const PORT_LABELS = { top: '顶部', right: '右侧', bottom: '底部', left: '左侧' };
// 与服务端 Obsidian 颜色归一化的六种命名色保持一致（"1"红 "2"橙 "3"黄 "4"绿 "5"蓝 "6"紫）
const CARD_COLOR_OPTIONS = [
  { value: 'blue', label: '蓝色' },
  { value: 'green', label: '绿色' },
  { value: 'yellow', label: '黄色' },
  { value: 'red', label: '红色' },
  { value: 'orange', label: '橙色' },
  { value: 'purple', label: '紫色' },
];
const EDGE_STROKE_COLORS = {
  blue: '#7d95d6',
  green: '#65c993',
  yellow: '#e6c05f',
  red: '#ef8b91',
  orange: '#e6a05f',
  purple: '#b085e0',
};

gsap.registerPlugin(useGSAP);

export default function CanvasView({ canvasPath = '画板.canvas', noteIndex = [], activeNoteId, onOpenNote, onCreateNote, blockedPaths }) {
  const [canvasDocument, setCanvasDocument] = useState(EMPTY_DOCUMENT);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [selected, setSelected] = useState([]);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [connection, setConnection] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [alignmentGuides, setAlignmentGuides] = useState([]);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const [resourcePicker, setResourcePicker] = useState(null);
  const [resourcePickerPosition, setResourcePickerPosition] = useState(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [imageAssets, setImageAssets] = useState([]);
  const [imagePickerState, setImagePickerState] = useState('idle');
  const [imagePickerError, setImagePickerError] = useState('');
  const [clipboardState, setClipboardState] = useState('idle');
  const [clipboardError, setClipboardError] = useState('');
  const [saveState, setSaveState] = useState('loading');
  const loadedFromVault = useRef(false);
  const hasLocalChanges = useRef(false);
  const hasAutoFitted = useRef(false);
  const userTouchedView = useRef(false);
  const saveRevision = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const saveTimer = useRef(0);
  const docRef = useRef(canvasDocument);
  const viewRef = useRef(view);
  const isViewGestureRef = useRef(false);
  const panRef = useRef(null);
  const stageRef = useRef(null);
  const worldRef = useRef(null);
  const historyRef = useRef({ undo: [], redo: [] });
  const transactionBaseline = useRef(null);
  const nudgeTimer = useRef(0);
  const dragMovedRef = useRef(false);
  docRef.current = canvasDocument;
  if (!isViewGestureRef.current) viewRef.current = view;

  const { contextSafe } = useGSAP({ scope: stageRef });

  const applyViewTransform = contextSafe((nextView) => {
    const stage = stageRef.current;
    const world = worldRef.current;
    if (!stage || !world) return;

    gsap.set(world, {
      x: nextView.x,
      y: nextView.y,
      scale: nextView.scale,
      overwrite: 'auto',
    });
    gsap.set(stage, {
      '--canvas-scale': nextView.scale,
      '--canvas-x': `${nextView.x}px`,
      '--canvas-y': `${nextView.y}px`,
    });
  });

  const animateViewTransform = contextSafe((nextView) => {
    const stage = stageRef.current;
    const world = worldRef.current;
    if (!stage || !world) return;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    gsap.killTweensOf([world, stage]);
    const timeline = gsap.timeline({
      defaults: {
        duration: reduceMotion ? 0 : 0.22,
        ease: 'power2.out',
        overwrite: 'auto',
      },
    });
    timeline
      .to(world, { x: nextView.x, y: nextView.y, scale: nextView.scale }, 0)
      .to(stage, {
        '--canvas-scale': nextView.scale,
        '--canvas-x': `${nextView.x}px`,
        '--canvas-y': `${nextView.y}px`,
      }, 0);
  });

  const commitView = (nextView, { animate = false } = {}) => {
    viewRef.current = nextView;
    setView(nextView);
    if (animate) animateViewTransform(nextView);
    else applyViewTransform(nextView);
  };

  const updateViewWithoutRender = (nextView) => {
    viewRef.current = nextView;
    applyViewTransform(nextView);
  };

  const syncViewFromDom = () => {
    const world = worldRef.current;
    if (!world) return viewRef.current;
    const nextView = {
      x: Number(gsap.getProperty(world, 'x')) || 0,
      y: Number(gsap.getProperty(world, 'y')) || 0,
      scale: Number(gsap.getProperty(world, 'scale')) || viewRef.current.scale,
    };
    viewRef.current = nextView;
    return nextView;
  };

  useEffect(() => {
    applyViewTransform(viewRef.current);
  }, []);

  const noteById = useMemo(() => new Map(noteIndex.map((note) => [note.id, note])), [noteIndex]);
  const noteBySourcePath = useMemo(
    () => new Map(noteIndex.filter((note) => note.filePath).map((note) => [note.filePath.replace(/\.md$/i, ''), note])),
    [noteIndex],
  );
  const noteByTitle = useMemo(() => new Map(noteIndex.map((note) => [note.title, note])), [noteIndex]);

  // Obsidian 导入的 file 节点只带 file 路径没有 noteId：按路径 / 文件名标题反查本地笔记
  const resolveLinkedNote = (node) => {
    if (node.type !== 'file') return null;
    if (node.noteId) {
      const byId = noteById.get(node.noteId);
      if (byId) return byId;
    }
    const source = typeof node.file === 'string' && node.file ? node.file : (typeof node.path === 'string' ? node.path : '');
    if (source) {
      const byPath = noteBySourcePath.get(source.replace(/\.md$/i, ''));
      if (byPath) return byPath;
      const stem = source.split('/').pop()?.replace(/\.md$/i, '');
      if (stem) {
        const byTitle = noteByTitle.get(stem);
        if (byTitle) return byTitle;
      }
    }
    return null;
  };

  const filteredNotes = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    return (query ? noteIndex.filter((note) => note.title.toLowerCase().includes(query)) : noteIndex).slice(0, 80);
  }, [noteIndex, pickerQuery]);

  const filteredImages = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    return (query ? imageAssets.filter((asset) => asset.path.toLowerCase().includes(query)) : imageAssets).slice(0, 80);
  }, [imageAssets, pickerQuery]);

  useEffect(() => {
    let cancelled = false;
    loadedFromVault.current = false;
    hasLocalChanges.current = false;
    hasAutoFitted.current = false;
    userTouchedView.current = false;
    saveRevision.current += 1;
    historyRef.current = { undo: [], redo: [] };
    setHistoryDepth({ undo: 0, redo: 0 });
    setCanvasDocument(EMPTY_DOCUMENT);
    setSelected([]);
    setSelectedEdge(null);
    setConnection(null);
    setMarquee(null);
    setAlignmentGuides([]);
    setClipboardState('idle');
    setClipboardError('');
    setSaveState('loading');

    canvasApi.get(canvasPath).then((value) => {
      if (cancelled) return;
      setSaveState('saved');
      if (hasLocalChanges.current) {
        setCanvasDocument((current) => ({ ...current }));
      } else {
        setCanvasDocument(normalizeDocument(value));
      }
      loadedFromVault.current = true;
    }).catch(() => {
      // 加载失败必须保持「未从库中加载」状态：若置为已加载，随后的自动保存
      // 会把空文档整体写回服务器，覆盖掉真正的画布内容（新建画布走 200 空文档，不受影响）
      setSaveState('error');
    });

    return () => { cancelled = true; };
  }, [canvasPath]);

  useEffect(() => {
    if (resourcePicker !== 'image') return undefined;
    let cancelled = false;
    setImagePickerState('loading');
    setImagePickerError('');
    vaultAssetsApi.list().then((assets) => {
      if (cancelled) return;
      setImageAssets(Array.isArray(assets) ? assets : []);
      setImagePickerState('ready');
    }).catch((error) => {
      if (cancelled) return;
      setImagePickerState('error');
      setImagePickerError(error?.message ?? '图片列表加载失败，请重试');
    });
    return () => { cancelled = true; };
  }, [resourcePicker]);

  // 自动保存：防抖 500ms，拖拽过程中不逐帧请求。
  // 仅在发生真实本地编辑后保存：加载文档本身引起的状态变化不回写，
  // 否则打开一个不存在的画布（如刚删除后的默认画布）会立刻凭空重建文件；
  // blockedPaths 里的路径刚被删除，挂起的保存不得把它复活。
  useEffect(() => {
    if (!loadedFromVault.current || !hasLocalChanges.current) return undefined;
    if (blockedPaths?.has(canvasPath)) return undefined;
    const timer = window.setTimeout(() => {
      const revision = ++saveRevision.current;
      const snapshot = { ...canvasDocument, version: 1 };
      setSaveState('saving');
      saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
        if (revision !== saveRevision.current) return;
        if (blockedPaths?.has(canvasPath)) return;
        await canvasApi.save(canvasPath, snapshot);
        if (revision === saveRevision.current) setSaveState('saved');
      }).catch(() => {
        if (revision === saveRevision.current) setSaveState('error');
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [canvasDocument, canvasPath, blockedPaths]);

  const applyZoom = (nextScale, anchor) => {
    const stage = stageRef.current;
    const target = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const current = syncViewFromDom();
    if (!stage || !anchor) {
      commitView({ ...current, scale: target }, { animate: true });
      return;
    }
    const rect = stage.getBoundingClientRect();
    const point = { x: anchor.clientX - rect.left, y: anchor.clientY - rect.top };
    const worldPoint = { x: (point.x - current.x) / current.scale, y: (point.y - current.y) / current.scale };
    commitView({ scale: target, x: point.x - worldPoint.x * target, y: point.y - worldPoint.y * target }, { animate: true });
  };

  const centerAnchor = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect ? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 } : null;
  };

  const zoomIn = () => applyZoom(viewRef.current.scale * 1.25, centerAnchor());
  const zoomOut = () => applyZoom(viewRef.current.scale / 1.25, centerAnchor());

  const resetView = () => {
    commitView({ scale: 1, x: 0, y: 0 }, { animate: true });
  };

  const fitView = (nodes = docRef.current.nodes) => {
    const stage = stageRef.current;
    if (!stage || !nodes.length) {
      resetView();
      return;
    }

    const rect = stage.getBoundingClientRect();
    const bounds = getNodeBounds(nodes);
    const padding = 80;
    const scale = clamp(
      Math.min((rect.width - padding * 2) / bounds.width, (rect.height - padding * 2) / bounds.height),
      MIN_SCALE,
      1.35,
    );
    commitView({
      scale,
      x: rect.width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: rect.height / 2 - (bounds.y + bounds.height / 2) * scale,
    }, { animate: true });
  };

  const focusNode = (node = singleSelectedNode()) => {
    const stage = stageRef.current;
    if (!stage || !node) return;
    const rect = stage.getBoundingClientRect();
    const width = getNodeWidth(node);
    const height = getNodeHeight(node);
    const current = syncViewFromDom();
    commitView({
      ...current,
      x: rect.width / 2 - (node.x + width / 2) * current.scale,
      y: rect.height / 2 - (node.y + height / 2) * current.scale,
    }, { animate: true });
  };

  // 触控板手势：双指滚动平移画布，Ctrl/Cmd + 滚轮（捏合）以光标为锚点缩放
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const handleWheel = (event) => {
      event.preventDefault();
      userTouchedView.current = true;
      const unit = event.deltaMode === 1 ? 16 : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = stage.getBoundingClientRect();
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const factor = Math.exp(-clamp(event.deltaY * unit, -120, 120) * 0.0022);
        const current = syncViewFromDom();
        const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
        const worldPoint = { x: (point.x - current.x) / current.scale, y: (point.y - current.y) / current.scale };
        updateViewWithoutRender({ scale, x: point.x - worldPoint.x * scale, y: point.y - worldPoint.y * scale });
        return;
      }
      const current = syncViewFromDom();
      // 部分 Windows 鼠标驱动按住 Shift 仍报纵向增量：转成横向平移
      let deltaX = event.deltaX * unit;
      let deltaY = event.deltaY * unit;
      if (!deltaX && event.shiftKey && deltaY) {
        deltaX = deltaY;
        deltaY = 0;
      }
      updateViewWithoutRender({ ...current, x: current.x - deltaX, y: current.y - deltaY });
    };
    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
  }, []);

  // ── 历史记录（撤销 / 重做）────────────────────────────────
  const bumpHistory = () => {
    setHistoryDepth({ undo: historyRef.current.undo.length, redo: historyRef.current.redo.length });
  };

  const pushPast = (documentSnapshot) => {
    const history = historyRef.current;
    history.undo.push(documentSnapshot);
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
    bumpHistory();
  };

  const startTransaction = () => {
    if (transactionBaseline.current === null) transactionBaseline.current = docRef.current;
  };

  const endTransaction = () => {
    const baseline = transactionBaseline.current;
    transactionBaseline.current = null;
    if (baseline && baseline !== docRef.current) pushPast(baseline);
  };

  const applyChange = (updater, { transaction = false } = {}) => {
    const current = docRef.current;
    const next = typeof updater === 'function' ? updater(current) : updater;
    if (!next || next === current) return;
    if (transaction) {
      startTransaction();
    } else {
      pushPast(current);
    }
    hasLocalChanges.current = true;
    docRef.current = next;
    setCanvasDocument(next);
  };

  const undo = () => {
    const history = historyRef.current;
    const previous = history.undo.pop();
    if (!previous) return;
    history.redo.push(docRef.current);
    docRef.current = previous;
    hasLocalChanges.current = true;
    setCanvasDocument(previous);
    setSelected((current) => current.filter((id) => previous.nodes.some((node) => node.id === id)));
    setSelectedEdge((current) => (current && previous.edges.some((edge) => edge.id === current) ? current : null));
    bumpHistory();
  };

  const redo = () => {
    const history = historyRef.current;
    const next = history.redo.pop();
    if (!next) return;
    history.undo.push(docRef.current);
    docRef.current = next;
    hasLocalChanges.current = true;
    setCanvasDocument(next);
    setSelected((current) => current.filter((id) => next.nodes.some((node) => node.id === id)));
    setSelectedEdge((current) => (current && next.edges.some((edge) => edge.id === current) ? current : null));
    bumpHistory();
  };

  const selectedNode = canvasDocument.nodes.find((node) => node.id === selected[selected.length - 1]) ?? null;
  const activeNode = canvasDocument.nodes.find((node) => node.type === 'file' && node.noteId === activeNoteId) ?? null;
  const canUndo = historyDepth.undo > 0;
  const canRedo = historyDepth.redo > 0;

  // 函数声明：focusNode 的默认参数在调用时求值，需要提升可见
  function singleSelectedNode() {
    if (selected.length !== 1) return null;
    return canvasDocument.nodes.find((node) => node.id === selected[0]) ?? null;
  }

  const selectOnly = (id) => { setSelected([id]); setSelectedEdge(null); };
  const toggleSelect = (id) => {
    setSelectedEdge(null);
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  };
  const selectAll = () => {
    if (!docRef.current.nodes.length) return;
    setSelected(docRef.current.nodes.map((node) => node.id));
    setSelectedEdge(null);
  };
  const clearSelection = () => { setSelected([]); setSelectedEdge(null); };

  // ── 卡片增删改 ────────────────────────────────────────────
  const updateNode = (id, patch, options) => applyChange((current) => ({
    ...current,
    nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node),
  }), options);

  const addText = (position) => {
    const id = createId('text');
    applyChange((current) => ({
      ...current,
      nodes: [...current.nodes, {
        id,
        type: 'text',
        text: '双击编辑这张卡片',
        ...(position ?? getSuggestedPosition(current.nodes.length)),
        color: 'yellow',
      }],
    }));
    setSelected([id]);
  };

  const addNote = (note, position) => {
    if (!note) return;
    const id = `file-${note.id}`;
    applyChange((current) => current.nodes.some((node) => node.id === id)
      ? current
      : {
          ...current,
          nodes: [...current.nodes, {
            id,
            type: 'file',
            noteId: note.id,
            text: note.title,
            ...(position ?? getSuggestedPosition(current.nodes.length)),
            color: 'blue',
          }],
        });
    setSelected([id]);
  };

  const addImage = (asset, position) => {
    if (!asset?.path) return;
    const existing = docRef.current.nodes.find((node) => node.type === 'image' && node.path === asset.path);
    if (existing) {
      setSelected([existing.id]);
      return;
    }
    const id = createId('image');
    applyChange((current) => ({
      ...current,
      nodes: [...current.nodes, {
        id,
        type: 'image',
        path: asset.path,
        text: asset.name ?? asset.path.split('/').pop() ?? '图片',
        ...(position ?? getSuggestedPosition(current.nodes.length)),
        color: 'blue',
      }],
    }));
    setSelected([id]);
  };
  const openResourcePicker = (kind, position) => {
    setPickerQuery('');
    setResourcePickerPosition(position ?? null);
    setResourcePicker(kind);
  };
  const closeResourcePicker = () => {
    setResourcePicker(null);
    setResourcePickerPosition(null);
  };
  const selectNote = (note) => {
    addNote(note, resourcePickerPosition);
    closeResourcePicker();
  };
  const selectImage = (asset) => {
    addImage(asset, resourcePickerPosition);
    closeResourcePicker();
  };
  const setNodeColor = (id, color) => {
    updateNode(id, { color });
    setSelected([id]);
  };
  const getContextNode = (event) => {
    const nodeId = event.target instanceof Element
      ? event.target.closest('[data-canvas-node]')?.dataset.canvasNode
      : null;
    return canvasDocument.nodes.find((node) => node.id === nodeId) ?? selectedNode;
  };
  const deleteNodes = (ids) => {
    const idSet = new Set(ids.filter(Boolean));
    if (!idSet.size) return;
    applyChange((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !idSet.has(node.id)),
      edges: current.edges.filter((edge) => !idSet.has(edge.from) && !idSet.has(edge.to)),
    }));
  };
  const deleteEdge = (edgeId) => {
    if (!edgeId) return;
    applyChange((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== edgeId),
    }));
    setSelectedEdge((current) => (current === edgeId ? null : current));
  };
  const reverseEdge = (edgeId) => {
    applyChange((current) => ({
      ...current,
      edges: current.edges.map((edge) => edge.id === edgeId
        ? { ...edge, from: edge.to, to: edge.from, fromSide: edge.toSide, toSide: edge.fromSide }
        : edge),
    }));
  };

  const handleToolbarCreateNote = async () => {
    const created = await onCreateNote?.();
    if (created?.id) addNote(created);
  };

  // ── 平移 / 框选 ───────────────────────────────────────────
  const startPan = (event) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const current = syncViewFromDom();
    gsap.killTweensOf([worldRef.current, stageRef.current]);
    applyViewTransform(current);
    isViewGestureRef.current = true;
    setIsPanning(true);
    panRef.current = { x: event.clientX, y: event.clientY, view: current };
  };

  const handlePointerDown = (event) => {
    if (event.target.closest('button, textarea, input')) return;
    event.currentTarget.focus();
    if (event.button === 1) {
      event.preventDefault();
      clearSelection();
      startPan(event);
      return;
    }
    if (spaceDown) {
      startPan(event);
      return;
    }
    if (event.button !== 0) return;
    const edgeElement = event.target.closest?.('[data-canvas-edge]');
    if (edgeElement) {
      setSelected([]);
      setSelectedEdge(edgeElement.dataset.canvasEdge);
      return;
    }
    if (event.target.closest('.canvas-card, .canvas-empty')) return;
    clearSelection();
    // 左键空白拖拽默认平移画布（与抓手光标一致）；Shift+拖拽才是框选
    if (event.shiftKey) startMarquee(event);
    else startPan(event);
  };

  const startMarquee = (event) => {
    const origin = pointToWorld(event);
    const base = selected;
    const additive = event.shiftKey;
    let active = false;
    let frame = 0;
    let lastEvent = null;

    const compute = (next) => {
      const point = pointToWorld(next);
      const distance = Math.hypot(point.x - origin.x, point.y - origin.y) * viewRef.current.scale;
      if (!active && distance < DRAG_THRESHOLD) return;
      active = true;
      const rect = normalizeRect(origin, point);
      setMarquee(rect);
      const ids = docRef.current.nodes
        .filter((node) => rectsIntersect(rect, node))
        .map((node) => node.id);
      setSelected(additive ? Array.from(new Set([...base, ...ids])) : ids);
      setSelectedEdge(null);
    };
    const move = (next) => {
      lastEvent = next;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; compute(lastEvent); });
    };
    const finish = () => {
      if (frame) cancelAnimationFrame(frame);
      setMarquee(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const handlePointerMove = (event) => {
    if (!panRef.current) return;
    userTouchedView.current = true;
    const start = panRef.current;
    const nextView = {
      ...start.view,
      x: start.view.x + event.clientX - start.x,
      y: start.view.y + event.clientY - start.y,
    };
    updateViewWithoutRender(nextView);
  };

  const stopPan = () => {
    if (!panRef.current) return;
    const finalView = syncViewFromDom();
    panRef.current = null;
    isViewGestureRef.current = false;
    setIsPanning(false);
    viewRef.current = finalView;
    setView(finalView);
  };

  // ── 卡片拖动（支持多选拖动 + 吸附）────────────────────────
  const moveNode = (event, node) => {
    event.stopPropagation();
    if (event.shiftKey) {
      toggleSelect(node.id);
      return;
    }
    const movingIds = selected.includes(node.id) ? selected : [node.id];
    if (!selected.includes(node.id)) selectOnly(node.id);
    if (spaceDown) return;
    if (event.button !== 0) return;

    startTransaction();
    dragMovedRef.current = false;
    const start = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
    const starts = new Map(movingIds.map((id) => {
      const target = docRef.current.nodes.find((candidate) => candidate.id === id);
      return [id, { x: target?.x ?? 0, y: target?.y ?? 0 }];
    }));
    let frame = 0;
    let lastEvent = null;

    const compute = (next) => {
      const rawDeltaX = (next.clientX - start.x) / viewRef.current.scale;
      const rawDeltaY = (next.clientY - start.y) / viewRef.current.scale;
      if (Math.hypot(next.clientX - start.x, next.clientY - start.y) >= DRAG_THRESHOLD) dragMovedRef.current = true;
      const proposedX = start.nodeX + rawDeltaX;
      const proposedY = start.nodeY + rawDeltaY;
      const snapped = resolveSnapPosition(node, proposedX, proposedY, docRef.current.nodes);
      setAlignmentGuides(snapped.guides);
      applyChange((current) => ({
        ...current,
        nodes: current.nodes.map((candidate) => {
          const origin = starts.get(candidate.id);
          if (!origin) return candidate;
          if (candidate.id === node.id) return { ...candidate, x: snapped.x, y: snapped.y };
          return { ...candidate, x: origin.x + rawDeltaX, y: origin.y + rawDeltaY };
        }),
      }), { transaction: true });
    };
    const move = (next) => {
      lastEvent = next;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; compute(lastEvent); });
    };
    const finish = () => {
      if (frame) cancelAnimationFrame(frame);
      endTransaction();
      setAlignmentGuides([]);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const resizeNode = (event, node) => {
    event.stopPropagation();
    selectOnly(node.id);
    if (spaceDown || event.button !== 0) return;
    startTransaction();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const start = {
      x: event.clientX,
      y: event.clientY,
      width: getNodeWidth(node),
      height: getNodeHeight(node),
    };
    let frame = 0;
    let lastEvent = null;
    const compute = (next) => updateNode(node.id, {
      width: clamp(start.width + (next.clientX - start.x) / viewRef.current.scale, MIN_NODE_WIDTH, MAX_NODE_WIDTH),
      height: clamp(start.height + (next.clientY - start.y) / viewRef.current.scale, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT),
    }, { transaction: true });
    const move = (next) => {
      lastEvent = next;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; compute(lastEvent); });
    };
    const finish = () => {
      if (frame) cancelAnimationFrame(frame);
      endTransaction();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      handle.releasePointerCapture?.(event.pointerId);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const pointToWorld = (point) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const current = viewRef.current;
    return rect
      ? { x: (point.clientX - rect.left - current.x) / current.scale, y: (point.clientY - rect.top - current.y) / current.scale }
      : point;
  };

  const getConnectionTarget = (point, sourceId) => {
    const targetElement = document.elementFromPoint(point.clientX, point.clientY)?.closest('[data-canvas-node]');
    const targetId = targetElement?.dataset.canvasNode;
    if (!targetId || targetId === sourceId) return null;
    const targetNode = docRef.current.nodes.find((node) => node.id === targetId);
    if (!targetNode) return null;
    const worldPoint = pointToWorld(point);
    return { targetId, targetSide: nearestPortSide(targetNode, worldPoint) };
  };

  const beginConnection = (event, node, sourceSide) => {
    if (event.button !== 0 || spaceDown) return;
    event.stopPropagation();
    const sourcePort = event.currentTarget;
    sourcePort.setPointerCapture?.(event.pointerId);
    const start = getPortPosition(node, sourceSide);
    let frame = 0;
    let lastEvent = null;

    const compute = (next) => {
      const target = getConnectionTarget(next, node.id);
      setConnection({
        nodeId: node.id,
        sourceSide,
        start,
        end: pointToWorld(next),
        targetId: target?.targetId ?? null,
        targetSide: target?.targetSide ?? null,
      });
    };
    const move = (next) => {
      lastEvent = next;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; compute(lastEvent); });
    };
    const finish = () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      sourcePort.releasePointerCapture?.(event.pointerId);
    };
    const up = (next) => {
      const target = getConnectionTarget(next, node.id);
      if (target) {
        applyChange((current) => {
          const targetNode = current.nodes.find((candidate) => candidate.id === target.targetId);
          const duplicate = targetNode && current.edges.some((edge) => {
            if (edge.from !== node.id || edge.to !== target.targetId) return false;
            const sides = resolveConnectionSides(edge, node, targetNode);
            return sides.fromSide === sourceSide && sides.toSide === target.targetSide;
          });
          return duplicate
            ? current
            : {
                ...current,
                edges: [...current.edges, {
                  id: createId('edge'),
                  from: node.id,
                  to: target.targetId,
                  fromSide: sourceSide,
                  toSide: target.targetSide,
                }],
              };
        });
      } else {
        // 拖到空白处松开：就地生成一张文本卡片并连接
        const dropPoint = pointToWorld(next);
        const id = createId('text');
        applyChange((current) => ({
          ...current,
          nodes: [...current.nodes, {
            id,
            type: 'text',
            text: '新想法',
            x: dropPoint.x - NODE_WIDTH / 2,
            y: dropPoint.y - NODE_HEIGHT / 2,
            color: 'yellow',
          }],
          edges: [...current.edges, {
            id: createId('edge'),
            from: node.id,
            to: id,
            fromSide: sourceSide,
            toSide: oppositePortSide(sourceSide),
          }],
        }));
        setSelected([id]);
      }
      setConnection(null);
      finish();
    };
    const cancel = () => {
      setConnection(null);
      finish();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const getContextPosition = (event) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const current = viewRef.current;
    return rect
      ? { x: (event.clientX - rect.left - current.x) / current.scale - NODE_WIDTH / 2, y: (event.clientY - rect.top - current.y) / current.scale - NODE_HEIGHT / 2 }
      : undefined;
  };

  const handleClipboardPaste = async (event) => {
    const files = getClipboardImageFiles(event.clipboardData);
    if (!files.length || clipboardState === 'uploading') return;

    event.preventDefault();
    event.stopPropagation();
    const anchor = centerAnchor();
    const position = anchor ? getContextPosition(anchor) : undefined;
    setClipboardError('');
    setClipboardState('uploading');
    try {
      for (const [index, file] of files.entries()) {
        const uploaded = await vaultAttachmentsApi.upload(file);
        addImage(
          { path: uploaded.path, name: uploaded.name ?? file.name },
          position ? { x: position.x + index * 28, y: position.y + index * 28 } : undefined,
        );
      }
      setClipboardState('idle');
    } catch (error) {
      setClipboardState('error');
      setClipboardError(error?.message ?? '图片导入失败');
    }
  };

  // ── 键盘快捷键 ────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (event) => {
      const activeElement = globalThis.document.activeElement;
      // 弹层里的 <select> 与 contentEditable 元素也算"正在编辑"，
      // 否则在设置弹窗里按键会在背后的画布上凭空创建卡片
      const isEditing = activeElement?.tagName === 'TEXTAREA'
        || activeElement?.tagName === 'INPUT'
        || activeElement?.tagName === 'SELECT'
        || activeElement?.isContentEditable === true;
      if (event.key === 'Escape' && connection) {
        event.preventDefault();
        setConnection(null);
        return;
      }
      if (resourcePicker) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z' && !isEditing) {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y' && !isEditing) {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'a' && !isEditing) {
        event.preventDefault();
        selectAll();
        return;
      }
      // 其余单键快捷键不与系统/浏览器组合键抢占
      if (mod) return;
      if (isEditing) return;
      if (event.code === 'Space') {
        const onButton = activeElement?.tagName === 'BUTTON' || activeElement?.tagName === 'SELECT';
        if (!onButton) {
          event.preventDefault();
          setSpaceDown(true);
        }
        return;
      }
      if (event.key === 'Escape') {
        clearSelection();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedEdge) {
          event.preventDefault();
          deleteEdge(selectedEdge);
          return;
        }
        if (selected.length) {
          event.preventDefault();
          deleteNodes(selected);
          setSelected([]);
          return;
        }
      }
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault();
        addText();
        return;
      }
      if (event.key === 'n' || event.key === 'N') {
        if (noteIndex.length) {
          event.preventDefault();
          openResourcePicker('note');
        }
        return;
      }
      if (event.key === 'i' || event.key === 'I') {
        event.preventDefault();
        openResourcePicker('image');
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomIn();
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        zoomOut();
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        applyZoom(1, centerAnchor());
        return;
      }
      const nudgeStep = event.shiftKey ? 16 : 2;
      const nudge = {
        ArrowLeft: { x: -nudgeStep, y: 0 },
        ArrowRight: { x: nudgeStep, y: 0 },
        ArrowUp: { x: 0, y: -nudgeStep },
        ArrowDown: { x: 0, y: nudgeStep },
      }[event.key];
      if (nudge && selected.length) {
        event.preventDefault();
        // 按住方向键连续微调时合并为一次撤销记录，松开 600ms 后结算
        window.clearTimeout(nudgeTimer.current);
        startTransaction();
        applyChange((current) => ({
          ...current,
          nodes: current.nodes.map((node) => selected.includes(node.id)
            ? { ...node, x: node.x + nudge.x, y: node.y + nudge.y }
            : node),
        }), { transaction: true });
        nudgeTimer.current = window.setTimeout(endTransaction, 600);
      }
    };
    const handleKeyUp = (event) => {
      if (event.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  });

  useEffect(() => {
    if (!loadedFromVault.current || hasAutoFitted.current || !canvasDocument.nodes.length) return;
    hasAutoFitted.current = true;
    requestAnimationFrame(() => fitView(canvasDocument.nodes));
  }, [canvasDocument.nodes.length]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !canvasDocument.nodes.length || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      // 用户已手动缩放/平移过视图时，容器 resize 不得覆盖其视图
      if (userTouchedView.current) return;
      fitView(docRef.current.nodes);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [canvasDocument.nodes.length]);

  const stageStatusText = clipboardState === 'uploading'
    ? '正在导入图片…'
    : clipboardState === 'error'
      ? clipboardError
      : alignmentGuides.length
        ? '正在对齐…'
        : connection
          ? '拖到目标卡片后松开；拖到空白处会生成新卡片'
          : saveState === 'loading'
            ? '正在加载画布'
            : saveState === 'saving'
              ? '保存中…'
              : saveState === 'error'
                ? '保存失败'
                : '已保存';
  const stageStatusTone = clipboardState === 'uploading'
    ? 'saving'
    : clipboardState === 'error'
      ? 'error'
      : saveState;

  return (
    <section className="canvas-view" aria-label="画布">
      <header className="canvas-toolbar">
        <div className="canvas-toolbar__title">
          <strong>画布</strong>
          <span className="canvas-toolbar__stats" aria-label={`${canvasDocument.nodes.length} 个对象，${canvasDocument.edges.length} 条连接`}>
            {canvasDocument.nodes.length} 个对象 · {canvasDocument.edges.length} 条连接
          </span>
          <span className="canvas-toolbar__selection" aria-live="polite">
            {selected.length > 1
              ? `已选中 ${selected.length} 个对象`
              : selectedNode
                ? `已选中：${selectedNode.text}`
                : selectedEdge
                  ? '已选中一条连接'
                  : activeNode
                    ? `当前笔记：${activeNode.text}`
                    : '未选择对象'}
          </span>
        </div>
        <div className="canvas-toolbar__actions">
          <div className="canvas-toolbar__actions--primary">
            <button type="button" className="btn" onClick={() => addText()} title="添加文本卡片（T）">＋ 文本卡片</button>
            <button type="button" className="btn" onClick={() => openResourcePicker('note')} disabled={!noteIndex.length} title="选择一篇笔记（N）">⌁ 添加笔记</button>
            <button type="button" className="btn" onClick={() => openResourcePicker('image')} title="选择 Vault 中的图片（I）">▧ 添加图片</button>
            <button type="button" className="btn btn--primary" onClick={handleToolbarCreateNote} title="新建笔记并添加到画布">新建笔记</button>
          </div>
          <span className="canvas-toolbar__divider" />
          <div className="canvas-toolbar__viewtools" aria-label="视图工具">
            <button type="button" className="canvas-tool" onClick={undo} disabled={!canUndo} aria-label="撤销" title="撤销（Ctrl+Z）">↶</button>
            <button type="button" className="canvas-tool" onClick={redo} disabled={!canRedo} aria-label="重做" title="重做（Ctrl+Shift+Z）">↷</button>
            <div className="canvas-zoomctl" role="group" aria-label="缩放">
              <button type="button" className="canvas-tool" onClick={zoomOut} aria-label="缩小" title="缩小（-）">−</button>
              <button type="button" className="canvas-zoom" onClick={() => applyZoom(1, centerAnchor())} title="重置为 100%（0）">
                {Math.round(view.scale * 100)}%
              </button>
              <button type="button" className="canvas-tool" onClick={zoomIn} aria-label="放大" title="放大（+）">＋</button>
            </div>
            <button type="button" className="canvas-tool" onClick={() => fitView()} aria-label="适配全部节点" title="适配全部节点">⌗</button>
            <button type="button" className="canvas-tool" onClick={() => focusNode()} disabled={!selectedNode} aria-label="聚焦选中节点" title="聚焦选中节点">◎</button>
            <button type="button" className="canvas-tool" onClick={resetView} aria-label="重置视图" title="重置视图">⌂</button>
          </div>
        </div>
      </header>

      <ContextMenu
        className="canvas-context"
        label="画布操作"
        getItems={(event) => {
          const position = getContextPosition(event);
          const edgeElement = event.target instanceof Element ? event.target.closest('[data-canvas-edge]') : null;
          if (edgeElement) {
            const edgeId = edgeElement.dataset.canvasEdge;
            setSelectedEdge(edgeId);
            setSelected([]);
            return [
              { label: '反转方向', icon: '⇄', onSelect: () => reverseEdge(edgeId) },
              { label: '删除连接', icon: '×', shortcut: 'Del', onSelect: () => deleteEdge(edgeId) },
            ];
          }
          const contextNode = getContextNode(event);
          const contextColor = contextNode ? normalizeCardColor(contextNode.color) : null;
          const isCompactMenu = (stageRef.current?.clientWidth ?? globalThis.innerWidth) < 720;
          if (contextNode && !selected.includes(contextNode.id)) setSelected([contextNode.id]);
          const colorMenuItems = isCompactMenu && contextNode
            ? CARD_COLOR_OPTIONS.map((option) => ({
                label: option.label,
                icon: contextColor === option.value ? '●' : '○',
                onSelect: () => setNodeColor(contextNode.id, option.value),
              }))
            : [{
                label: '卡片颜色',
                icon: '●',
                disabled: !contextNode,
                submenuItems: CARD_COLOR_OPTIONS.map((option) => ({
                  label: option.label,
                  icon: contextColor === option.value ? '●' : '○',
                  onSelect: () => {
                    if (!contextNode) return;
                    setNodeColor(contextNode.id, option.value);
                  },
                })),
              }];
          return [
            { label: '添加文本', icon: '▱', shortcut: 'T', onSelect: () => addText(position) },
            { label: '添加笔记', icon: '▤', shortcut: 'N', disabled: !noteIndex.length, onSelect: () => openResourcePicker('note', position) },
            { label: '新建笔记', icon: '✎', onSelect: handleToolbarCreateNote },
            { label: '添加图片', icon: '▧', shortcut: 'I', onSelect: () => openResourcePicker('image', position) },
            { label: '创建分组', icon: '▦', disabled: true },
            { separator: true },
            { label: '全选对象', icon: '☑', shortcut: 'Ctrl A', disabled: !canvasDocument.nodes.length, onSelect: selectAll },
            { label: '适配全部节点', icon: '⌗', disabled: !canvasDocument.nodes.length, onSelect: () => fitView() },
            { label: '聚焦选中节点', icon: '◎', disabled: !contextNode, onSelect: () => focusNode(contextNode) },
            ...colorMenuItems,
            { label: selected.length > 1 ? `删除 ${selected.length} 个对象` : contextNode ? '删除此卡片' : '删除选中对象', icon: '×', shortcut: 'Del', disabled: !contextNode && !selected.length, onSelect: () => { deleteNodes(selected.length > 1 ? selected : [contextNode?.id]); setSelected([]); } },
            { separator: true },
            { label: '撤销', icon: '↶', shortcut: 'Ctrl Z', disabled: !canUndo, onSelect: undo },
            { label: '重做', icon: '↷', shortcut: 'Ctrl ⇧ Z', disabled: !canRedo, onSelect: redo },
          ];
        }}
      >
        <div
          ref={stageRef}
          tabIndex={0}
          className={`canvas-stage ${spaceDown || isPanning ? 'is-panning' : ''} ${connection ? 'is-connecting' : ''} ${alignmentGuides.length ? 'is-aligning' : ''} ${marquee ? 'is-marquee' : ''} ${clipboardState === 'uploading' ? 'is-pasting' : ''}`}
          onPointerDown={handlePointerDown}
          onPaste={handleClipboardPaste}
          onDoubleClick={(event) => {
            if (event.target.closest('.canvas-card')) return;
            addText(getContextPosition(event));
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={stopPan}
          onPointerCancel={stopPan}
        >
          <div ref={worldRef} className="canvas-world">
            <div className="canvas-guides" aria-hidden="true">
              {alignmentGuides.map((guide) => (
                <div key={`${guide.axis}-${guide.value}`} className={`canvas-guide canvas-guide--${guide.axis}`} style={guide.axis === 'vertical' ? { left: guide.value } : { top: guide.value }}>
                  <span>对齐</span>
                </div>
              ))}
            </div>
            {marquee ? (
              <div
                className="canvas-marquee"
                aria-hidden="true"
                style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
              />
            ) : null}
            <svg className="canvas-links" aria-hidden="true">
              <defs>
                <marker id="canvas-arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
                  <path className="canvas-arrowhead" d="M 0 0 L 12 6 L 0 12 z" />
                </marker>
                <marker id="canvas-arrow-selected" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
                  <path className="canvas-arrowhead canvas-arrowhead--selected" d="M 0 0 L 12 6 L 0 12 z" />
                </marker>
                <marker id="canvas-arrow-preview" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
                  <path className="canvas-arrowhead canvas-arrowhead--preview" d="M 0 0 L 12 6 L 0 12 z" />
                </marker>
              </defs>
              {canvasDocument.edges.map((edge) => {
                const from = canvasDocument.nodes.find((node) => node.id === edge.from);
                const to = canvasDocument.nodes.find((node) => node.id === edge.to);
                if (!from || !to) return null;
                const sides = resolveConnectionSides(edge, from, to);
                const path = connectionPath(getPortPosition(from, sides.fromSide), getPortPosition(to, sides.toSide), sides.fromSide, sides.toSide);
                const strokeColor = EDGE_STROKE_COLORS[edge.color];
                return (
                  <g key={edge.id} className={`canvas-edge ${selectedEdge === edge.id ? 'is-selected' : ''}`} data-canvas-edge={edge.id}>
                    <path className="canvas-edge__hit" d={path} />
                    <path
                      className="canvas-edge__line"
                      d={path}
                      style={strokeColor ? { stroke: strokeColor } : undefined}
                      markerEnd={selectedEdge === edge.id ? 'url(#canvas-arrow-selected)' : 'url(#canvas-arrow)'}
                    />
                  </g>
                );
              })}
              {connection ? (() => {
                const targetNode = canvasDocument.nodes.find((node) => node.id === connection.targetId);
                const end = targetNode && connection.targetSide
                  ? getPortPosition(targetNode, connection.targetSide)
                  : connection.end;
                return <path className="is-preview" d={connectionPath(connection.start, end, connection.sourceSide, connection.targetSide ?? oppositePortSide(connection.sourceSide))} markerEnd="url(#canvas-arrow-preview)" />;
              })() : null}
            </svg>
            {canvasDocument.nodes.map((node) => {
              const linkedNote = resolveLinkedNote(node);
              const isActive = node.type === 'file' && linkedNote?.id === activeNoteId;
              const color = normalizeCardColor(node.color);
              const displayTitle = linkedNote?.title ?? node.text;
              const isGroup = node.type === 'group';
              const typeLabel = node.type === 'file' ? '笔记卡片' : node.type === 'image' ? '图片卡片' : isGroup ? '分组' : '文本卡片';
              return (
                <article
                  key={node.id}
                  className={`canvas-card canvas-card--${color} ${isGroup ? 'canvas-card--group' : ''} ${selected.includes(node.id) ? 'is-selected' : ''} ${isActive ? 'is-active' : ''} ${connection?.nodeId === node.id ? 'is-connection-source' : ''} ${connection?.targetId === node.id ? 'is-connection-target' : ''}`}
                  style={{ left: node.x, top: node.y, width: getNodeWidth(node), height: getNodeHeight(node) }}
                  data-canvas-node={node.id}
                  tabIndex={0}
                  aria-label={`${typeLabel}：${displayTitle}`}
                  aria-current={isActive ? 'page' : undefined}
                  onPointerDown={(event) => moveNode(event, node)}
                  onClick={(event) => {
                    if (event.shiftKey || dragMovedRef.current) return;
                    selectOnly(node.id);
                    if (node.type === 'file') onOpenNote?.(linkedNote?.id ?? node.noteId);
                  }}
                  onDoubleClick={(event) => {
                    if (event.target.closest('textarea')) return;
                    if (node.type === 'file') onOpenNote?.(linkedNote?.id ?? node.noteId);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' && node.type === 'file') onOpenNote?.(linkedNote?.id ?? node.noteId);
                  }}
                >
                  <div className="canvas-card__handle" aria-hidden="true"><span /><span /><span /></div>
                  <span className="canvas-card__type">{typeLabel}{isActive ? ' · 当前打开' : ''}</span>
                  {node.type === 'text'
                    ? (
                      <textarea
                        value={node.text}
                        onChange={(event) => updateNode(node.id, { text: event.target.value }, { transaction: true })}
                        onFocus={() => startTransaction()}
                        onBlur={() => endTransaction()}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label="编辑画布文本"
                      />
                    )
                    : node.type === 'image'
                      ? <><div className="canvas-card__image" title={node.path}><img src={vaultFiles.assetUrl(node.path)} alt={node.text} draggable="false" onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.nextElementSibling.hidden = false; }} /><span hidden>图片暂不可用</span></div><h3 title={node.path}>{node.text}</h3></>
                      : isGroup
                        ? <h3 className="canvas-card__group-label" title={displayTitle}>{displayTitle}</h3>
                        : <><h3 title={displayTitle}>{displayTitle}</h3><p title={linkedNote?.filePath}>{linkedNote?.filePath ?? '来自知识库 · 双击打开原文'}</p></>}
                  <footer>
                    <span>{node.type === 'file' ? (linkedNote?.wordCount ? `${linkedNote.wordCount} 字` : '笔记引用') : node.type === 'image' ? '图片引用' : isGroup ? '分组区域' : '自由内容'}</span>
                    <div className="canvas-card__footer-actions">
                      <div className="canvas-card__colors" role="group" aria-label="卡片颜色">
                        {CARD_COLOR_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className={`canvas-card__color-button canvas-card__color-button--${option.value} ${color === option.value ? 'is-active' : ''}`}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => { event.stopPropagation(); setNodeColor(node.id, option.value); }}
                            aria-label={`设置卡片颜色为 ${option.label}`}
                            aria-pressed={color === option.value}
                            title={option.label}
                          />
                        ))}
                      </div>
                      <button type="button" className="canvas-card__delete" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setSelected([]); deleteNodes([node.id]); }} aria-label="删除卡片" title="删除卡片">×</button>
                    </div>
                  </footer>
                  <button type="button" className="canvas-resize-handle" onPointerDown={(event) => resizeNode(event, node)} aria-label="调整卡片大小" title="调整卡片大小" />
                  {PORT_SIDES.map((side) => (
                    <button
                      key={side}
                      type="button"
                      className={`canvas-port canvas-port--${side}`}
                      data-port-side={side}
                      onPointerDown={(event) => beginConnection(event, node, side)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`从此卡片${PORT_LABELS[side]}创建连接`}
                      title={`从此卡片${PORT_LABELS[side]}创建连接`}
                    />
                  ))}
                </article>
              );
            })}

          </div>
          {!canvasDocument.nodes.length ? (
            <div className="canvas-empty">
              <div className="canvas-empty__icon" aria-hidden="true">＋</div>
              <span className="canvas-empty__eyebrow">LOCAL CANVAS</span>
              <h2>从空白画布开始</h2>
              <p>把想法、笔记和关系放到同一块空间里。</p>
              <div className="canvas-empty__actions">
                <button type="button" className="btn btn--primary" onClick={() => addText()}>添加文本卡片</button>
                <button type="button" className="btn" onClick={handleToolbarCreateNote}>新建笔记</button>
                <button type="button" className="btn" onClick={() => openResourcePicker('note')} disabled={!noteIndex.length}>添加笔记卡片</button>
                <button type="button" className="btn" onClick={() => openResourcePicker('image')}>添加图片卡片</button>
              </div>
              <span className="canvas-empty__meta">画布内容会保存到当前 Vault</span>
            </div>
          ) : null}
          <div className="canvas-stage__status" aria-live="polite">
            <span className={`canvas-stage__status-dot canvas-stage__status-dot--${stageStatusTone}`} />
            <span title={clipboardError || undefined}>{stageStatusText}</span>
            <span aria-hidden="true">·</span>
            <span>{selected.length > 1
              ? `已选中 ${selected.length} 个对象`
              : selectedEdge
                ? '按 Delete 删除连接'
                : selectedNode
                  ? `已选中 ${selectedNode.type === 'file' ? '笔记' : selectedNode.type === 'image' ? '图片' : '文本'}卡片`
                  : `${canvasDocument.nodes.length} 个对象 · ${canvasDocument.edges.length} 条连接`}</span>
          </div>
        </div>
      </ContextMenu>
      <CanvasResourcePicker
        kind={resourcePicker}
        notes={filteredNotes}
        images={filteredImages}
        query={pickerQuery}
        loading={imagePickerState === 'loading'}
        error={imagePickerError}
        onQueryChange={setPickerQuery}
        onClose={closeResourcePicker}
        onSelectNote={selectNote}
        onSelectImage={selectImage}
      />
    </section>
  );
}

function CanvasResourcePicker({ kind, notes, images, query, loading, error, onQueryChange, onClose, onSelectNote, onSelectImage }) {
  const isImagePicker = kind === 'image';
  return (
    <Modal open={Boolean(kind)} title={isImagePicker ? '添加图片' : '添加笔记'} onClose={onClose} className="canvas-picker-modal">
      <div className="canvas-picker">
        <header className="canvas-picker__header">
          <div>
            <span className="canvas-picker__eyebrow">{isImagePicker ? 'VAULT IMAGES' : 'NOTE REFERENCES'}</span>
            <h2>{isImagePicker ? '选择一张图片' : '选择一篇笔记'}</h2>
            <p>{isImagePicker ? '图片仍保存在 Vault 中，画布只记录相对路径。' : '添加引用卡片不会复制或修改笔记正文。'}</p>
          </div>
          <button type="button" className="canvas-picker__close" onClick={onClose} aria-label="关闭选择器" title="关闭">×</button>
        </header>
        <div className="canvas-picker__body">
          <label className="canvas-picker__search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={isImagePicker ? '搜索图片路径' : '搜索笔记标题'} aria-label={isImagePicker ? '搜索图片路径' : '搜索笔记标题'} autoFocus />
          </label>
          {isImagePicker && loading ? <div className="canvas-picker__state">正在读取 Vault 图片…</div> : null}
          {isImagePicker && error ? <div className="canvas-picker__state canvas-picker__state--error">{error}</div> : null}
          {isImagePicker && !loading && !error && !images.length ? <div className="canvas-picker__state">{query ? '没有匹配的图片' : 'Vault 中还没有可用图片'}</div> : null}
          {!isImagePicker && !notes.length ? <div className="canvas-picker__state">{query ? '没有匹配的笔记' : '还没有可添加的笔记'}</div> : null}
          {isImagePicker ? (
            <div className="canvas-picker__grid">
              {images.map((asset) => <button type="button" className="canvas-picker__image" key={asset.path} onClick={() => onSelectImage(asset)} title={`添加 ${asset.path}`}>
                <img src={vaultFiles.assetUrl(asset.path)} alt="" loading="lazy" />
                <span>{asset.path}</span>
              </button>)}
            </div>
          ) : (
            <div className="canvas-picker__list">
              {notes.map((note) => <button type="button" className="canvas-picker__note" key={note.id} onClick={() => onSelectNote(note)}>
                <span className="canvas-picker__note-icon" aria-hidden="true">▤</span>
                <span><strong>{note.title}</strong><small>{note.folderId ? '已归档笔记' : '未分类笔记'}</small></span>
                <span className="canvas-picker__arrow" aria-hidden="true">↗</span>
              </button>)}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function normalizeDocument(value) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return EMPTY_DOCUMENT;
  // Obsidian 导入等外部来源的 JSON 可能含 null / 非对象元素，
  // 不过滤的话渲染和笔记反查（node.type）会直接 TypeError
  const nodes = value.nodes.filter((node) => node && typeof node === 'object');
  const edges = value.edges.filter((edge) => edge && typeof edge === 'object');
  return { ...value, nodes, edges };
}

function normalizeCardColor(value) {
  return CARD_COLOR_OPTIONS.some((option) => option.value === value) ? value : 'blue';
}

function getSuggestedPosition(index) {
  const columns = Math.max(2, Math.min(4, Math.floor((stageWidth() || 900) / 310)));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return { x: 120 + column * 290, y: 100 + row * 180 };
}

function stageWidth() {
  return document.querySelector('.canvas-stage')?.clientWidth ?? 0;
}

function getNodeBounds(nodes) {
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + getNodeWidth(node)));
  const maxY = Math.max(...nodes.map((node) => node.y + getNodeHeight(node)));
  return { x: minX, y: minY, width: Math.max(NODE_WIDTH, maxX - minX), height: Math.max(NODE_HEIGHT, maxY - minY) };
}

function getNodeWidth(node) {
  return clampDimension(node?.width, NODE_WIDTH, MIN_NODE_WIDTH, MAX_NODE_WIDTH);
}

function getNodeHeight(node) {
  return clampDimension(node?.height, NODE_HEIGHT, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT);
}

function clampDimension(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp(numeric, min, max) : fallback;
}

function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function rectsIntersect(rect, node) {
  const width = getNodeWidth(node);
  const height = getNodeHeight(node);
  return node.x < rect.x + rect.width
    && node.x + width > rect.x
    && node.y < rect.y + rect.height
    && node.y + height > rect.y;
}

function resolveSnapPosition(node, proposedX, proposedY, nodes) {
  const width = getNodeWidth(node);
  const height = getNodeHeight(node);
  const others = nodes.filter((candidate) => candidate.id !== node.id);
  const xMatch = findSnapMatch(
    [
      { offset: 0, value: proposedX },
      { offset: width / 2, value: proposedX + width / 2 },
      { offset: width, value: proposedX + width },
    ],
    others.flatMap((candidate) => {
      const candidateWidth = getNodeWidth(candidate);
      return [candidate.x, candidate.x + candidateWidth / 2, candidate.x + candidateWidth];
    }),
  );
  const yMatch = findSnapMatch(
    [
      { offset: 0, value: proposedY },
      { offset: height / 2, value: proposedY + height / 2 },
      { offset: height, value: proposedY + height },
    ],
    others.flatMap((candidate) => {
      const candidateHeight = getNodeHeight(candidate);
      return [candidate.y, candidate.y + candidateHeight / 2, candidate.y + candidateHeight];
    }),
  );

  return {
    x: xMatch ? xMatch.target - xMatch.offset : proposedX,
    y: yMatch ? yMatch.target - yMatch.offset : proposedY,
    guides: [
      ...(xMatch ? [{ axis: 'vertical', value: xMatch.target }] : []),
      ...(yMatch ? [{ axis: 'horizontal', value: yMatch.target }] : []),
    ],
  };
}

function findSnapMatch(currentAnchors, targetValues) {
  let best = null;
  for (const current of currentAnchors) {
    for (const target of targetValues) {
      const distance = Math.abs(current.value - target);
      if (distance > SNAP_DISTANCE || (best && distance >= best.distance)) continue;
      best = { distance, offset: current.offset, target };
    }
  }
  return best;
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getPortPosition(node, side) {
  const width = getNodeWidth(node);
  const height = getNodeHeight(node);
  switch (side) {
    case 'top':
      return { x: node.x + width / 2, y: node.y };
    case 'right':
      return { x: node.x + width, y: node.y + height / 2 };
    case 'left':
      return { x: node.x, y: node.y + height / 2 };
    case 'bottom':
    default:
      return { x: node.x + width / 2, y: node.y + height };
  }
}

function getPortVector(side) {
  switch (side) {
    case 'top': return { x: 0, y: -1 };
    case 'right': return { x: 1, y: 0 };
    case 'left': return { x: -1, y: 0 };
    case 'bottom':
    default: return { x: 0, y: 1 };
  }
}

function oppositePortSide(side) {
  return { top: 'bottom', right: 'left', bottom: 'top', left: 'right' }[side] ?? 'top';
}

function nearestPortSide(node, point) {
  const width = getNodeWidth(node);
  const height = getNodeHeight(node);
  const distances = {
    top: Math.abs(point.y - node.y),
    right: Math.abs(point.x - (node.x + width)),
    bottom: Math.abs(point.y - (node.y + height)),
    left: Math.abs(point.x - node.x),
  };
  return Object.entries(distances).sort(([, left], [, right]) => left - right)[0][0];
}

function resolveConnectionSides(edge, from, to) {
  if (edge.fromSide && edge.toSide) return { fromSide: edge.fromSide, toSide: edge.toSide };
  const fromCenter = { x: from.x + getNodeWidth(from) / 2, y: from.y + getNodeHeight(from) / 2 };
  const toCenter = { x: to.x + getNodeWidth(to) / 2, y: to.y + getNodeHeight(to) / 2 };
  const horizontal = Math.abs(toCenter.x - fromCenter.x) > Math.abs(toCenter.y - fromCenter.y);
  if (horizontal) {
    const fromSide = toCenter.x >= fromCenter.x ? 'right' : 'left';
    return { fromSide, toSide: oppositePortSide(fromSide) };
  }
  const fromSide = toCenter.y >= fromCenter.y ? 'bottom' : 'top';
  return { fromSide, toSide: oppositePortSide(fromSide) };
}

function connectionPath(from, to, fromSide, toSide) {
  const fromVector = getPortVector(fromSide);
  const toVector = getPortVector(toSide);
  const distance = Math.max(44, Math.min(180, Math.hypot(to.x - from.x, to.y - from.y) * 0.42));
  const controlStart = { x: from.x + fromVector.x * distance, y: from.y + fromVector.y * distance };
  const controlEnd = { x: to.x + toVector.x * distance, y: to.y + toVector.y * distance };
  return `M ${from.x} ${from.y} C ${controlStart.x} ${controlStart.y}, ${controlEnd.x} ${controlEnd.y}, ${to.x} ${to.y}`;
}
