/**
 * Vault 增量同步引擎的集成测试：临时 SQLite + 临时 Vault，
 * 覆盖 reconcile 全量/差量、单文件 upsert、改名迁移、标题变更的链接重定位、
 * 删除清理与目录回收、以及跨重建的 folderId/tagId 稳定性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, getDb, openDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { VaultAdapter } from '../src/vault/vault.adapter.js';
import { applyVaultChange, reconcileVault } from '../src/vault/sync.js';
import { watchVault } from '../src/vault/watcher.js';

const T0 = '2026-01-01T00:00:00.000Z';

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-sync-'));
  closeDatabase();
  openDatabase(path.join(dir, 'test.db'));
  runMigrations();
  return { dir, adapter: new VaultAdapter(dir) };
}

function writeNote(adapter, { id, title, content, folderPath = '' }) {
  const filePath = folderPath ? `${folderPath}/${title}.md` : `${title}.md`;
  adapter.writeSync({ id, title, content, filePath, isPinned: false, createdAt: T0, updatedAt: T0 });
  return filePath;
}

async function waitFor(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for vault watcher');
}

test('reconcile full 建立投影，二次运行零写入且 ID 稳定', async () => {
  const { adapter } = makeVault();
  writeNote(adapter, {
    id: '11111111-1111-4111-8111-111111111111',
    title: '笔记甲',
    content: '链接到 [[笔记乙]]\n\n#工程',
  });
  writeNote(adapter, {
    id: '22222222-2222-4222-8222-222222222222',
    title: '笔记乙',
    content: '乙的正文 #工程',
    folderPath: '工程/前端',
  });

  const first = await reconcileVault(adapter, { mode: 'full' });
  assert.equal(first.added, 2);
  assert.equal(first.removed, 0);

  const db = getDb();
  const noteCount = () => db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  assert.equal(noteCount(), 2);

  const folderId = db.prepare("SELECT id FROM folders WHERE name = '前端'").get()?.id;
  assert.ok(folderId, '目录链应被建立');
  const tagId = db.prepare("SELECT id FROM tags WHERE name = '工程'").get()?.id;
  assert.ok(tagId, '标签应被建立');

  const link = db
    .prepare("SELECT target_note_id FROM links WHERE target_title = '笔记乙'")
    .get();
  assert.equal(link?.target_note_id, '22222222-2222-4222-8222-222222222222', '双链应解析到目标笔记');

  const second = await reconcileVault(adapter, { mode: 'full' });
  assert.equal(second.skipped, 2);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.removed, 0);
  assert.equal(noteCount(), 2);
  assert.equal(db.prepare("SELECT id FROM folders WHERE name = '前端'").get().id, folderId, 'folderId 跨重建稳定');
  assert.equal(db.prepare("SELECT id FROM tags WHERE name = '工程'").get().id, tagId, 'tagId 跨重建稳定');
});

test('applyVaultChange 更新单文件：FTS 同步、孤儿标签清理、重复事件被跳过', async () => {
  const { adapter } = makeVault();
  const fileA = writeNote(adapter, {
    id: '33333333-3333-4333-8333-333333333333',
    title: '笔记丙',
    content: '旧内容 #旧标签',
  });
  await reconcileVault(adapter, { mode: 'full' });

  adapter.writeSync({
    id: '33333333-3333-4333-8333-333333333333',
    title: '笔记丙',
    content: '增量同步引擎的新内容 #新标签',
    filePath: fileA,
    isPinned: false,
    createdAt: T0,
    updatedAt: '2026-02-02T00:00:00.000Z',
  });

  const first = await applyVaultChange(adapter, fileA);
  assert.equal(first.action, 'updated');
  // SSE 契约：updated/added 事件必须带 id，前端靠它把变更匹配到当前打开的笔记
  assert.equal(first.id, '33333333-3333-4333-8333-333333333333', 'updated 事件必须携带笔记 id');
  assert.equal(first.file, fileA);

  const db = getDb();
  assert.match(
    db.prepare("SELECT content FROM notes WHERE title = '笔记丙'").get().content,
    /增量同步引擎/,
  );
  const ftsRow = db
    .prepare("SELECT note_id FROM notes_fts WHERE notes_fts MATCH '增量同步'")
    .get();
  assert.equal(ftsRow?.note_id, '33333333-3333-4333-8333-333333333333', 'FTS 触发器应同步新正文');

  const tagNames = db.prepare('SELECT name FROM tags').all().map((row) => row.name);
  assert.ok(tagNames.includes('新标签'));
  assert.ok(!tagNames.includes('旧标签'), '不再被引用的标签应被清理');

  const second = await applyVaultChange(adapter, fileA);
  assert.equal(second.action, 'skipped', '内容未变化时不得重复写库');
});

test('文件改名迁移保持 id，旧路径事件不产生副作用', async () => {
  const { dir, adapter } = makeVault();
  const id = '44444444-4444-4444-8444-444444444444';
  const oldPath = writeNote(adapter, { id, title: '笔记丁', content: '丁' });
  const newPath = '归档/笔记丁.md';
  await reconcileVault(adapter, { mode: 'full' });

  fs.mkdirSync(path.join(dir, '归档'), { recursive: true });
  fs.renameSync(path.join(dir, oldPath), path.join(dir, newPath));

  const moved = await applyVaultChange(adapter, newPath);
  assert.equal(moved.action, 'added');
  assert.equal(moved.id, id, 'added 事件同样必须携带笔记 id');

  const db = getDb();
  const row = db.prepare('SELECT id, file_path FROM notes WHERE title = ?', ).get('笔记丁');
  assert.equal(row.id, id, '改名后 id 不变');
  assert.equal(row.file_path, newPath);

  const stale = await applyVaultChange(adapter, oldPath);
  assert.equal(stale.action, 'absent', '旧行已随 id 迁走，旧路径事件无行可删');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notes').get().c, 1);
});

test('停机期间文件被移动：reconcile 识别为移动，id 与反链保持稳定', async () => {
  const { dir, adapter } = makeVault();
  const id = '47474747-4747-4477-8474-747474747474';
  const oldPath = writeNote(adapter, { id, title: '被移动的笔记', content: '移动不换身份' });
  writeNote(adapter, {
    id: '48484848-4848-4488-8484-848484848484',
    title: '引用方',
    content: '指向 [[被移动的笔记]]',
  });
  await reconcileVault(adapter, { mode: 'full' });

  // 模拟停机窗口：文件被外部直接移动，没有产生任何 watcher 事件
  fs.mkdirSync(path.join(dir, '归档'), { recursive: true });
  const newPath = '归档/被移动的笔记.md';
  fs.renameSync(path.join(dir, oldPath), path.join(dir, newPath));

  const stats = await reconcileVault(adapter, { mode: 'full' });
  // 移动 = 新路径计入 added、旧路径的行就地更新而不再是 removed
  assert.equal(stats.added, 1);
  assert.equal(stats.removed, 0, '旧行应随移动就地更新，而不是被删除');

  const db = getDb();
  const row = db.prepare('SELECT id, file_path FROM notes WHERE title = ?').get('被移动的笔记');
  assert.equal(row.id, id, '移动后的笔记必须保留原 id');
  assert.equal(row.file_path, newPath);
  assert.equal(
    db.prepare("SELECT target_note_id FROM links WHERE target_title = '被移动的笔记'").get().target_note_id,
    id,
    '指向该笔记的反链不得因移动而丢失',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notes').get().c, 2);
});

test('properties_json 投影列：随投影写入，存量 NULL 行读取时惰性回填', async () => {
  const { adapter } = makeVault();
  writeNote(adapter, { id: '49494949-4949-4494-8494-494949494949', title: '属性笔记', content: '有 frontmatter 属性 #工程' });
  await reconcileVault(adapter, { mode: 'full' });

  const db = getDb();
  const row = db.prepare('SELECT properties_json FROM notes WHERE title = ?').get('属性笔记');
  assert.ok(row.properties_json && row.properties_json !== 'null', 'reconcile 的投影更新应写入 properties_json');

  // 模拟迁移前的存量行：置空 properties_json，文件未变
  db.prepare('UPDATE notes SET properties_json = NULL WHERE title = ?').run('属性笔记');

  const index = await applyVaultChange(adapter, '属性笔记.md'); // skipped：不写库
  assert.equal(index.action, 'skipped');
  // 直接走服务层的读路径验证回填
  const { getDetail } = await import('../src/modules/notes/notes.service.js');
  const detail = getDetail('49494949-4949-4494-8494-494949494949');
  assert.equal(typeof detail.properties, 'object');

  const backfilled = db.prepare('SELECT properties_json FROM notes WHERE title = ?').get('属性笔记');
  assert.ok(backfilled.properties_json && backfilled.properties_json !== 'null', '读取时应把 NULL 行惰性回填');
});

test('外部改标题：原指向链接退回悬空，新标题认领悬空链接', async () => {
  const { adapter } = makeVault();
  const fileA = writeNote(adapter, {
    id: '55555555-5555-4555-8555-555555555555',
    title: '引用方',
    content: '指向 [[旧标题]]，还悬空指向 [[未来标题]]',
  });
  const fileB = writeNote(adapter, {
    id: '66666666-6666-4666-8666-666666666666',
    title: '旧标题',
    content: '被引用的笔记',
  });
  await reconcileVault(adapter, { mode: 'full' });

  const db = getDb();
  assert.equal(
    db.prepare("SELECT target_note_id FROM links WHERE target_title = '旧标题'").get().target_note_id,
    '66666666-6666-4666-8666-666666666666',
  );

  adapter.writeSync({
    id: '66666666-6666-4666-8666-666666666666',
    title: '未来标题',
    content: '被引用的笔记',
    filePath: fileB,
    isPinned: false,
    createdAt: T0,
    updatedAt: T0,
  });
  await applyVaultChange(adapter, fileB);

  const retargeted = db.prepare("SELECT target_note_id FROM links WHERE target_title = '旧标题'").get();
  assert.equal(retargeted.target_note_id, null, '旧标题链接应退回悬空');
  const claimed = db.prepare("SELECT target_note_id FROM links WHERE target_title = '未来标题'").get();
  assert.equal(claimed.target_note_id, '66666666-6666-4666-8666-666666666666', '新标题应认领悬空链接');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notes WHERE id = ?',).get('66666666-6666-4666-8666-666666666666').c, 1);
  void fileA;
});

test('删除文件后投影回收，空目录被清掉而盘上目录保留', async () => {
  const { dir, adapter } = makeVault();
  const fileA = writeNote(adapter, {
    id: '77777777-7777-4777-8777-777777777777',
    title: '将被删除',
    content: '再见 #孤标签',
    folderPath: '临时目录',
  });
  writeNote(adapter, {
    id: '88888888-8888-4888-8888-888888888888',
    title: '留下',
    content: '留下 #孤标签',
  });
  await reconcileVault(adapter, { mode: 'full' });

  fs.rmSync(path.join(dir, fileA), { force: true });
  adapter.removeSync(fileA); // 走加固后的删除路径（rmSync 静默失败时的兜底）

  const result = await applyVaultChange(adapter, fileA);
  assert.equal(result.action, 'removed');

  const db = getDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notes').get().c, 1);
  // 盘上目录还在：空目录是用户数据，投影行必须保留
  assert.ok(db.prepare("SELECT id FROM folders WHERE name = '临时目录'").get(), '盘上还在的目录行必须保留');
  assert.ok(db.prepare("SELECT id FROM tags WHERE name = '孤标签'").get(), '仍被引用的标签必须保留');

  // 目录从盘上消失后，membership 对齐回收其投影行。
  // 注：删除目录用 rmdirSync（仅空目录）——本仓库的沙箱环境会拦截 rmSync 的
  // 递归删除并杀死进程，removeDirectorySync 的加固兜底无法在测试内安全覆盖。
  fs.rmdirSync(path.join(dir, '临时目录'));
  await reconcileVault(adapter, { mode: 'membership' });
  assert.ok(!db.prepare("SELECT id FROM folders WHERE name = '临时目录'").get(), '盘上消失的目录行应被回收');

  // 盘上新建的空目录同样进入投影
  fs.mkdirSync(path.join(dir, '空目录'), { recursive: true });
  await reconcileVault(adapter, { mode: 'membership' });
  assert.ok(db.prepare("SELECT id FROM folders WHERE name = '空目录'").get());
  fs.rmdirSync(path.join(dir, '空目录'));
  await reconcileVault(adapter, { mode: 'membership' });
  assert.ok(!db.prepare("SELECT id FROM folders WHERE name = '空目录'").get(), '盘上消失的空目录行应被回收');
});

test('membership 模式只补路径集合差量，新增文件直接入库', async () => {
  const { adapter } = makeVault();
  writeNote(adapter, {
    id: '99999999-9999-4999-8999-999999999999',
    title: '既有',
    content: '既有内容',
  });
  await reconcileVault(adapter, { mode: 'full' });

  writeNote(adapter, {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: '新来',
    content: '新内容',
    folderPath: '新地方',
  });

  const stats = await reconcileVault(adapter, { mode: 'membership' });
  assert.equal(stats.added, 1);
  assert.equal(stats.removed, 0);
  const db = getDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notes').get().c, 2);
  assert.ok(db.prepare("SELECT id FROM folders WHERE name = '新地方'").get());
});

test('复制文件带来的重复 id：副本获得新 id，两个文件都可寻址', async () => {
  const { adapter } = makeVault();
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  writeNote(adapter, { id, title: '原件', content: '内容' });
  // 副本带同一个 frontmatter id（模拟复制粘贴出的文件）
  adapter.writeSync({
    id,
    title: '原件',
    content: '内容',
    filePath: '副本.md',
    isPinned: false,
    createdAt: T0,
    updatedAt: T0,
  });

  await reconcileVault(adapter, { mode: 'full' });

  const db = getDb();
  const rows = db.prepare('SELECT id, file_path FROM notes ORDER BY file_path').all();
  assert.equal(rows.length, 2, '两个文件都必须可寻址');
  assert.notEqual(rows[0].id, rows[1].id, '重复 id 必须被拆开');
  assert.ok(rows.some((row) => row.id === id), '先入盘的原件保留 id');
});

test('watchVault detects an external Markdown deletion and publishes the removed note', async () => {
  const { dir, adapter } = makeVault();
  const filePath = writeNote(adapter, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    title: 'externally removed',
    content: 'watcher regression',
  });
  await reconcileVault(adapter, { mode: 'full' });

  const changes = [];
  const stop = watchVault(dir, { delay: 20, onChange: (change) => changes.push(change) });
  try {
    fs.rmSync(path.join(dir, filePath), { force: true });
    await waitFor(() => changes.some((change) => change.action === 'removed'));
    assert.deepEqual(changes.find((change) => change.action === 'removed'), {
      file: filePath,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      action: 'removed',
    });
    assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM notes').get().c, 0);
  } finally {
    stop();
  }
});
