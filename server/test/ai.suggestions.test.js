import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 智能建议测试：需要真实 schema，先指到临时库再跑迁移
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-suggest-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { runMigrations } = await import('../src/db/migrate.js');
runMigrations();

const { suggestForNote, tokenize } = await import('../src/modules/ai/ai.suggestions.js');
const { getDb } = await import('../src/db/index.js');

const now = new Date().toISOString();
function insertNote(id, title, content) {
  getDb().prepare(
    `INSERT INTO notes (id, title, content, is_pinned, word_count, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(id, title, content, content.length, `hash-${id}`, now, now);
}

test('tokenize splits CJK titles into bigrams and keeps latin words', () => {
  assert.deepEqual(tokenize('产品设计评审 Review'), ['review', '产品', '品设', '设计', '计评', '评审']);
  assert.deepEqual(tokenize('A'), [], '单字符词应被过滤（trigram 需要 ≥2 字）');
});

test('suggestTags recommends existing-vocabulary tags by title/content hits', async () => {
  const db = getDb();
  // 词表：库中已有 3 个标签
  for (const name of ['产品设计', '前端', '归档']) {
    db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(`tag-${name}`, name, now);
  }

  const noteId = 'note-suggest-1';
  insertNote(noteId, '产品设计评审纪要', '这次评审讨论了产品设计细节，无前端内容。');

  const { tags } = await suggestForNote(noteId);
  const names = tags.map((item) => item.name);
  assert.ok(names.includes('产品设计'), '标题命中的标签应被推荐');
  assert.equal(names.includes('归档'), false, '无关标签不应出现');
  const hit = tags.find((item) => item.name === '产品设计');
  assert.equal(hit.matchedIn, '标题');
  assert.ok(hit.score >= 3);
});

test('suggestLinks falls back to keyword channel and excludes self and linked notes', async () => {
  const db = getDb();
  const selfId = 'note-suggest-1';

  insertNote('note-target', '产品设计规范', '配套的设计规范文档。');
  insertNote('note-linked', '产品设计回顾', '已经链接过的笔记。');
  // 建立已有出链：self → note-linked
  db.prepare('INSERT INTO links (source_note_id, target_title, target_note_id, created_at) VALUES (?, ?, ?, ?)')
    .run(selfId, '产品设计回顾', 'note-linked', now);

  const { links, semanticAvailable } = await suggestForNote(selfId);
  assert.equal(semanticAvailable, false, '未配置 embedding 时语义路不可用');
  const ids = links.map((item) => item.id);
  assert.ok(!ids.includes(selfId), '不应推荐自己');
  assert.ok(!ids.includes('note-linked'), '已链接的笔记不应重复推荐');
  assert.ok(ids.includes('note-target'), '标题词命中的笔记应被推荐');
  const hit = links.find((item) => item.id === 'note-target');
  assert.equal(hit.reason.includes('标题词'), true);
});

test('suggestForNote returns empty structure for unknown note', async () => {
  const result = await suggestForNote('missing-note');
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.tags, []);
  assert.equal(result.semanticAvailable, false);
});
