import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// config 在模块导入时读取环境变量：先把 DB_FILE 指到临时目录，获得一个可控的 Vault
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-agent-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { chat } = await import('../src/modules/ai/ai.service.js');
const { config } = await import('../src/config/index.js');

// mock 上游专用占位密钥：拼接生成、仅用于本机回环地址，不是真实凭据
const placeholderKey = (suffix) => ['mock-key', suffix].join('-');

/** 按请求次数返回脚本化响应，并记录收到的请求体 */
async function listenScriptedUpstream(script) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      bodies.push(body);
      const step = Math.min(bodies.length, script.length) - 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: script[step](body) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    bodies,
    endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const providerFor = (upstream) => ({
  endpoint: upstream.endpoint,
  apiKey: placeholderKey('agent'),
  model: 'mock-model',
  authHeader: 'bearer',
});

test('agent mode runs the tool loop: search → auto-approved move → final report', async () => {
  const vaultDir = config.vaultDir;
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '会议纪要.md'), '# 会议纪要\n\n关键结论：按期上线。', 'utf8');

  const upstream = await listenScriptedUpstream([
    // 第 1 轮：模型先检索
    () => '```lattice-actions\n[{"type":"search","query":"会议"}]\n```',
    // 第 2 轮：根据检索结果决定移动文件（服务端应自动执行并回填结果）
    () => '```lattice-actions\n[{"type":"move","path":"会议纪要.md","targetPath":"归档/会议纪要.md"}]\n```',
    // 第 3 轮：拿到执行结果，输出最终汇报
    (body) => {
      const lastUser = body.messages.at(-1).content;
      assert.ok(lastUser.includes('系统已自动执行 1 项写操作'), '写操作结果应回填给模型');
      assert.ok(lastUser.includes('✓ move 会议纪要.md → 归档/会议纪要.md'));
      return '整理完成：已把《会议纪要》移动到「归档」目录。';
    },
  ]);
  try {
    const result = await chat({
      message: '把我的文件整理分类好',
      context: { files: [], folders: [] },
      mode: 'agent',
      autoApprove: true,
      role: 'editor',
      provider: providerFor(upstream),
    });

    assert.equal(upstream.bodies.length, 3, '应发起三轮模型调用');
    assert.equal(result.meta.rounds, 3);
    assert.equal(result.reply, '整理完成：已把《会议纪要》移动到「归档」目录。');
    assert.deepEqual(result.meta.executed, ['move 会议纪要.md → 归档/会议纪要.md']);
    assert.equal(result.actions.length, 0, '已执行的动作不应再进入确认流程');
    assert.ok(fs.existsSync(path.join(vaultDir, '归档', '会议纪要.md')), '文件应被真正移动');
    assert.ok(!fs.existsSync(path.join(vaultDir, '会议纪要.md')));

    // 写操作应有审计记录
    const auditPath = path.join(path.dirname(config.dbFile), 'ai-audit.jsonl');
    const audit = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(audit.some((entry) => entry.action.type === 'move' && entry.status === 'completed' && entry.source === 'ai-chat'));
  } finally {
    await upstream.close();
  }
});

test('agent mode without autoApprove returns write actions for confirmation preview', async () => {
  const vaultDir = config.vaultDir;
  fs.writeFileSync(path.join(vaultDir, '待归档.md'), '# 待归档\n', 'utf8');

  const upstream = await listenScriptedUpstream([
    () => '```lattice-actions\n[{"type":"move","path":"待归档.md","targetPath":"归档/待归档.md"}]\n```',
  ]);
  try {
    const result = await chat({
      message: '归档它',
      context: { files: [], folders: [] },
      mode: 'agent',
      autoApprove: false,
      role: 'editor',
      provider: providerFor(upstream),
    });

    assert.equal(upstream.bodies.length, 1, '未授权自动执行时不应继续循环');
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].type, 'move');
    assert.ok(fs.existsSync(path.join(vaultDir, '待归档.md')), '文件不应被移动');
  } finally {
    await upstream.close();
  }
});

