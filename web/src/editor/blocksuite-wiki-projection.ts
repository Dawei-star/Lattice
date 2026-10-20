import { renderMarkdown } from '../lib/markdown.ts';
import { parseStandaloneEmbed, parseWikiReferences, type WikiReference } from './wiki-reference.ts';

export interface BlockSuiteWikiProjectionOptions {
  resolveTitle?: (title: string) => unknown;
  resolveEmbed?: (title: string, heading?: string) => Promise<string | null | undefined> | string | null | undefined;
  onOpenWikiLink?: (title: string, heading?: string) => void;
  onCreateWikiLink?: (title: string, heading?: string) => void;
}

export interface BlockSuiteWikiProjectionController {
  refresh(): void;
  dispose(): void;
}

interface TextBlockModel {
  id: string;
  flavour: string;
  text?: { toString(): string };
}

interface ProjectionState {
  generation: number;
}

const TEXT_BLOCK_FLAVOURS = new Set([
  'affine:paragraph',
  'affine:list',
  'affine:embed-lattice-wiki-reference',
]);
const PROJECTION_ATTR = 'data-lattice-wiki-projection';
const ACTION_ATTR = 'data-lattice-wiki-action';
const SOURCE_ATTR = 'data-lattice-wiki-source';

/**
 * Additive runtime decorations for wiki links and embeds. The decorations are
 * deliberately outside the Doc so Markdown remains the durable representation.
 */
export function attachBlockSuiteWikiProjection(
  host: HTMLElement,
  doc: { getBlockById(id: string): unknown },
  options: BlockSuiteWikiProjectionOptions,
): BlockSuiteWikiProjectionController {
  let disposed = false;
  let scheduled = false;
  const states = new WeakMap<HTMLElement, ProjectionState>();

  const render = () => {
    if (disposed) return;
    scheduled = false;
    const liveBlocks = new Set<HTMLElement>();

    for (const element of host.querySelectorAll<HTMLElement>('[data-block-id]')) {
      const id = element.getAttribute('data-block-id');
      if (!id) continue;
      const model = doc.getBlockById(id) as TextBlockModel | null;
      if (!model || !TEXT_BLOCK_FLAVOURS.has(model.flavour)) continue;
      liveBlocks.add(element);
      renderBlock(element, model, options, states);
    }

    for (const element of host.querySelectorAll<HTMLElement>(`[${PROJECTION_ATTR}]`)) {
      const block = element.parentElement;
      if (!block || !liveBlocks.has(block)) element.remove();
    }
  };

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(render);
  };

  const observer = new window.MutationObserver(schedule);
  observer.observe(host, { childList: true, subtree: true });

  const handleClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>(`[${ACTION_ATTR}], [data-wiki-title]`);
    if (!action || !host.contains(action)) return;
    event.preventDefault();
    event.stopPropagation();
    const title = action.dataset.wikiTitle?.trim();
    if (!title) return;
    const heading = action.dataset.wikiHeading?.trim() || undefined;
    if (action.dataset.wikiState === 'missing' || action.classList.contains('is-dangling')) options.onCreateWikiLink?.(title, heading);
    else options.onOpenWikiLink?.(title, heading);
  };

  host.addEventListener('click', handleClick);
  schedule();

  return {
    refresh: schedule,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      host.removeEventListener('click', handleClick);
      host.querySelectorAll<HTMLElement>(`[${PROJECTION_ATTR}]`).forEach(element => element.remove());
    },
  };
}

function renderBlock(
  blockElement: HTMLElement,
  model: TextBlockModel,
  options: BlockSuiteWikiProjectionOptions,
  states: WeakMap<HTMLElement, ProjectionState>,
) {
  const text = model.text?.toString() ?? '';
  const references = parseWikiReferences(text);
  const standaloneEmbed = parseStandaloneEmbed(text);
  const previous = blockElement.querySelector<HTMLElement>(`:scope > [${PROJECTION_ATTR}]`);

  if (!references.length) {
    previous?.remove();
    states.delete(blockElement);
    return;
  }

  if (previous?.getAttribute(SOURCE_ATTR) === text) return;

  const state = { generation: (states.get(blockElement)?.generation ?? 0) + 1 };
  states.set(blockElement, state);
  previous?.remove();

  const projection = document.createElement('div');
  projection.setAttribute(PROJECTION_ATTR, '');
  projection.setAttribute(SOURCE_ATTR, text);
  projection.className = 'blocksuite-wiki-projection';
  projection.setAttribute('aria-label', '双链与嵌入');

  if (standaloneEmbed) {
    projection.appendChild(renderEmbedCard(standaloneEmbed, options, state, blockElement, states));
  } else {
    const items = document.createElement('div');
    items.className = 'blocksuite-wiki-projection__items';
    for (const reference of references) items.appendChild(renderReference(reference, options));
    projection.appendChild(items);
  }

  blockElement.appendChild(projection);
}

