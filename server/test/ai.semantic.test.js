import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 语义索引与检索测试：需要真实 schema（迁移 004），先指到临时库再跑迁移
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-semantic-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { runMigrations } = await import('../src/db/migrate.js');
runMigrations();

const { chunkNoteContent, chunkEmbedText, storeNoteChunks, searchVectors, noteMeanVector, cosineSimilarity, indexStatus } = await import('../src/modules/ai/ai.embeddings.js');
const { scheduleNoteIndex, indexNote } = await import('../src/modules/ai/ai.indexer.js');
const { createSession, appendMessage, listMessages, listSessions, listSessionPage, renameSession, deleteSession, getSession } = await import('../src/modules/ai/ai.sessions.js');
const { loadServerSettings, saveServerSettings, resolveChatProvider, resolveEmbeddingProvider } = await import('../src/modules/ai/ai.settings.js');
const { validateCitations, buildContextSections } = await import('../src/modules/ai/ai.retrieval.js');
const { getDb } = await import('../src/db/index.js');

function insertNote(id, title, content) {
  const timestamp = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO notes (id, title, content, is_pinned, word_count, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(id, title, content, content.length, `hash-${id}`, timestamp, timestamp);
}

test('chunkNoteContent splits by headings and carries anchor paths', () => {
  const content = [
    '# 项目总览',
    '',
    '总览正文。',
    '',
    '## 背景',
    '',
    '背景正文，描述为什么做这个项目。',
    '',
    '## 方案',
    '',
    '### 数据库选型',
    '',
    '选择 SQLite，因为零原生依赖。',
  ].join('\n');

  const chunks = chunkNoteContent('项目笔记', content);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.some((chunk) => chunk.anchor === '项目总览 > 背景'));
  assert.ok(chunks.some((chunk) => chunk.anchor === '项目总览 > 方案 > 数据库选型'));
  assert.ok(chunks.every((chunk) => chunk.content.length <= 900));
  // 喂给模型的文本应带标题与锚点
  const embedded = chunkEmbedText('项目笔记', chunks.at(-1));
  assert.ok(embedded.startsWith('项目笔记'));
  assert.ok(embedded.includes('数据库选型'));
});

test('storeNoteChunks reuses vectors for unchanged chunks across rewrites', () => {
  const noteId = 'note-vec-1';
  insertNote(noteId, '向量笔记', 'alpha 内容\n\nbeta 内容');

  const first = chunkNoteContent('向量笔记', 'alpha 内容\n\nbeta 内容');
  const v1 = new Float32Array([1, 0, 0]);
  const v2 = new Float32Array([0, 1, 0]);
  storeNoteChunks(noteId, { chunks: first, vectors: [v1, v2], model: 'test-embed', noteContentHash: 'hash-a' });

  // 相同内容重写：不传向量也应沿用旧向量（捕获-重写路径）
  const second = chunkNoteContent('向量笔记', 'alpha 内容\n\nbeta 内容');
  storeNoteChunks(noteId, { chunks: second, vectors: null, model: 'test-embed', noteContentHash: 'hash-b' });
  const hits = searchVectors(v1, { model: 'test-embed' });
  assert.ok(hits.some((hit) => hit.noteId === noteId && hit.score > 0.99), '内容未变的块应保留旧向量');
});

test('searchVectors ranks by cosine similarity and respects model filter', () => {
  const noteA = 'note-vec-a';
  const noteB = 'note-vec-b';
  insertNote(noteA, 'A', 'a');
  insertNote(noteB, 'B', 'b');
  storeNoteChunks(noteA, { chunks: [{ anchor: '', content: 'a', contentHash: 'ha' }], vectors: [new Float32Array([1, 0])], model: 'm2', noteContentHash: 'x' });
  storeNoteChunks(noteB, { chunks: [{ anchor: '', content: 'b', contentHash: 'hb' }], vectors: [new Float32Array([0, 1])], model: 'm2', noteContentHash: 'y' });

  const hits = searchVectors(new Float32Array([0.9, 0.1]), { model: 'm2' });
  assert.equal(hits[0].noteId, noteA);
  assert.ok(hits[0].score > hits[1].score);
  // 模型过滤：另一个模型的向量不可见
  assert.equal(searchVectors(new Float32Array([1, 0]), { model: 'other-model' }).length, 0);
  assert.equal(noteMeanVector(noteA, 'm2').length, 2);
  assert.equal(noteMeanVector(noteA, 'missing'), null);
});

test('cosineSimilarity handles zero vectors and dimension mismatch', () => {
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  assert.equal(cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2])), 0);
  assert.ok(Math.abs(cosineSimilarity(new Float32Array([2, 0]), new Float32Array([3, 0])) - 1) < 1e-9);
});

