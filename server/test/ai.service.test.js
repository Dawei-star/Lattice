import test from 'node:test';
import assert from 'node:assert/strict';
import * as aiService from '../src/modules/ai/ai.service.js';

test('AI local assistant returns structured organization suggestions', async () => {
  const result = await aiService.chat({
    message: '整理当前 Vault 的文件',
    context: { files: [{ title: '设计笔记', path: '设计笔记.md' }], folders: [] },
  });

  // 「整理」属于确定性建议类请求，走本地秒答快路径，不经过模型
  assert.equal(result.meta.provider, 'local-instant');
  assert.ok(result.reply.includes('低风险建议'));
  assert.ok(result.suggestions.length >= 2);
  assert.deepEqual(result.actions, []);
});

test('AI operation preview enforces Vault paths and viewer write blocking', () => {
  assert.throws(
    () => aiService.preview([{ type: 'read', path: '../outside.md' }]),
    /非法 Vault 文件路径/,
  );

  const preview = aiService.preview(
    [{ type: 'create', path: '待确认.md', content: '# 待确认' }],
    { actor: 'viewer-test', role: 'viewer' },
  );

  assert.equal(preview.blocked, true);
  assert.equal(preview.operations[0].requiresConfirmation, true);
  assert.equal(preview.operations[0].risk, 'write');
});

test('AI execute refuses unconfirmed writes and directory moves', async () => {
  await assert.rejects(
    () => aiService.execute([{ type: 'create', path: '未确认.md', content: '# 未确认' }]),
    /必须先确认操作预览/,
  );

  await assert.rejects(
    () => aiService.execute([{ type: 'move', path: '.', targetPath: '移动后' }], { confirmed: true }),
    /非法 Vault 文件路径/,
  );
});
