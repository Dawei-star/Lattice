import { CanvasElementType } from '@blocksuite/affine-block-surface';
import { ConnectorMode, LineColor, ShapeFillColor, ShapeType } from '@blocksuite/affine-model';
import type { SurfaceBlockModel } from '@blocksuite/affine-block-surface';
import { Bound } from '@blocksuite/global/utils';
import { DocCollection } from '@blocksuite/store';
import type { CanvasDocument } from '../api/canvas.ts';

export interface CanvasProjectionNode {
  id: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  noteId?: string;
  path?: string;
  file?: string;
  color?: string;
  [key: string]: unknown;
}

export interface CanvasProjectionEdge {
  id: string;
  from: string;
  to: string;
  color?: string;
  fromSide?: string;
  toSide?: string;
  [key: string]: unknown;
}

const NODE_METADATA_KEY = 'latticeNodeJson';
const EDGE_METADATA_KEY = 'latticeEdgeJson';
const DEFAULT_WIDTH = 248;
const DEFAULT_HEIGHT = 140;

export interface EdgelessProjectionSession {
  nodeElementIds: Map<string, string>;
  nodesByElementId: Map<string, CanvasProjectionNode>;
  edgesByElementId: Map<string, CanvasProjectionEdge>;
  imageBlockIds: Map<string, string>;
}

export interface EdgelessProjectionOptions {
  /** Native affine:image blocks use these already-loaded blob ids. */
  imageSources?: ReadonlyMap<string, string>;
}

/**
 * Import the durable Obsidian canvas into native Edgeless surface elements.
 * The metadata fields are runtime-only projection hints; the source document
 * remains the only durable representation.
 */
export function canvasDocumentToEdgeless(surface: SurfaceBlockModel, source: CanvasDocument, options: EdgelessProjectionOptions = {}): EdgelessProjectionSession {
  const nodes = readNodes(source);
  const edges = readEdges(source);
  const nodeElementIds = new Map<string, string>();
  const nodesByElementId = new Map<string, CanvasProjectionNode>();
  const edgesByElementId = new Map<string, CanvasProjectionEdge>();
  const imageBlockIds = new Map<string, string>();

  for (const node of nodes) {
    const imageSourceId = node.type === 'image' ? options.imageSources?.get(node.id) : undefined;
    if (imageSourceId) {
      const blockId = surface.doc.addBlock('affine:image', {
        sourceId: imageSourceId,
        xywh: new Bound(node.x, node.y, nodeWidth(node), nodeHeight(node)).serialize(),
        width: nodeWidth(node),
        height: nodeHeight(node),
        rotate: 0,
        index: 'a0',
        lockedBySelf: false,
        size: -1,
      }, surface);
      imageBlockIds.set(node.id, blockId);
      nodesByElementId.set(blockId, node);
      nodeElementIds.set(node.id, blockId);
      continue;
    }
    const elementId = surface.addElement({
      type: CanvasElementType.SHAPE,
      shapeType: ShapeType.Rect,
      xywh: new Bound(node.x, node.y, nodeWidth(node), nodeHeight(node)).serialize(),
      radius: node.type === 'group' ? 12 : 8,
      filled: true,
      fillColor: fillColor(node),
      strokeColor: LineColor.Grey,
      strokeWidth: 2,
      text: new DocCollection.Y.Text(displayText(node)),
      latticeNodeJson: JSON.stringify(node),
    });
    nodeElementIds.set(node.id, elementId);
    nodesByElementId.set(elementId, node);
  }

  for (const edge of edges) {
    const from = nodeElementIds.get(edge.from);
    const to = nodeElementIds.get(edge.to);
    if (!from || !to) continue;
    const elementId = surface.addElement({
      type: CanvasElementType.CONNECTOR,
      mode: ConnectorMode.Orthogonal,
      controllers: [],
      source: { id: from },
      target: { id: to },
      stroke: LineColor.Grey,
      latticeEdgeJson: JSON.stringify(edge),
    });
    edgesByElementId.set(elementId, edge);
  }

  return { nodeElementIds, nodesByElementId, edgesByElementId, imageBlockIds };
}