test('indexer marks notes pending without embedding config and skips indexing safely', async () => {
  const noteId = 'note-idx-1';
  insertNote(noteId, '索引笔记', '正文');
  scheduleNoteIndex(noteId);
  const result = await indexNote(noteId);
  assert.equal(result.status, 'skipped-unconfigured');
  const status = indexStatus();
  assert.equal(status.configured, false);
  assert.ok(status.totalNotes >= 1);
});

test('indexStatus surfaces the latest failure message for the panel', () => {
  const noteId = 'note-idx-error';
  insertNote(noteId, '失败笔记', '正文');
  getDb().prepare(
    `INSERT INTO ai_index_state (note_id, content_hash, model, chunk_count, status, error, attempts, updated_at)
       VALUES (?, ?, ?, 0, 'failed', ?, 1, ?)`,
  ).run(noteId, 'hash-error', 'BAAI/bge-m3', '外部模型服务返回 400：测试失败原因', new Date().toISOString());
  const status = indexStatus();
  assert.ok(status.failed >= 1);
  assert.match(status.latestError.message, /测试失败原因/);
  assert.ok(status.latestError.updatedAt);
});

test('sessions persist turns, autotitle from first user message, and support rename/delete', () => {
  const session = createSession({});
  appendMessage(session.id, { role: 'user', content: '帮我总结项目笔记的关键结论', autotitle: true });
  appendMessage(session.id, { role: 'assistant', content: '结论是……', payload: { references: [{ id: 'n1', title: '项目笔记' }] } });

  const reloaded = getSession(session.id);
  assert.equal(reloaded.title, '帮我总结项目笔记的关键结论');

  const messages = listMessages(session.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].payload.references[0].title, '项目笔记');

  const forModel = listMessages(session.id, { forModel: true });
  assert.deepEqual(forModel.map((entry) => entry.role), ['user', 'assistant']);

  assert.equal(renameSession(session.id, '新标题'), true);
  assert.equal(getSession(session.id).title, '新标题');

  const expertSession = createSession({ title: '研究会话', expertId: 'knowledge-researcher' });
  assert.ok(listSessions({ expertId: 'knowledge-researcher' }).some((item) => item.id === expertSession.id));
  assert.ok(!listSessions({ expertId: 'general' }).some((item) => item.id === expertSession.id));
  assert.equal(getSession(expertSession.id).expertId, 'knowledge-researcher');
  assert.equal(deleteSession(expertSession.id), true);

  assert.equal(deleteSession(session.id), true);
  assert.equal(getSession(session.id), null);
});

test('model history preserves completed tool results for the next turn', () => {
  const session = createSession({ title: '工具续接' });
  appendMessage(session.id, { role: 'user', content: '读取知识库状态' });
  appendMessage(session.id, {
    role: 'assistant',
    content: '我已读取知识库状态。',
    payload: {
      meta: {
        toolExecutions: [{
          kind: 'mcp',
          server: 'lattice',
          tool: 'read_graph',
          transport: 'stdio',
          ok: true,
          result: '{"nodes":3}',
        }],
      },
    },
  });

  const modelMessages = listMessages(session.id, { forModel: true });
  assert.match(modelMessages.at(-1).content, /read_graph/);
  assert.match(modelMessages.at(-1).content, /\{"nodes":3\}/);
  assert.match(modelMessages.at(-1).content, /不要因为用户说/);
});

test('model history reads the newest window when a session exceeds the query limit', () => {
  const session = createSession({ title: '超长上下文' });
  for (let index = 1; index <= 2_005; index += 1) {
    appendMessage(session.id, {
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `history-${index}`,
    });
  }

  const modelMessages = listMessages(session.id, { forModel: true, limit: 2_000 });
  assert.equal(modelMessages.length, 2_000);
  assert.equal(modelMessages[0].content, 'history-6');
  assert.equal(modelMessages.at(-1).content, 'history-2005');
  assert.equal(modelMessages[0].role, 'assistant');
  assert.equal(modelMessages.at(-1).role, 'user');
});