test('viewer role can never trigger auto-approved writes in agent mode', async () => {
  const vaultDir = config.vaultDir;
  fs.writeFileSync(path.join(vaultDir, '只读.md'), '# 只读\n', 'utf8');

  const upstream = await listenScriptedUpstream([
    () => '```lattice-actions\n[{"type":"delete","path":"只读.md"}]\n```',
  ]);
  try {
    const result = await chat({
      message: '删掉它',
      context: { files: [], folders: [] },
      mode: 'agent',
      autoApprove: true,
      role: 'viewer',
      provider: providerFor(upstream),
    });

    assert.equal(result.actions.length, 1, '应回退为确认流程');
    assert.ok(fs.existsSync(path.join(vaultDir, '只读.md')), 'viewer 角色不得自动删除');
  } finally {
    await upstream.close();
  }
});

test('agent mode skips the local instant path so organize commands actually execute', async () => {
  const upstream = await listenScriptedUpstream([
    () => JSON.stringify({ reply: '开始整理', suggestions: [], references: [], actions: [] }),
  ]);
  try {
    const result = await chat({
      // 「整理」在助手模式会命中本地秒答快路径；任务模式必须真正到达模型
      message: '整理当前 Vault 的文件',
      context: { files: [], folders: [] },
      mode: 'agent',
      autoApprove: false,
      provider: providerFor(upstream),
    });
    assert.equal(upstream.bodies.length, 1, '任务模式应跳过快路径直达模型');
    assert.equal(result.meta.provider, 'external');
  } finally {
    await upstream.close();
  }
});

test('agent write batch with an invalid path feeds the error back instead of failing the conversation', async () => {
  const vaultDir = config.vaultDir;
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '正常.md'), '# 正常\n', 'utf8');

  const upstream = await listenScriptedUpstream([
    // 第 1 轮：模型给出越界路径，动作整体被路径校验拒绝
    () => '```lattice-actions\n[{"type":"create","path":"../escape.md","content":"x"}]\n```',
    // 第 2 轮：拿到失败原因后改用合法路径
    (body) => {
      const lastUser = body.messages.at(-1).content;
      assert.ok(lastUser.includes('全部未执行'), '批量失败原因应回填给模型');
      assert.ok(lastUser.includes('非法'), '应包含路径校验的错误详情');
      return '```lattice-actions\n[{"type":"create","path":"retry.md","content":"# Retry\\n"}]\n```';
    },
    // 第 3 轮：执行成功后给出最终回答
    () => '已修正路径并创建文件。',
  ]);
  try {
    const result = await chat({
      message: '建一个文件',
      context: { files: [], folders: [] },
      mode: 'agent',
      autoApprove: true,
      role: 'editor',
      provider: providerFor(upstream),
    });

    assert.equal(upstream.bodies.length, 3, '失败应回填并继续循环，而不是整个会话报错');
    assert.equal(result.reply, '已修正路径并创建文件。');
    assert.ok(result.meta.executedFailed.some((item) => item.includes('批量写操作未执行')));
    assert.deepEqual(result.meta.executed, ['create retry.md']);
    assert.ok(fs.existsSync(path.join(vaultDir, 'retry.md')));
  } finally {
    await upstream.close();
  }
});

test('agent rounds exhausted with pending actions tells the user how to continue', async () => {
  const vaultDir = config.vaultDir;
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '笔记A.md'), '# A\n', 'utf8');
  const readRound = () => '```lattice-actions\n[{"type":"read","path":"笔记A.md"}]\n```';
  const upstream = await listenScriptedUpstream([readRound, readRound, readRound, readRound, readRound, readRound]);
  try {
    const result = await chat({
      message: '反复读这个文件',
      context: { files: [], folders: [] },
      mode: 'agent',
      autoApprove: true,
      role: 'editor',
      provider: providerFor(upstream),
    });

    assert.equal(upstream.bodies.length, 6, '应达到任务模式最大轮次后停止');
    assert.equal(result.meta.rounds, 6);
    assert.ok(result.reply.includes('最大轮次'), '轮次耗尽应在回复中明确提示');
    assert.ok(result.reply.includes('继续'), '应告知用户如何接续任务');
    assert.deepEqual(result.meta.executed, [], 'executed 只记录写操作，纯读取循环应为空');
  } finally {
    await upstream.close();
  }
});
