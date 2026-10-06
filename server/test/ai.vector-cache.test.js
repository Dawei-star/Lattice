import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-veccache-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { openDatabase } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrate.js');
openDatabase();
runMigrations();

const { getDb } = await import('../src/db/index.js');
const { storeNoteChunks, removeNoteIndex, searchVectors } = await import('../src/modules/ai/ai.embeddings.js');

function insertNote(id, title) {
  getDb()
    .prepare('INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, title, '占位正文', new Date().toISOString(), new Date().toISOString());
}

test('vector search stays correct across cache invalidation on index writes', () => {
  insertNote('note-1', '向量缓存样例一');
  insertNote('note-2', '向量缓存样例二');

  // 写入 note-1：向量 [1,0]，应当命中
  storeNoteChunks('note-1', {
    chunks: [{ anchor: '', content: '阿尔法内容', contentHash: 'h-alpha' }],
    vectors: [Float32Array.from([1, 0])],
    model: 'cache-test-model',
    noteContentHash: 'note-1-hash',
  });

  const first = searchVectors(Float32Array.from([1, 0]), { model: 'cache-test-model' });
  assert.equal(first.length, 1);
  assert.equal(first[0].noteId, 'note-1');

  // 第二次查询走缓存路径，结果必须一致
  const second = searchVectors(Float32Array.from([1, 0]), { model: 'cache-test-model' });
  assert.deepEqual(second.map((row) => row.chunkId), first.map((row) => row.chunkId));

  // 重写 note-1 向量为 [0,1]：写入口必须使缓存失效，旧向量不再命中
  storeNoteChunks('note-1', {
    chunks: [{ anchor: '', content: '阿尔法内容', contentHash: 'h-alpha' }],
    vectors: [Float32Array.from([0, 1])],
    model: 'cache-test-model',
    noteContentHash: 'note-1-hash-2',
  });
  const afterRewrite = searchVectors(Float32Array.from([1, 0]), { model: 'cache-test-model' });
  assert.equal(afterRewrite.length, 0, '重写后旧向量不应再命中（缓存必须已失效）');
  const afterRewriteNew = searchVectors(Float32Array.from([0, 1]), { model: 'cache-test-model' });
  assert.equal(afterRewriteNew.length, 1);

  // note-2 写入后两篇都在
  storeNoteChunks('note-2', {
    chunks: [{ anchor: '', content: '贝塔内容', contentHash: 'h-beta' }],
    vectors: [Float32Array.from([1, 0])],
    model: 'cache-test-model',
    noteContentHash: 'note-2-hash',
  });
  assert.equal(searchVectors(Float32Array.from([1, 0]), { model: 'cache-test-model' }).length, 1);

  // removeNoteIndex 后消失
  removeNoteIndex('note-2');
  const afterRemove = searchVectors(Float32Array.from([1, 0]), { model: 'cache-test-model' });
  assert.equal(afterRemove.length, 0);
  assert.ok(afterRemove.every((row) => row.noteId !== 'note-2'));

  // excludeNoteId 过滤仍然生效
  const excluded = searchVectors(Float32Array.from([0, 1]), { model: 'cache-test-model', excludeNoteId: 'note-1' });
  assert.equal(excluded.length, 0);
});
