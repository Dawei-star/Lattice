import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 笔记乐观锁测试：需要真实 schema 与 vault 写入
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-notes-lock-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.VAULT_DIR = path.join(runtimeRoot, 'vault');
process.env.NODE_ENV = 'test';

const { runMigrations } = await import('../src/db/migrate.js');
runMigrations();

const { create, update, getDetail } = await import('../src/modules/notes/notes.service.js');

test('update rejects a stale expectedHash with 409 ConflictError', async () => {
  const note = create({ title: '乐观锁', content: '第一版' });
  const detail = getDetail(note.id);
  assert.ok(detail.contentHash, '详情应携带 contentHash 供乐观锁使用');

  // 别的窗口先改了一版
  update(note.id, { content: '别的窗口已修改' });
  const staleHash = detail.contentHash;

  assert.throws(
    () => update(note.id, { content: '过期窗口的修改', expectedHash: staleHash }),
    (error) => error.code === 'CONFLICT' && error.status === 409,
    '携带过期 expectedHash 的更新应返回 409',
  );

  // 读取最新 hash 后重试成功
  const fresh = getDetail(note.id);
  const updated = update(note.id, { content: '过期窗口的修改', expectedHash: fresh.contentHash });
  assert.equal(updated.content, '过期窗口的修改');
  assert.notEqual(updated.contentHash, fresh.contentHash, '更新后 hash 应变化');
});

test('update without expectedHash keeps legacy last-write-wins behavior', () => {
  const note = create({ title: '兼容旧客户端', content: 'v1' });
  update(note.id, { content: 'v2' });
  const updated = update(note.id, { content: 'v3' });
  assert.equal(updated.content, 'v3');
});
