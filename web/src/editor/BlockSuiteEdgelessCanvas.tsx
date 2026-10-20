import { effects as blockEffects } from '@blocksuite/blocks/effects';
import { effects as presetEffects } from '@blocksuite/presets/effects';
import { createEmptyDoc } from '@blocksuite/presets';
import { GfxControllerIdentifier } from '@blocksuite/block-std/gfx';
import type { SurfaceBlockModel } from '@blocksuite/affine-block-surface';
import type { Doc } from '@blocksuite/store';
import { useEffect, useRef, useState } from 'react';
import { canvasApi } from '../api/canvas.ts';
import type { CanvasDocument } from '../api/canvas.ts';
import { vaultFiles } from '../api/vault-files.ts';
import type { NoteIndexRow } from '../hooks/useVault.ts';
import { canvasDocumentToEdgeless, edgelessToCanvasDocument, readProjectedNode } from './blocksuite-edgeless-bridge.ts';

interface EdgelessElement extends HTMLElement {
  doc: Doc;
  mode: 'page' | 'edgeless';
  std?: { get<T>(identifier: unknown): T };
}

export interface BlockSuiteEdgelessCanvasProps {
  canvasPath?: string;
  noteIndex?: NoteIndexRow[];
  activeNoteId?: string | null;
  onOpenNote?: (id: string | null) => void;
  blockedPaths?: Set<string>;
}

// Page and Edgeless share the same BlockSuite custom-element registry. Keep a
// single process-wide effects guard so switching views never re-registers it.
const EFFECTS_KEY = '__lattice_blocksuite_effects__';

function ensureBlockSuiteEffects() {
  const runtime = globalThis as typeof globalThis & { [EFFECTS_KEY]?: boolean };
  if (runtime[EFFECTS_KEY]) return;
  blockEffects();
  presetEffects();
  runtime[EFFECTS_KEY] = true;
}

export default function BlockSuiteEdgelessCanvas({ canvasPath = '画板.canvas', noteIndex = [], onOpenNote, blockedPaths }: BlockSuiteEdgelessCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [nodeCount, setNodeCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let doc: Doc | null = null;
    let element: EdgelessElement | null = null;
    let saveTimer = 0;
    let saveQueue = Promise.resolve();
    let savePending = false;
    let source: CanvasDocument = { nodes: [], edges: [] };
    let imageLoadInFlight: Promise<Map<string, string>> | null = null;
    let docDisposed = false;

    const disposeProjection = () => {
      if (docDisposed || imageLoadInFlight || !doc) return;
      docDisposed = true;
      doc.dispose();
      doc.collection.dispose();
      doc = null;
    };

    async function mount() {
      try {
        ensureBlockSuiteEffects();
        source = await canvasApi.get(canvasPath);
        if (cancelled || !hostRef.current) return;

        const projection = createEmptyDoc();
        projection.init();
        doc = projection.doc;
        const surface = doc.getBlockByFlavour('affine:surface')[0] as unknown as SurfaceBlockModel | undefined;
        if (!surface) throw new Error('BlockSuite Edgeless surface 初始化失败');
        imageLoadInFlight = loadImageSources(doc, source, canvasPath, () => cancelled);
        const imageSources = await imageLoadInFlight;
        imageLoadInFlight = null;
        if (cancelled) {
          disposeProjection();
          return;
        }
        const projectionSession = canvasDocumentToEdgeless(surface, source, { imageSources });
        setNodeCount(projectionSession.nodeElementIds.size);

        element = document.createElement('affine-editor-container') as EdgelessElement;
        element.doc = doc;
        element.mode = 'edgeless';
        element.className = 'blocksuite-edgeless-canvas__container';
        element.setAttribute('aria-label', 'BlockSuite Edgeless 画布');
        hostRef.current.replaceChildren(element);

        const editor = element as EdgelessElement & { std?: { get<T>(identifier: unknown): T } };
        const gfx = editor.std?.get<{ selection: { selectedElements: Array<{ yMap: { get(key: string): unknown } }> } }>(GfxControllerIdentifier);
        const openSelectedNote = () => {
          const selected = gfx?.selection.selectedElements?.[0];
          const node = readProjectedNode(selected?.yMap.get('latticeNodeJson'))
            ?? (selected ? projectionSession.nodesByElementId.get((selected as unknown as { id: string }).id) ?? null : null);
          if (!node || node.type !== 'file') return;
          const linked = resolveNote(node, noteIndex);
          if (linked) onOpenNote?.(linked.id);
        };
        element.addEventListener('dblclick', openSelectedNote);

        const scheduleSave = () => {
          if (cancelled || blockedPaths?.has(canvasPath)) return;
          savePending = true;
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            savePending = false;
            const next = edgelessToCanvasDocument(surface, source, projectionSession);
            saveQueue = saveQueue
              .catch(() => undefined)
              .then(() => {
                if (blockedPaths?.has(canvasPath)) return undefined;
                return canvasApi.save(canvasPath, next).then(() => undefined);
              })
              .catch(() => undefined);
          }, 500);
        };
        const disposables = [
          surface.elementAdded.on(scheduleSave),
          surface.elementUpdated.on(scheduleSave),
          surface.elementRemoved.on(scheduleSave),
          doc.slots.blockUpdated.on(scheduleSave),
        ];
        setState('ready');
        setError('');

        const cleanup = () => {
          element?.removeEventListener('dblclick', openSelectedNote);
          disposables.forEach((dispose) => dispose.dispose());
          window.clearTimeout(saveTimer);
          if (savePending && !blockedPaths?.has(canvasPath)) {
            savePending = false;
            const next = edgelessToCanvasDocument(surface, source, projectionSession);
            saveQueue = saveQueue
              .catch(() => undefined)
              .then(() => {
                if (blockedPaths?.has(canvasPath)) return undefined;
                return canvasApi.save(canvasPath, next).then(() => undefined);
              })
              .catch(() => undefined);
          }
        };
        (element as EdgelessElement & { __latticeCleanup?: () => void }).__latticeCleanup = cleanup;
      } catch (mountError) {
        imageLoadInFlight = null;
        disposeProjection();
        if (!cancelled) {
          setState('error');
          setError(mountError instanceof Error ? mountError.message : 'BlockSuite Edgeless 加载失败');
        }
      }
    }

    void mount();
    return () => {
      cancelled = true;
      window.clearTimeout(saveTimer);
      (element as EdgelessElement & { __latticeCleanup?: () => void })?.__latticeCleanup?.();
      element?.remove();
      disposeProjection();
    };
  }, [canvasPath, blockedPaths, noteIndex, onOpenNote]);

  return (
    <section className="blocksuite-edgeless-canvas" aria-label="BlockSuite Edgeless 画布">
      <div ref={hostRef} className={`blocksuite-edgeless-canvas__host ${state === 'error' ? 'is-error' : ''}`} />
      {state === 'loading' ? <div className="blocksuite-edgeless-canvas__state">正在加载 Edgeless 画布…</div> : null}
      {state === 'error' ? <div className="blocksuite-edgeless-canvas__state" role="alert">{error}</div> : null}
      <div className="blocksuite-edgeless-canvas__status" aria-live="polite">
        <span className={`blocksuite-edgeless-canvas__dot is-${state}`} />
        <span>{state === 'ready' ? `Edgeless · ${nodeCount} 个对象` : state === 'loading' ? '正在加载' : 'Edgeless 加载失败'}</span>
      </div>
    </section>
  );
}

