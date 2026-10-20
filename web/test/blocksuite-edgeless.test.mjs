import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { installDom } from './dom-setup.mjs';
import { createEmptyDoc } from '@blocksuite/presets';
import { ConnectorMode, LineColor, ShapeFillColor, ShapeType } from '@blocksuite/affine-model';
import { CanvasElementType } from '@blocksuite/affine-block-surface';
import { DocCollection } from '@blocksuite/store';

installDom();
globalThis.DOMRect = class DOMRectStub {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.top = y;
    this.left = x;
    this.right = x + width;
    this.bottom = y + height;
  }
};

const { canvasDocumentToEdgeless, edgelessToCanvasDocument } = await import('../src/editor/blocksuite-edgeless-bridge.ts');
const edgelessSource = await fs.readFile(new URL('../src/editor/BlockSuiteEdgelessCanvas.tsx', import.meta.url), 'utf8');
assert.match(edgelessSource, /imageLoadInFlight/, '图片投影必须追踪异步加载生命周期');
assert.match(edgelessSource, /if \(docDisposed \|\| imageLoadInFlight \|\| !doc\) return;/, '图片加载未结束前不得释放 Edgeless Doc');

const source = {
  version: 1,
  nodes: [
    { id: 'text-1', type: 'text', x: 10, y: 20, width: 180, height: 90, text: '文本卡片', color: 'blue' },
    { id: 'note-1', type: 'file', x: 260, y: 20, width: 240, height: 140, text: '设计笔记', noteId: 'note-id', file: '设计笔记.md' },
    { id: 'image-1', type: 'image', x: 10, y: 180, width: 320, height: 220, text: '封面', path: 'assets/cover.png' },
  ],
  edges: [{ id: 'edge-1', from: 'text-1', to: 'note-1', fromSide: 'right', toSide: 'left', color: 'blue' }],
};

const projection = createEmptyDoc();
projection.init();
const surface = projection.doc.getBlockByFlavour('affine:surface')[0];
const session = canvasDocumentToEdgeless(surface, source);

assert.equal(surface.elementModels.length, 4);
assert.equal(session.nodeElementIds.size, 3);
const textElementId = session.nodeElementIds.get('text-1');
assert.ok(textElementId);
surface.updateElement(textElementId, { xywh: '[30,40,200,100]' });

const output = edgelessToCanvasDocument(surface, source, session);
assert.deepEqual(output.nodes.find((node) => node.id === 'note-1'), source.nodes[1]);
assert.deepEqual(output.nodes.find((node) => node.id === 'image-1'), source.nodes[2]);
assert.deepEqual(output.edges, source.edges);
assert.deepEqual(output.nodes.find((node) => node.id === 'text-1'), {
  ...source.nodes[0],
  x: 30,
  y: 40,
  width: 200,
  height: 100,
});

const addedElementId = surface.addElement({
  type: CanvasElementType.SHAPE,
  shapeType: ShapeType.Rect,
  xywh: '[540,40,180,90]',
  radius: 8,
  filled: true,
  fillColor: ShapeFillColor.Blue,
  strokeColor: LineColor.Grey,
  strokeWidth: 2,
  text: new DocCollection.Y.Text('新增对象'),
});
const addedEdgeId = surface.addElement({
  type: CanvasElementType.CONNECTOR,
  mode: ConnectorMode.Orthogonal,
  controllers: [],
  source: { id: textElementId },
  target: { id: addedElementId },
  stroke: LineColor.Grey,
});
const withNewElements = edgelessToCanvasDocument(surface, source, session);
assert.equal(withNewElements.nodes.some((node) => node.id === addedElementId && node.text === '新增对象'), true);
assert.deepEqual(withNewElements.edges.find((edge) => edge.id === addedEdgeId), {
  id: addedEdgeId,
  from: 'text-1',
  to: addedElementId,
});

surface.deleteElement(addedElementId);
const afterDelete = edgelessToCanvasDocument(surface, source, session);
assert.equal(afterDelete.nodes.some((node) => node.id === addedElementId), false);
assert.equal(afterDelete.edges.some((edge) => edge.id === addedEdgeId), false);

const nativeProjection = createEmptyDoc();
nativeProjection.init();
const nativeSurface = nativeProjection.doc.getBlockByFlavour('affine:surface')[0];
const nativeImageSource = await nativeProjection.doc.blobSync.set(new Blob(['png'], { type: 'image/png' }));
const nativeSession = canvasDocumentToEdgeless(nativeSurface, source, {
  imageSources: new Map([['image-1', nativeImageSource]]),
});
assert.equal(nativeProjection.doc.getBlocksByFlavour('affine:image').length, 1);
assert.equal(nativeSession.imageBlockIds.has('image-1'), true);
const nativeImageBlockId = nativeSession.imageBlockIds.get('image-1');
assert.ok(nativeImageBlockId);
const nativeImageModel = nativeProjection.doc.getBlockById(nativeImageBlockId);
nativeImageModel.xywh = '[40,200,350,240]';
const nativeOutput = edgelessToCanvasDocument(nativeSurface, source, nativeSession);
assert.deepEqual(nativeOutput.nodes.find((node) => node.id === 'image-1'), { ...source.nodes[2], x: 40, y: 200, width: 350, height: 240 });
nativeProjection.doc.deleteBlock(nativeImageModel);
assert.equal(edgelessToCanvasDocument(nativeSurface, source, nativeSession).nodes.some((node) => node.id === 'image-1'), false);

nativeProjection.doc.dispose();
nativeProjection.doc.collection.dispose();

projection.doc.dispose();
projection.doc.collection.dispose();
console.log('BlockSuite Edgeless canvas projection tests passed');
