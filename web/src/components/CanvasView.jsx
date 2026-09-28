import { useEffect, useMemo, useRef, useState } from 'react';
import ContextMenu from '../ui/ContextMenu.jsx';
import Modal from '../ui/Modal.jsx';
import { canvasApi } from '../api/canvas.js';
import { vaultAssetsApi, vaultFiles } from '../api/vault-files.js';

const STORAGE_KEY = 'lattice-canvas-document-v1';
const EMPTY_DOCUMENT = { nodes: [], edges: [] };
const NODE_WIDTH = 248;
const NODE_HEIGHT = 140;
const MIN_NODE_WIDTH = 180;
const MAX_NODE_WIDTH = 720;
const MIN_NODE_HEIGHT = 110;
const MAX_NODE_HEIGHT = 560;
const SNAP_DISTANCE = 10;
const MIN_SCALE = 0.45;
const MAX_SCALE = 2;
const PORT_SIDES = ['top', 'right', 'bottom', 'left'];
const PORT_LABELS = { top: '顶部', right: '右侧', bottom: '底部', left: '左侧' };
const CARD_COLOR_OPTIONS = [
  { value: 'blue', label: '蓝色' },
  { value: 'green', label: '绿色' },
  { value: 'yellow', label: '黄色' },
  { value: 'red', label: '红色' },
];