function renderReference(reference: WikiReference, options: BlockSuiteWikiProjectionOptions): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `blocksuite-wiki-projection__item is-${reference.kind}`;
  button.setAttribute(ACTION_ATTR, reference.kind);
  button.dataset.wikiTitle = reference.title;
  if (reference.heading) button.dataset.wikiHeading = reference.heading;
  if (!options.resolveTitle?.(reference.title)) {
    button.dataset.wikiState = 'missing';
    button.classList.add('is-dangling');
  }
  button.title = reference.kind === 'embed' ? `打开嵌入：${reference.title}` : `打开双链：${reference.title}`;
  button.textContent = reference.kind === 'embed'
    ? `嵌入 · ${reference.title}`
    : reference.alias || reference.title;
  return button;
}

function renderEmbedCard(
  reference: WikiReference,
  options: BlockSuiteWikiProjectionOptions,
  state: ProjectionState,
  blockElement: HTMLElement,
  states: WeakMap<HTMLElement, ProjectionState>,
): HTMLElement {
  const card = document.createElement('section');
  card.className = 'blocksuite-wiki-projection__embed';
  card.dataset.embedState = options.resolveTitle?.(reference.title) ? 'loading' : 'missing';

  const header = document.createElement('div');
  header.className = 'blocksuite-wiki-projection__embed-head';
  const badge = document.createElement('span');
  badge.className = 'blocksuite-wiki-projection__badge';
  badge.textContent = '嵌入';
  header.appendChild(badge);

  const button = renderReference(reference, options);
  button.className = 'blocksuite-wiki-projection__embed-link';
  header.appendChild(button);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'blocksuite-wiki-projection__embed-body';
  body.textContent = card.dataset.embedState === 'missing' ? '目标笔记尚不存在，点击标题可创建' : '正在载入…';
  card.appendChild(body);

  if (card.dataset.embedState !== 'missing' && options.resolveEmbed) {
    Promise.resolve().then(() => options.resolveEmbed!(reference.title, reference.heading)).then(content => {
      if (statesAreStale(blockElement, state, states)) return;
      if (!content) {
        card.dataset.embedState = 'empty';
        body.textContent = content === '' ? '目标笔记内容为空' : '无法载入目标笔记';
        return;
      }
      body.innerHTML = renderMarkdown(content, { resolveTitle: options.resolveTitle });
      card.dataset.embedState = 'ready';
      void hydrateNestedEmbeds(body, options, new Set([reference.title.toLowerCase()]), 1, () => statesAreStale(blockElement, state, states));
    }).catch(() => {
      if (!statesAreStale(blockElement, state, states)) {
        card.dataset.embedState = 'error';
        body.textContent = '嵌入载入失败';
      }
    });
  }

  return card;
}

async function hydrateNestedEmbeds(
  root: HTMLElement,
  options: BlockSuiteWikiProjectionOptions,
  trail: Set<string>,
  depth: number,
  isStale: () => boolean,
): Promise<void> {
  const pending = [...root.querySelectorAll<HTMLElement>('.note-embed[data-embed-state="loading"]')];
  for (const node of pending) {
    if (isStale()) return;
    const title = node.dataset.embedTitle?.trim() ?? '';
    const body = node.querySelector<HTMLElement>('.note-embed__body');
    if (!title || !body) continue;
    const key = title.toLowerCase();
    if (trail.has(key)) {
      setEmbedState(node, 'error', '检测到循环嵌入，已停止展开');
      continue;
    }
    if (depth >= 2) {
      setEmbedState(node, 'error', '已达到嵌套深度上限');
      continue;
    }

    let content: string | null | undefined = null;
    try {
      content = options.resolveEmbed ? await options.resolveEmbed(title, node.dataset.wikiHeading?.trim() || undefined) : null;
    } catch {
      content = null;
    }
    if (isStale()) return;
    if (content === null || content === undefined) {
      setEmbedState(node, 'missing', '目标笔记不存在，点击标题即可创建');
      continue;
    }
    if (!content.trim()) {
      setEmbedState(node, 'empty', '目标笔记内容为空');
      continue;
    }
    body.innerHTML = renderMarkdown(content, { resolveTitle: options.resolveTitle });
    node.dataset.embedState = 'ready';
    await hydrateNestedEmbeds(body, options, new Set([...trail, key]), depth + 1, isStale);
  }
}

function setEmbedState(node: HTMLElement, state: string, message: string) {
  node.dataset.embedState = state;
  const body = node.querySelector<HTMLElement>('.note-embed__body');
  if (body) body.textContent = message;
}

function statesAreStale(
  blockElement: HTMLElement,
  state: ProjectionState,
  states: WeakMap<HTMLElement, ProjectionState>,
): boolean {
  return !blockElement.isConnected || states.get(blockElement) !== state;
}
