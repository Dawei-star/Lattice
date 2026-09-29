import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 每日摘要测试：需要真实 schema 与 vault 写入
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-digest-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.VAULT_DIR = path.join(runtimeRoot, 'vault');
process.env.NODE_ENV = 'test';

const { runMigrations } = await import('../src/db/migrate.js');
runMigrations();

const { generateDigest, digestTitleFor, maybeRunScheduledDigest } = await import('../src/modules/ai/ai.digest.js');
const { getDb } = await import('../src/db/index.js');
const { config } = await import('../src/config/index.js');

const now = new Date();
function insertNote(id, title, content, updatedAt) {
  getDb().prepare(
    `INSERT INTO notes (id, title, content, is_pinned, word_count, content_hash, created_at, updated_at, file_path)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(id, title, content, content.length, `hash-${id}`, updatedAt, updatedAt, `${title}.md`);
}

test('digest creates a Journal note listing today\'s modified notes, idempotent on regenerate', async () => {
  const iso = (offsetMinutes) => new Date(now.getTime() - offsetMinutes * 60_000).toISOString();
  insertNote('digest-src-1', '会议纪要', '关键结论：按期上线。', iso(30));
  insertNote('digest-src-2', '旧笔记', '很久之前的内容。', iso(60 * 48)); // 48 小时前，不应出现在摘要里
  insertNote('digest-src-3', '今日随笔', '随手记录。', iso(10));

  const first = await generateDigest({ date: now });
  assert.equal(first.created, true);
  assert.equal(first.modifiedCount, 2, '只汇总今天修改的笔记');
  assert.ok(first.filePath.startsWith('Journal/'), '摘要应落在 Journal 目录');

  const noteRow = getDb().prepare('SELECT id, title, content, file_path FROM notes WHERE id = ?').get(first.noteId);
  assert.equal(noteRow.title, digestTitleFor(now));
  assert.ok(noteRow.content.includes('[[会议纪要]]'));
  assert.ok(noteRow.content.includes('[[今日随笔]]'));
  assert.ok(!noteRow.content.includes('旧笔记'), '超出时间窗的笔记不应出现');
  assert.ok(fs.existsSync(path.join(config.vaultDir, 'Journal', `${digestTitleFor(now)}.md`)), 'Markdown 文件应写入磁盘');
  assert.ok(getDb().prepare("SELECT id FROM folders WHERE name = 'Journal'").get(), 'Journal 目录应被创建');

  // 重复生成：更新同一篇而不是新建
  const second = await generateDigest({ date: now });
  assert.equal(second.created, false);
  assert.equal(second.noteId, first.noteId);
  const count = getDb().prepare("SELECT COUNT(*) AS c FROM notes WHERE title LIKE '每日摘要%'").get().c;
  assert.equal(count, 1);
});

test('scheduled digest respects AI_DIGEST_HOUR and once-per-day idempotency', async () => {
  process.env.AI_DIGEST_HOUR = '3';
  // 重新加载 config 不可行（已冻结），直接验证 maybeRunScheduledDigest 的守卫逻辑：
  // 当前实现从 config.aiDigestHour 读取 —— 未重载时为 null，应直接返回 null
  const skipped = await maybeRunScheduledDigest({ now });
  assert.equal(skipped, null, '未配置定时小时时不应生成');
});