export default function CanvasView({ canvasPath = '画板.canvas', noteIndex = [], activeNoteId, onOpenNote, onCreateNote }) {
  const [canvasDocument, setCanvasDocument] = useState(() => loadDocument());
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [selected, setSelected] = useState(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [connection, setConnection] = useState(null);
  const [alignmentGuides, setAlignmentGuides] = useState([]);
  const [resourcePicker, setResourcePicker] = useState(null);
  const [resourcePickerPosition, setResourcePickerPosition] = useState(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [imageAssets, setImageAssets] = useState([]);
  const [imagePickerState, setImagePickerState] = useState('idle');
  const [imagePickerError, setImagePickerError] = useState('');
  const [saveState, setSaveState] = useState('loading');
  const loadedFromVault = useRef(false);
  const hasLocalChanges = useRef(false);
  const hasAutoFitted = useRef(false);
  const saveRevision = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const nodesRef = useRef([]);
  const panRef = useRef(null);
  const stageRef = useRef(null);
  nodesRef.current = canvasDocument.nodes;

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
    saveRevision.current += 1;
    setCanvasDocument(loadDocument());
    setSelected(null);
    setConnection(null);
    setAlignmentGuides([]);
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
      loadedFromVault.current = true;
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

  useEffect(() => {
    if (!loadedFromVault.current) return;
    const revision = ++saveRevision.current;
    const snapshot = { ...canvasDocument, version: 1 };
    setSaveState('saving');
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      if (revision !== saveRevision.current) return;
      await canvasApi.save(canvasPath, snapshot);
      if (revision === saveRevision.current) setSaveState('saved');
    }).catch(() => {
      if (revision === saveRevision.current) setSaveState('error');
    });
  }, [canvasDocument, canvasPath]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      const activeElement = globalThis.document.activeElement;
      const isEditing = activeElement?.tagName === 'TEXTAREA' || activeElement?.tagName === 'INPUT';
      if (event.code === 'Space' && !isEditing) {
        event.preventDefault();
        setSpaceDown(true);
      }
      if (event.key === 'Escape' && connection) {
        event.preventDefault();
        setConnection(null);
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected && !isEditing) {
        event.preventDefault();
        deleteNode(selected);
        setSelected(null);
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
  }, [connection, selected]);

  useEffect(() => {
    if (!loadedFromVault.current || hasAutoFitted.current || !canvasDocument.nodes.length) return;
    hasAutoFitted.current = true;
    requestAnimationFrame(() => fitView(canvasDocument.nodes));
  }, [canvasDocument.nodes.length]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !canvasDocument.nodes.length || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => fitView(nodesRef.current));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [canvasDocument.nodes.length]);

  const selectedNode = canvasDocument.nodes.find((node) => node.id === selected) ?? null;
  const activeNode = canvasDocument.nodes.find((node) => node.type === 'file' && node.noteId === activeNoteId) ?? null;
  const updateDocument = (updater) => {
    hasLocalChanges.current = true;
    setCanvasDocument(updater);
  };

  const zoom = (amount, anchor) => {
    const stage = stageRef.current;
    if (!stage || !anchor) {
      setView((current) => ({ ...current, scale: clamp(current.scale + amount, MIN_SCALE, MAX_SCALE) }));
      return;
    }

    const rect = stage.getBoundingClientRect();
    const point = { x: anchor.clientX - rect.left, y: anchor.clientY - rect.top };
    setView((current) => {
      const scale = clamp(current.scale + amount, MIN_SCALE, MAX_SCALE);
      const worldPoint = { x: (point.x - current.x) / current.scale, y: (point.y - current.y) / current.scale };
      return { scale, x: point.x - worldPoint.x * scale, y: point.y - worldPoint.y * scale };
    });
  };

  const resetView = () => setView({ scale: 1, x: 0, y: 0 });

  const fitView = (nodes = canvasDocument.nodes) => {
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
    setView({
      scale,
      x: rect.width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: rect.height / 2 - (bounds.y + bounds.height / 2) * scale,
    });
  };

  const focusNode = (node = selectedNode) => {
    const stage = stageRef.current;
    if (!stage || !node) return;
    const rect = stage.getBoundingClientRect();
    const width = getNodeWidth(node);
    const height = getNodeHeight(node);
    setView((current) => ({
      ...current,
      x: rect.width / 2 - (node.x + width / 2) * current.scale,
      y: rect.height / 2 - (node.y + height / 2) * current.scale,
    }));
  };

  const addText = (position) => {
    const id = createId('text');
    updateDocument((current) => ({
      ...current,
      nodes: [...current.nodes, {
        id,
        type: 'text',
        text: '双击编辑这张卡片',
        ...(position ?? getSuggestedPosition(current.nodes.length)),
        color: 'yellow',
      }],
    }));
    setSelected(id);
  };

  const addNote = (note, position) => {
    if (!note) return;
    const id = `file-${note.id}`;
    updateDocument((current) => current.nodes.some((node) => node.id === id)
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
    setSelected(id);
  };

  const addFirstNote = () => addNote(noteIndex.find((note) => note.id === activeNoteId) ?? noteIndex[0]);
  const addImage = (asset, position) => {
    if (!asset?.path) return;
    const existing = canvasDocument.nodes.find((node) => node.type === 'image' && node.path === asset.path);
    if (existing) {
      setSelected(existing.id);
      return;
    }
    const id = createId('image');
    updateDocument((current) => ({
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
    setSelected(id);
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
  const updateNode = (id, patch) => updateDocument((current) => ({
    ...current,
    nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node),
  }));
  const setNodeColor = (id, color) => {
    updateNode(id, { color });
    setSelected(id);
  };
  const getContextNode = (event) => {
    const nodeId = event.target instanceof Element
      ? event.target.closest('[data-canvas-node]')?.dataset.canvasNode
      : null;
    return canvasDocument.nodes.find((node) => node.id === nodeId) ?? selectedNode;
  };
  const deleteNode = (id) => {
    if (!id) return;
    updateDocument((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== id),
      edges: current.edges.filter((edge) => edge.from !== id && edge.to !== id),
    }));
  };

  const handlePointerDown = (event) => {
    if (event.target.closest('.canvas-empty, button, textarea, input')) return;
    if (event.target.closest('.canvas-card') && !spaceDown) return;
    setSelected(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { x: event.clientX, y: event.clientY, view };
  };

  const handlePointerMove = (event) => {
    if (!panRef.current) return;
    setView({
      ...panRef.current.view,
      x: panRef.current.view.x + event.clientX - panRef.current.x,
      y: panRef.current.view.y + event.clientY - panRef.current.y,
    });
  };

  const stopPan = () => { panRef.current = null; };

  const moveNode = (event, node) => {
    event.stopPropagation();
    setSelected(node.id);
    if (spaceDown) return;
    const start = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
    const move = (next) => {
      const proposedX = start.nodeX + (next.clientX - start.x) / view.scale;
      const proposedY = start.nodeY + (next.clientY - start.y) / view.scale;
      const snapped = resolveSnapPosition(node, proposedX, proposedY, nodesRef.current);
      setAlignmentGuides(snapped.guides);
      updateNode(node.id, { x: snapped.x, y: snapped.y });
    };
    const finish = () => {
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
    setSelected(node.id);
    if (spaceDown) return;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const start = {
      x: event.clientX,
      y: event.clientY,
      width: getNodeWidth(node),
      height: getNodeHeight(node),
    };
    const move = (next) => updateNode(node.id, {
      width: clamp(start.width + (next.clientX - start.x) / view.scale, MIN_NODE_WIDTH, MAX_NODE_WIDTH),
      height: clamp(start.height + (next.clientY - start.y) / view.scale, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT),
    });
    const finish = () => {
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
    return rect
      ? { x: (point.x - rect.left - view.x) / view.scale, y: (point.y - rect.top - view.y) / view.scale }
      : point;
  };

  const getConnectionTarget = (point, sourceId) => {
    const targetElement = document.elementFromPoint(point.x, point.y)?.closest('[data-canvas-node]');
    const targetId = targetElement?.dataset.canvasNode;
    if (!targetId || targetId === sourceId) return null;
    const targetNode = canvasDocument.nodes.find((node) => node.id === targetId);
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
    const move = (next) => {
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
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      sourcePort.releasePointerCapture?.(event.pointerId);
    };
    const up = (next) => {
      const target = getConnectionTarget(next, node.id);
      if (target) {
        updateDocument((current) => {
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
    return rect
      ? { x: (event.clientX - rect.left - view.x) / view.scale - NODE_WIDTH / 2, y: (event.clientY - rect.top - view.y) / view.scale - NODE_HEIGHT / 2 }
      : undefined;
  };

  return (
    <section className="canvas-view" aria-label="画布">
      <header className="canvas-toolbar">
        <div className="canvas-toolbar__title">
          <strong>画布</strong>
          <span className="canvas-toolbar__stats" aria-label={`${canvasDocument.nodes.length} 个对象，${canvasDocument.edges.length} 条连接`}>
            {canvasDocument.nodes.length} 个对象 · {canvasDocument.edges.length} 条连接
          </span>
          <span className="canvas-toolbar__selection" aria-live="polite">
            {selectedNode ? `已选中：${selectedNode.text}` : activeNode ? `当前笔记：${activeNode.text}` : '未选择对象'}
          </span>
        </div>
        <div className="canvas-toolbar__actions">
          <div className="canvas-toolbar__actions--primary">
            <button type="button" className="btn" onClick={() => addText()} title="添加文本卡片">＋ 文本卡片</button>
            <button type="button" className="btn" onClick={() => openResourcePicker('note')} disabled={!noteIndex.length} title="选择一篇笔记">⌁ 添加笔记</button>
            <button type="button" className="btn" onClick={() => openResourcePicker('image')} title="选择 Vault 中的图片">▧ 添加图片</button>
            <button type="button" className="btn btn--primary" onClick={onCreateNote}>新建笔记</button>
          </div>
          <span className="canvas-toolbar__divider" />
          <div className="canvas-toolbar__viewtools" aria-label="视图工具">
            <button type="button" className="canvas-tool" onClick={() => zoom(-0.1)} aria-label="缩小" title="缩小">−</button>
            <span className="canvas-zoom">{Math.round(view.scale * 100)}%</span>
            <button type="button" className="canvas-tool" onClick={() => zoom(0.1)} aria-label="放大" title="放大">＋</button>
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
          const contextNode = getContextNode(event);
          const contextColor = contextNode ? normalizeCardColor(contextNode.color) : null;
          const isCompactMenu = (stageRef.current?.clientWidth ?? globalThis.innerWidth) < 720;
          if (contextNode && contextNode.id !== selected) setSelected(contextNode.id);
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
            { label: '添加图片', icon: '▧', onSelect: () => openResourcePicker('image', position) },
            { label: '添加网页', icon: '↗', disabled: true },
            { label: '创建分组', icon: '▦', disabled: true },
            { separator: true },
            { label: '适配全部节点', icon: '⌗', disabled: !canvasDocument.nodes.length, onSelect: () => fitView() },
            { label: '聚焦选中节点', icon: '◎', disabled: !contextNode, onSelect: () => focusNode(contextNode) },
            ...colorMenuItems,
            { label: contextNode ? '删除此卡片' : '删除选中对象', icon: '×', disabled: !contextNode, onSelect: () => { deleteNode(contextNode?.id); setSelected(null); } },
            { separator: true },
            { label: '撤销', icon: '↶', disabled: true, shortcut: 'Ctrl Z' },
            { label: '只读', icon: '⌑', disabled: true },
          ];
        }}
      >
        <div
          ref={stageRef}
          className={`canvas-stage ${spaceDown ? 'is-panning' : ''} ${connection ? 'is-connecting' : ''} ${alignmentGuides.length ? 'is-aligning' : ''}`}
          onPointerDown={handlePointerDown}
          onDoubleClick={(event) => {
            if (event.target.closest('.canvas-card')) return;
            addText(getContextPosition(event));
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={stopPan}
          onPointerCancel={stopPan}
          onWheel={(event) => zoom(event.deltaY > 0 ? -0.06 : 0.06, event)}
        >
          <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
            <div className="canvas-guides" aria-hidden="true">
              {alignmentGuides.map((guide) => (
                <div key={`${guide.axis}-${guide.value}`} className={`canvas-guide canvas-guide--${guide.axis}`} style={guide.axis === 'vertical' ? { left: guide.value } : { top: guide.value }}>
                  <span>对齐</span>
                </div>
              ))}
            </div>
            <svg className="canvas-links" aria-hidden="true">
              <defs>
                <marker id="canvas-arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
                  <path className="canvas-arrowhead" d="M 0 0 L 12 6 L 0 12 z" />
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
                return <path key={edge.id} d={connectionPath(getPortPosition(from, sides.fromSide), getPortPosition(to, sides.toSide), sides.fromSide, sides.toSide)} markerEnd="url(#canvas-arrow)" />;
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
              const isActive = node.type === 'file' && node.noteId === activeNoteId;
              const color = normalizeCardColor(node.color);
              return (
                <article
                  key={node.id}
                  className={`canvas-card canvas-card--${color} ${selected === node.id ? 'is-selected' : ''} ${isActive ? 'is-active' : ''} ${connection?.nodeId === node.id ? 'is-connection-source' : ''} ${connection?.targetId === node.id ? 'is-connection-target' : ''}`}
                  style={{ left: node.x, top: node.y, width: getNodeWidth(node), height: getNodeHeight(node) }}
                  data-canvas-node={node.id}
                  tabIndex={0}
                  aria-label={`${node.type === 'file' ? '笔记卡片' : node.type === 'image' ? '图片卡片' : '文本卡片'}：${node.text}`}
                  aria-current={isActive ? 'page' : undefined}
                  onPointerDown={(event) => moveNode(event, node)}
                  onClick={() => {
                    setSelected(node.id);
                    if (node.type === 'file') onOpenNote?.(node.noteId);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' && node.type === 'file') onOpenNote?.(node.noteId);
                  }}
                >
                  <div className="canvas-card__handle" aria-hidden="true"><span /><span /><span /></div>
                  <span className="canvas-card__type">{node.type === 'file' ? '笔记卡片' : node.type === 'image' ? '图片卡片' : '文本卡片'}{isActive ? ' · 当前打开' : ''}</span>
                  {node.type === 'text'
                    ? <textarea value={node.text} onChange={(event) => updateNode(node.id, { text: event.target.value })} onPointerDown={(event) => event.stopPropagation()} aria-label="编辑画布文本" />
                    : node.type === 'image'
                      ? <><div className="canvas-card__image" title={node.path}><img src={vaultFiles.assetUrl(node.path)} alt={node.text} draggable="false" onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.nextElementSibling.hidden = false; }} /><span hidden>图片暂不可用</span></div><h3 title={node.path}>{node.text}</h3></>
                      : <><h3>{node.text}</h3><p>来自知识库 · 点击打开原文</p></>}
                  <footer>
                    <span>{node.type === 'file' ? '笔记引用' : node.type === 'image' ? '图片引用' : '自由内容'}</span>
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
                      <button type="button" className="canvas-card__delete" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setSelected(null); deleteNode(node.id); }} aria-label="删除卡片" title="删除卡片">×</button>
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
                <button type="button" className="btn" onClick={() => openResourcePicker('note')} disabled={!noteIndex.length}>添加笔记卡片</button>
                <button type="button" className="btn" onClick={() => openResourcePicker('image')}>添加图片卡片</button>
              </div>
              <span className="canvas-empty__meta">画布内容会保存到当前 Vault</span>
            </div>
          ) : null}
          <div className="canvas-stage__status" aria-live="polite">
            <span className={`canvas-stage__status-dot canvas-stage__status-dot--${saveState}`} />
            <span>{alignmentGuides.length ? '正在对齐…' : connection ? '拖到目标卡片的任意连接点后松开' : saveState === 'loading' ? '正在加载画布' : saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存'}</span>
            <span aria-hidden="true">·</span>
            <span>{selectedNode ? `已选中 ${selectedNode.type === 'file' ? '笔记' : selectedNode.type === 'image' ? '图片' : '文本'}卡片` : `${canvasDocument.nodes.length} 个对象 · ${canvasDocument.edges.length} 条连接`}</span>
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

function loadDocument() {
  try {
    return normalizeDocument(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return EMPTY_DOCUMENT;
  }
}

function normalizeDocument(value) {
  return value?.nodes && value?.edges ? { ...value, nodes: value.nodes, edges: value.edges } : EMPTY_DOCUMENT;
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
