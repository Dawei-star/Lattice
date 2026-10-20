import { effects as blockEffects } from '@blocksuite/blocks/effects';
import { effects as presetEffects } from '@blocksuite/presets/effects';
import type { ExtensionType } from '@blocksuite/block-std';
import { useEffect, useRef, useState } from 'react';
import { attachBlockSuiteWikiProjection } from './blocksuite-wiki-projection.ts';
import { LatticeWikiReferenceBlockSpec } from './blocksuite-wiki-reference.ts';
import { docToMarkdown, markdownToDoc } from './markdown-bridge.ts';

export interface BlockSuiteEditorProps {
  markdown: string;
  title?: string;
  documentKey: string;
  readOnly?: boolean;
  onChange: (markdown: string) => void;
  resolveTitle?: (title: string) => unknown;
  resolveEmbed?: (title: string, heading?: string) => Promise<string | null | undefined> | string | null | undefined;
  onOpenWikiLink?: (title: string, heading?: string) => void;
  onCreateWikiLink?: (title: string, heading?: string) => void;
}

interface AffineEditorElement extends HTMLElement {
  doc: unknown;
  mode: 'page' | 'edgeless';
  autofocus: boolean;
  pageSpecs: ExtensionType[];
}

const EFFECTS_KEY = '__lattice_blocksuite_effects__';

function ensureBlockSuiteEffects() {
  const runtime = globalThis as typeof globalThis & { [EFFECTS_KEY]?: boolean };
  if (runtime[EFFECTS_KEY]) return;
  blockEffects();
  presetEffects();
  runtime[EFFECTS_KEY] = true;
}

/** React host for the BlockSuite page editor. The Doc is intentionally disposable. */
export default function BlockSuiteEditor({
  markdown,
  title = '',
  documentKey,
  readOnly = false,
  onChange,
  resolveTitle,
  resolveEmbed,
  onOpenWikiLink,
  onCreateWikiLink,
}: BlockSuiteEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const resolveTitleRef = useRef(resolveTitle);
  const resolveEmbedRef = useRef(resolveEmbed);
  const onOpenWikiLinkRef = useRef(onOpenWikiLink);
  const onCreateWikiLinkRef = useRef(onCreateWikiLink);
  const documentKeyRef = useRef(documentKey);
  const lastProjectedMarkdownRef = useRef(markdown);
  const [projectionRevision, setProjectionRevision] = useState(0);
  const [error, setError] = useState('');
  onChangeRef.current = onChange;
  resolveTitleRef.current = resolveTitle;
  resolveEmbedRef.current = resolveEmbed;
  onOpenWikiLinkRef.current = onOpenWikiLink;
  onCreateWikiLinkRef.current = onCreateWikiLink;
  ensureBlockSuiteEffects();

  // Keep external programmatic updates (AI output, history restore, or a clean
  // SSE refresh) in sync without remounting the editor for every local edit.
  useEffect(() => {
    if (documentKeyRef.current !== documentKey) {
      documentKeyRef.current = documentKey;
      lastProjectedMarkdownRef.current = markdown;
    }
  }, [documentKey, markdown]);

  useEffect(() => {
    if (markdown === lastProjectedMarkdownRef.current) return;
    lastProjectedMarkdownRef.current = markdown;
    setProjectionRevision((current) => current + 1);
  }, [markdown]);

  useEffect(() => {
    let cancelled = false;
    let doc: Awaited<ReturnType<typeof markdownToDoc>>['doc'] | null = null;
    let element: AffineEditorElement | null = null;
    let wikiProjection: ReturnType<typeof attachBlockSuiteWikiProjection> | null = null;
    let composing = false;
    let pendingMarkdown: string | null = null;
    let handleCompositionStart: (() => void) | null = null;
    let handleCompositionEnd: (() => void) | null = null;
    let blockUpdatedSubscription: { dispose(): void } | null = null;

    const flushMarkdown = (projection: Awaited<ReturnType<typeof markdownToDoc>>) => {
      if (readOnly) return;
      const next = pendingMarkdown ?? docToMarkdown(projection.doc, projection.source);
      pendingMarkdown = null;
      lastProjectedMarkdownRef.current = next;
      onChangeRef.current(next);
    };

    async function mount() {
      try {
        const projection = await markdownToDoc(markdown, title);
        if (cancelled || !hostRef.current) {
          projection.doc.dispose();
          projection.doc.collection.dispose();
          return;
        }
        doc = projection.doc;
        element = document.createElement('affine-editor-container') as AffineEditorElement;
        element.doc = projection.doc;
        element.mode = 'page';
        element.pageSpecs = [...element.pageSpecs, ...LatticeWikiReferenceBlockSpec];
        // Lattice owns the note title in the outer input. BlockSuite's page
        // title is a duplicate and its autofocus would steal the caret from
        // the body every time the disposable projection is mounted.
        element.autofocus = false;
        element.className = 'blocksuite-editor__container';
        element.setAttribute('aria-label', 'BlockSuite 笔记编辑器');
        if (readOnly) element.setAttribute('aria-readonly', 'true');
        hostRef.current.replaceChildren(element);
        handleCompositionStart = () => {
          composing = true;
        };
        handleCompositionEnd = () => {
          composing = false;
          if (pendingMarkdown !== null) flushMarkdown(projection);
        };
        element.addEventListener('compositionstart', handleCompositionStart, true);
        element.addEventListener('compositionend', handleCompositionEnd, true);
        element.addEventListener('compositioncancel', handleCompositionEnd, true);
        const mountedWikiProjection = attachBlockSuiteWikiProjection(element, projection.doc, {
          resolveTitle: (referenceTitle) => resolveTitleRef.current?.(referenceTitle),
          resolveEmbed: (referenceTitle, heading) => resolveEmbedRef.current?.(referenceTitle, heading),
          onOpenWikiLink: (referenceTitle, heading) => onOpenWikiLinkRef.current?.(referenceTitle, heading),
          onCreateWikiLink: (referenceTitle, heading) => onCreateWikiLinkRef.current?.(referenceTitle, heading),
        });
        wikiProjection = mountedWikiProjection;

        blockUpdatedSubscription = doc.slots.blockUpdated.on(() => {
          if (!cancelled && doc) {
            mountedWikiProjection.refresh();
            if (readOnly) return;
            if (composing) {
              pendingMarkdown = docToMarkdown(projection.doc, projection.source);
              return;
            }
            flushMarkdown(projection);
          }
        });
        setError('');
      } catch (mountError) {
        if (!cancelled) setError(mountError instanceof Error ? mountError.message : 'BlockSuite 编辑器加载失败');
      }
    }

    void mount();
    return () => {
      cancelled = true;
      wikiProjection?.dispose();
      wikiProjection = null;
      blockUpdatedSubscription?.dispose();
      blockUpdatedSubscription = null;
      if (element && handleCompositionStart) element.removeEventListener('compositionstart', handleCompositionStart, true);
      if (element && handleCompositionEnd) {
        element.removeEventListener('compositionend', handleCompositionEnd, true);
        element.removeEventListener('compositioncancel', handleCompositionEnd, true);
      }
      element?.remove();
      if (doc) {
        doc.dispose();
        doc.collection.dispose();
      }
    };
  }, [documentKey, projectionRevision, readOnly]);

  return (
    <div ref={hostRef} className={`blocksuite-editor ${error ? 'is-error' : ''}`}>
      {error ? <div className="blocksuite-editor__error" role="alert">{error}</div> : <div className="blocksuite-editor__loading">正在加载块编辑器…</div>}
    </div>
  );
}