/** Export current Edgeless surface elements back to the Obsidian canvas shape. */
export function edgelessToCanvasDocument(surface: SurfaceBlockModel, source: CanvasDocument, session?: EdgelessProjectionSession): CanvasDocument {
  const nodeElementIds = new Map<string, string>();
  const elementNodeIds = new Map<string, string>();
  const nodes: CanvasProjectionNode[] = [];

  for (const element of surface.elementModels) {
    if (element.type !== CanvasElementType.SHAPE && element.type !== CanvasElementType.TEXT) continue;
    const original = parseMetadata<CanvasProjectionNode>(element.yMap.get(NODE_METADATA_KEY)) ?? session?.nodesByElementId.get(element.id) ?? null;
    const [x, y, width, height] = Bound.deserialize(element.xywh).serialize().slice(1, -1).split(',').map(Number);
    const node: CanvasProjectionNode = original
      ? { ...original, x, y, width, height }
      : {
          id: element.id,
          type: 'text',
          x,
          y,
          width,
          height,
          text: readElementText(element),
        };

    if (original && original.type !== 'file') node.text = readElementText(element);
    nodes.push(node);
    nodeElementIds.set(node.id, element.id);
    elementNodeIds.set(element.id, node.id);
  }

  for (const [nodeId, blockId] of session?.imageBlockIds ?? []) {
    const model = surface.doc.getBlockById(blockId) as { id: string; xywh: string } | null;
    const isLiveImage = surface.doc.getBlocksByFlavour('affine:image').some((candidate) => candidate.id === blockId);
    if (!model || !isLiveImage) continue;
    const original = session?.nodesByElementId.get(blockId)
      ?? readNodes(source).find(node => node.id === nodeId)
      ?? null;
    if (!original) continue;
    const [x, y, width, height] = readBounds(model.xywh);
    nodes.push({ ...original, x, y, width, height });
    nodeElementIds.set(nodeId, blockId);
    elementNodeIds.set(blockId, nodeId);
  }

  const edges: CanvasProjectionEdge[] = [];
  for (const element of surface.elementModels) {
    if (element.type !== CanvasElementType.CONNECTOR) continue;
    const original = parseMetadata<CanvasProjectionEdge>(element.yMap.get(EDGE_METADATA_KEY)) ?? session?.edgesByElementId.get(element.id) ?? null;
    const connector = element as typeof element & { source?: { id?: string }; target?: { id?: string } };
    const from = connector.source?.id ? elementNodeIds.get(connector.source.id) : undefined;
    const to = connector.target?.id ? elementNodeIds.get(connector.target.id) : undefined;
    if (!from || !to) continue;
    edges.push(original ? { ...original, from, to } : { id: element.id, from, to });
  }

  const sourceOrder = new Map(readNodes(source).map((node, index) => [node.id, index]));
  nodes.sort((left, right) => (sourceOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));

  return {
    ...source,
    version: source.version ?? 1,
    nodes,
    edges,
  };
}

function readBounds(xywh: string): [number, number, number, number] {
  const values = Bound.deserialize(xywh).serialize().slice(1, -1).split(',').map(Number);
  return [values[0] || 0, values[1] || 0, values[2] || DEFAULT_WIDTH, values[3] || DEFAULT_HEIGHT];
}

export function readProjectedNode(value: unknown): CanvasProjectionNode | null {
  return parseMetadata<CanvasProjectionNode>(value);
}

function readNodes(source: CanvasDocument): CanvasProjectionNode[] {
  return Array.isArray(source.nodes)
    ? source.nodes.filter((node): node is CanvasProjectionNode => Boolean(node && typeof node === 'object' && typeof (node as CanvasProjectionNode).id === 'string'))
    : [];
}

function readEdges(source: CanvasDocument): CanvasProjectionEdge[] {
  return Array.isArray(source.edges)
    ? source.edges.filter((edge): edge is CanvasProjectionEdge => Boolean(edge && typeof edge === 'object' && typeof (edge as CanvasProjectionEdge).id === 'string'))
    : [];
}

function parseMetadata<T>(value: unknown): T | null {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value as T : null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as T : null;
  } catch {
    return null;
  }
}

function readElementText(element: { yMap: { get(key: string): unknown } }): string {
  const value = element.yMap.get('text');
  return value && typeof value === 'object' && 'toString' in value ? String(value) : typeof value === 'string' ? value : '';
}

function displayText(node: CanvasProjectionNode): string {
  if (node.type === 'image') return node.text || node.path || '图片';
  if (node.type === 'file') return node.text || node.file || node.path || '笔记';
  return node.text || (node.type === 'group' ? '分组' : '文本');
}

function nodeWidth(node: CanvasProjectionNode): number {
  return finiteDimension(node.width, DEFAULT_WIDTH);
}

function nodeHeight(node: CanvasProjectionNode): number {
  return finiteDimension(node.height, DEFAULT_HEIGHT);
}

function finiteDimension(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function fillColor(node: CanvasProjectionNode): ShapeFillColor {
  switch (node.color) {
    case 'red': return ShapeFillColor.Red;
    case 'orange': return ShapeFillColor.Orange;
    case 'yellow': return ShapeFillColor.Yellow;
    case 'green': return ShapeFillColor.Green;
    case 'purple': return ShapeFillColor.Purple;
    default: return node.type === 'image' ? ShapeFillColor.Orange : ShapeFillColor.Blue;
  }
}
