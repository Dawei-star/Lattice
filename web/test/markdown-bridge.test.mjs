import assert from 'node:assert/strict';
import { installDom } from './dom-setup.mjs';

installDom();
class CSSStyleSheetStub {
  replaceSync() {}
}
globalThis.CSSStyleSheet = CSSStyleSheetStub;
window.CSSStyleSheet = CSSStyleSheetStub;
const { markdownToDoc, docToMarkdown, normalizeMarkdownForComparison } = await import('../src/editor/markdown-bridge.ts');
const { parseWikiReferences, parseStandaloneEmbed } = await import('../src/editor/wiki-reference.ts');
const { attachBlockSuiteWikiProjection } = await import('../src/editor/blocksuite-wiki-projection.ts');

const emptyProjection = await markdownToDoc('', '空白笔记');
const emptyNote = emptyProjection.doc.getBlockByFlavour('affine:note')[0];
assert.ok(emptyNote);
assert.equal(emptyNote.children.length, 1);
assert.equal(emptyNote.children[0].flavour, 'affine:paragraph');
assert.equal(docToMarkdown(emptyProjection.doc, emptyProjection.source), '');
emptyProjection.doc.dispose();
emptyProjection.doc.collection.dispose();

const source = `---\ntags: [p2, blocksuite]\n---\n\n# BlockSuite 投影\n\n正文与 [[双链]]。\n\n- 一项\n- [x] 已完成\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n\n---`;
const projection = await markdownToDoc(source, 'BlockSuite 投影');
const exported = docToMarkdown(projection.doc, source);

assert.match(exported, /^---\ntags: \[p2, blocksuite\]\n---/);
assert.match(exported, /# BlockSuite 投影/);
assert.match(exported, /\[\[双链\]\]/);
assert.match(exported, /- 一项/);
assert.match(exported, /- \[x\] 已完成/);
assert.match(exported, /```ts[\s\S]*const answer = 42;/);
assert.match(exported, /---$/);
assert.equal(normalizeMarkdownForComparison(exported), normalizeMarkdownForComparison(exported));

const richSource = [
  '---',
  'tags: [rich]',
  '---',
  '',
  '# Rich bridge',
  '',
  '| A | B |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '$$',
  'x^2',
  '$$',
].join('\n');
const richProjection = await markdownToDoc(richSource, 'Rich bridge');
assert.equal(normalizeMarkdownForComparison(docToMarkdown(richProjection.doc, richProjection.source)), normalizeMarkdownForComparison(richSource));
const richHeading = richProjection.doc.getBlockByFlavour('affine:note')[0].children.find((block) => block.flavour === 'affine:paragraph' && block.type === 'h1');
assert.ok(richHeading);
richHeading.text.delete(0, richHeading.text.toString().length);
richHeading.text.insert('Edited bridge', 0);
const editedRich = docToMarkdown(richProjection.doc, richProjection.source);
assert.match(editedRich, /tags: \[rich\]/);
assert.match(editedRich, /\| A \| B \|/);
assert.match(editedRich, /\$\$\nx\^2\n\$\$/);
richProjection.doc.dispose();
richProjection.doc.collection.dispose();

const nativeEmbedProjection = await markdownToDoc('正文\n\n![[原生嵌入]]\n', 'Native embed');
const nativeEmbedBlocks = nativeEmbedProjection.doc.getBlocksByFlavour('affine:embed-lattice-wiki-reference');
assert.equal(nativeEmbedBlocks.length, 1);
assert.equal(nativeEmbedBlocks[0].model.text.toString(), '![[原生嵌入]]');
assert.match(docToMarkdown(nativeEmbedProjection.doc, nativeEmbedProjection.source), /!\[\[原生嵌入\]\]/);
nativeEmbedProjection.doc.dispose();
nativeEmbedProjection.doc.collection.dispose();

assert.deepEqual(parseWikiReferences('A [[目标#章节|别名]] and ![[嵌入笔记]]'), [
  { kind: 'link', title: '目标', heading: '章节', alias: '别名', raw: '[[目标#章节|别名]]', start: 2, end: 14 },
  { kind: 'embed', title: '嵌入笔记', heading: undefined, alias: undefined, raw: '![[嵌入笔记]]', start: 19, end: 28 },
]);
assert.equal(parseStandaloneEmbed(' ![[独占嵌入]] ' )?.title, '独占嵌入');
assert.equal(parseStandaloneEmbed('正文 ![[非独占]]'), null);
assert.equal(parseWikiReferences('`[[代码里的方括号]]` [[真正的链接]]').length, 1);

const projectionHost = document.createElement('div');
document.body.appendChild(projectionHost);
const blockModel = {
  id: 'block-1',
  flavour: 'affine:paragraph',
  text: { toString: () => '关联 [[已有笔记#章节|别名]] 与 [[待创建]]' },
};
const opened = [];
const created = [];
const embedRequests = [];
const projectionController = attachBlockSuiteWikiProjection(
  projectionHost,
  { getBlockById: (id) => id === blockModel.id ? blockModel : null },
  {
    resolveTitle: (title) => ['已有笔记', '嵌入笔记'].includes(title) ? { id: 'note-1' } : null,
    resolveEmbed: async (title, heading) => {
      embedRequests.push([title, heading]);
      return '<script>bad()</script><p>安全正文</p>';
    },
    onOpenWikiLink: (title, heading) => opened.push([title, heading]),
    onCreateWikiLink: (title) => created.push(title),
  },
);
const blockElement = document.createElement('div');
blockElement.dataset.blockId = blockModel.id;
projectionHost.appendChild(blockElement);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(projectionHost.querySelectorAll('[data-lattice-wiki-projection] button').length, 2);
projectionHost.querySelector('[data-wiki-title="已有笔记"]')?.click();
projectionHost.querySelector('[data-wiki-title="待创建"]')?.click();
assert.deepEqual(opened, [['已有笔记', '章节']]);
assert.deepEqual(created, ['待创建']);

blockModel.text.toString = () => '![[嵌入笔记#安全章节]]';
projectionController.refresh();
await new Promise((resolve) => setTimeout(resolve, 0));
const embedBody = projectionHost.querySelector('.blocksuite-wiki-projection__embed-body');
assert.ok(embedBody);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(embedBody.querySelector('script'), null);
assert.match(embedBody.textContent, /安全正文/);
assert.deepEqual(embedRequests, [['嵌入笔记', '安全章节']]);
projectionController.dispose();
projectionHost.remove();

projection.doc.dispose();
projection.doc.collection.dispose();
console.log('markdown bridge round-trip tests passed');