async function loadImageSources(
  doc: Doc,
  source: CanvasDocument,
  canvasPath: string,
  isCancelled?: () => boolean,
): Promise<Map<string, string>> {
  const imageSources = new Map<string, string>();
  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  for (const candidate of nodes) {
    if (isCancelled?.()) return imageSources;
    if (!candidate || typeof candidate !== 'object') continue;
    const node = candidate as { id?: unknown; type?: unknown; path?: unknown; file?: unknown };
    if (node.type !== 'image' || typeof node.id !== 'string') continue;
    const reference = typeof node.path === 'string' ? node.path : typeof node.file === 'string' ? node.file : '';
    const path = resolveCanvasImagePath(canvasPath, reference);
    if (!path) continue;
    try {
      const blob = await vaultFiles.readBlob(path);
      if (isCancelled?.()) return imageSources;
      if (!blob || !blob.type.startsWith('image/')) continue;
      imageSources.set(node.id, await doc.blobSync.set(blob));
    } catch {
      // A missing image should leave the canvas usable; the bridge keeps the
      // original node as a visible metadata card when no blob is available.
    }
  }
  return imageSources;
}

function resolveCanvasImagePath(canvasPath: string, reference: string): string | null {
  let value = String(reference ?? '').trim();
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  value = value.replaceAll('\\', '/').split('#')[0].split('?')[0];
  const parts = value.startsWith('/') ? [] : String(canvasPath).replaceAll('\\', '/').split('/').slice(0, -1);
  for (const part of value.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/') || null;
}

function resolveNote(node: { noteId?: string; file?: string; path?: string; text?: string }, notes: NoteIndexRow[]): NoteIndexRow | null {
  if (node.noteId) return notes.find((note) => note.id === node.noteId) ?? null;
  const source = node.file || node.path || '';
  const stem = source.split('/').pop()?.replace(/\.md$/i, '') || node.text || '';
  return notes.find((note) => note.title === stem || note.filePath?.replace(/\.md$/i, '') === source.replace(/\.md$/i, '')) ?? null;
}