test('session listing searches titles or message content and paginates', () => {
  const titleMatch = createSession({ title: '整理 Vault 的文件', expertId: 'general' });
  const contentMatch = createSession({ title: '项目回顾', expertId: 'general' });
  appendMessage(contentMatch.id, { role: 'user', content: '查找只出现在正文里的唯一关键词 session-body-needle' });

  const titlePage = listSessionPage({ expertId: 'general', query: '整理 Vault', limit: 1 });
  assert.equal(titlePage.total, 1);
  assert.equal(titlePage.items[0].id, titleMatch.id);

  const titleOnlyBodySearch = listSessionPage({ expertId: 'general', query: 'session-body-needle' });
  assert.equal(titleOnlyBodySearch.total, 0);
  const contentPage = listSessionPage({ expertId: 'general', query: 'session-body-needle', searchContent: true });
  assert.equal(contentPage.total, 1);
  assert.equal(contentPage.items[0].id, contentMatch.id);

  const firstPage = listSessionPage({ expertId: 'general', limit: 1, offset: 0 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.limit, 1);
  assert.ok(firstPage.hasMore);

  assert.equal(deleteSession(titleMatch.id), true);
  assert.equal(deleteSession(contentMatch.id), true);
});

test('server settings roundtrip drives provider resolution', () => {
  saveServerSettings({
    providers: [{ id: 'p1', endpoint: 'https://api.example.com/v1', model: 'm', apiKey: 'k', authHeader: 'bearer' }],
    activeProviderId: 'p1',
    embedding: { endpoint: 'https://api.example.com/v1/embeddings', model: 'e', apiKey: 'k', authHeader: 'bearer' },
  });
  const loaded = loadServerSettings();
  assert.equal(loaded.providers.length, 1);
  assert.equal(resolveChatProvider(null)?.id, 'p1');
  assert.equal(resolveChatProvider({ endpoint: 'https://x/v1', apiKey: 'direct' }).apiKey, 'direct', '显式 provider 优先于服务端配置');
  assert.equal(resolveEmbeddingProvider()?.model, 'e');

  // 未配置 embedding 时 resolve 返回 null
  saveServerSettings({ providers: [], activeProviderId: null, embedding: null });
  assert.equal(resolveChatProvider(null), null);
  assert.equal(resolveEmbeddingProvider(), null);
});

test('validateCitations maps [n] markers to real blocks and drops fabricated ones', () => {
  const { citations } = buildContextSections([
    { noteId: 'n1', title: '笔记一', filePath: 'a.md', anchor: '背景', excerpt: '背景内容'.repeat(10), wholeNote: false },
    { noteId: 'n2', title: '笔记二', filePath: 'b.md', anchor: '', excerpt: '内容二', wholeNote: false },
  ]);

  assert.equal(citations.length, 2);
  assert.equal(citations[0].number, 1);
  assert.equal(citations[0].anchor, '背景');

  const reply = '项目背景如前述 [1]，另外 [9] 是编造的引用。';
  const { validated, references } = validateCitations(reply, citations);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].id, 'n1');
  assert.equal(validated[0].anchor, '背景');
  assert.equal(references.length, 1);
  assert.equal(references[0].inferred, undefined, '模型真实标注的引用不带 inferred 标记');

  // 完全没标引用时退回「参考来源」，显式标记 inferred
  const fallback = validateCitations('一段没有任何标注的回答', citations);
  assert.equal(fallback.validated.length, 0);
  assert.ok(fallback.references.length >= 1);
  assert.equal(fallback.references[0].inferred, true);
});

test('new protocol: markdown reply + lattice-actions fence, and legacy JSON both parse', async () => {
  const { parseAssistantPayload } = await import('../src/modules/ai/ai.service.js');

  // 新协议：Markdown 正文 + 末尾围栏动作
  const markdown = '先看结论：**项目按期上线**。\n\n```lattice-actions\n[{"type":"read","path":"notes/a.md"}]\n```';
  const parsed = parseAssistantPayload(markdown);
  assert.equal(parsed.reply, '先看结论：**项目按期上线**。');
  assert.deepEqual(parsed.actions, [{ type: 'read', path: 'notes/a.md' }]);

  // 旧协议：整体 JSON（存量自动化兼容）
  const legacy = JSON.stringify({ reply: '旧协议回复', suggestions: ['x'], references: [], actions: [{ type: 'create', path: 'b.md', content: '' }] });
  const legacyParsed = parseAssistantPayload(legacy);
  assert.equal(legacyParsed.reply, '旧协议回复');
  assert.equal(legacyParsed.actions.length, 1);

  // 围栏 JSON 损坏：动作清空、正文照常
  const broken = '正文照常。\n\n```lattice-actions\n{不是JSON}\n```';
  const brokenParsed = parseAssistantPayload(broken);
  assert.equal(brokenParsed.reply, '正文照常。');
  assert.deepEqual(brokenParsed.actions, []);

  // 纯文本兜底
  assert.equal(parseAssistantPayload('就是一段话').reply, '就是一段话');
});
