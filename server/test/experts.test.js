import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-experts-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.VAULT_DIR = path.join(runtimeRoot, 'vault');
process.env.NODE_ENV = 'test';

const { runMigrations } = await import('../src/db/migrate.js');
runMigrations();
const registry = await import('../src/modules/experts/experts.registry.js');
const { chat, restrictContextForExpert } = await import('../src/modules/ai/ai.service.js');
const sessions = await import('../src/modules/ai/ai.sessions.js');
const { config } = await import('../src/config/index.js');

function providerFor(upstream) {
  return {
    endpoint: upstream.endpoint,
    apiKey: 'test-expert-key',
    model: 'expert-test-model',
    authHeader: 'bearer',
  };
}

async function listenOnce(onBody) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      bodies.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: onBody(body), reasoning_content: 'mock chain-of-thought' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    bodies,
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('builtin experts keep a conflict-free routing keyword set', () => {
  // 上一次扩充内置专家时，routing 关键词靠人工交叉去重。这次把它固化成测试：
  // 同一个关键词被两个专家声明，会让一条消息同时命中两个专家、路由建议随机摇摆。
  const owners = new Map();
  const conflicts = [];
  for (const expert of registry.listExperts().filter((item) => item.source === 'builtin')) {
    for (const keyword of expert.routing?.keywords ?? []) {
      const key = String(keyword).trim().toLowerCase();
      if (!key) continue;
      if (owners.has(key) && owners.get(key) !== expert.id) {
        conflicts.push(`「${key}」同时属于 ${owners.get(key)} 与 ${expert.id}`);
      }
      owners.set(key, expert.id);
    }
  }
  assert.deepEqual(conflicts, [], `内置专家路由关键词必须互斥：${conflicts.join('；')}`);

  // 专家的写入策略必须与它声明的工具自洽：disabled 不该带写工具，
  // 而 auto / confirm 至少要有一个写工具，否则写入策略形同虚设。
  const mutating = new Set(['create', 'update', 'delete', 'move', 'copy', 'archive']);
  for (const expert of registry.listExperts()) {
    const tools = new Set(expert.capabilities.tools ?? []);
    const declared = [...tools].filter((tool) => mutating.has(tool));
    if (expert.capabilities.writePolicy === 'disabled') {
      assert.deepEqual(declared, [], `${expert.id} 写入已禁用，不应声明写工具`);
    } else {
      assert.ok(declared.length > 0, `${expert.id} 允许写入，至少要声明一个写工具`);
    }
  }
});

test('task-executor is built for task mode and withholds delete', () => {
  const expert = registry.getExpert('task-executor');
  assert.equal(expert.source, 'builtin');

  const tools = new Set(expert.capabilities.tools);
  assert.ok(tools.has('read') && tools.has('search'), '任务模式专家必须能读与检索');
  assert.ok(tools.has('move') && tools.has('create') && tools.has('update'), '批量任务需要移动 / 新建 / 改写能力');
  assert.ok(!tools.has('delete'), '任务执行专家不应持有删除能力——批量场景下误删代价最高');
  assert.equal(expert.capabilities.writePolicy, 'confirm', '写操作必须走确认，与全局写闸门一致');

  // 绑定的 Skill 必须全部可解析，否则该方法论不会注入提示词（且界面只显示一个 available=false）
  assert.deepEqual(registry.loadRuntimeExpert('task-executor').missingSkills, []);

  // 任务模式专用的多轮纪律应排在 vault-search 之前：它是本专家的差异化价值
  const runtime = registry.loadRuntimeExpert('task-executor');
  assert.deepEqual(runtime.skills.map(({ definition }) => definition.id), [
    'task-batch-planner',
    'task-round-discipline',
    'vault-search',
  ]);
  const prompt = registry.buildExpertPromptSection(runtime);
  assert.match(prompt, /<skill id="task-batch-planner"/);
  assert.match(prompt, /<skill id="task-round-discipline"/);
});

test('expert and skill registry supports builtins, workspace resources, and builtin overrides', () => {
  const experts = registry.listExperts();
  const skills = registry.listSkills();
  assert.ok(experts.some((expert) => expert.id === 'inbox-organizer' && expert.source === 'builtin'));
  assert.ok(skills.some((skill) => skill.id === 'vault-search' && skill.source === 'builtin'));

  const builtinSkill = registry.readSkill('vault-search', { includeContent: true });
  assert.equal(builtinSkill.source, 'builtin');
  assert.ok(builtinSkill.content.trim().length > 0);

  assert.throws(
    () => registry.saveSkill({ id: 'vault-search', name: 'Blocked', content: 'blocked' }),
    (error) => error.code === 'CONFLICT',
  );

  const customSkill = registry.saveSkill({
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A workspace skill',
    tools: ['read'],
    permissions: ['read'],
    content: 'Read the requested note and report the evidence.',
  });
  assert.equal(customSkill.source, 'workspace');

  const customExpert = registry.saveExpert({
    id: 'test-expert',
    name: 'Test Expert',
    description: 'A workspace expert',
    skills: [{ id: 'test-skill', enabled: true, priority: 90, config: { mode: 'strict' } }],
    capabilities: { tools: ['read'], writePolicy: 'disabled', maxRounds: 3 },
  });
  assert.equal(customExpert.source, 'workspace');
  const runtime = registry.loadRuntimeExpert('test-expert');
  assert.equal(runtime.skills[0].definition.id, 'test-skill');
  assert.equal(runtime.skills[0].binding.config.mode, 'strict');
  assert.match(registry.buildExpertPromptSection(runtime), /Read the requested note/);

  const override = registry.saveSkill({
    name: 'Vault Search Override',
    description: 'Workspace override',
    content: 'Use the local search index and cite every result.',
  }, 'vault-search');
  assert.equal(override.source, 'workspace');
  assert.match(registry.readSkill('vault-search', { includeContent: true }).content, /local search index/);

  registry.deleteExpert('test-expert');
  registry.deleteSkill('test-skill');
  registry.deleteSkill('vault-search');
  assert.equal(registry.readSkill('vault-search').source, 'builtin');
  assert.throws(() => registry.getExpert('test-expert'), (error) => error.code === 'NOT_FOUND');
  assert.ok(fs.existsSync(config.vaultDir));
});

test('expert skills are injected into the provider prompt and returned in metadata', async () => {
  const upstream = await listenOnce(() => JSON.stringify({ reply: 'ok', suggestions: [], references: [], actions: [] }));
  try {
    const result = await chat({
      message: 'Research the relevant notes.',
      context: { files: [], folders: [] },
      expertId: 'knowledge-researcher',
      provider: providerFor(upstream),
    });
    const systemPrompt = upstream.bodies[0].messages[0].content;
    assert.match(systemPrompt, /<expert-instructions>/);
    assert.match(systemPrompt, /<skill id="vault-search"/);
    assert.equal(result.meta.expertId, 'knowledge-researcher');
    assert.ok(result.meta.loadedSkills.some((skill) => skill.id === 'vault-search'));
    assert.equal(result.reasoning, 'mock chain-of-thought', '上游思维链应随结果透传');
  } finally {
    await upstream.close();
  }
});

test('expert context projection respects the selected scope and capability contract', () => {
  const research = registry.loadRuntimeExpert('knowledge-researcher');
  const source = {
    scope: 'current',
    activeFile: 'notes/a.md',
    activeFileContent: 'private note body',
    project: { name: 'Project A', path: 'Project A', fileCount: 2 },
    files: [{ id: 'a', title: 'A', path: 'notes/a.md' }, { id: 'b', title: 'B', path: 'notes/b.md' }],
    folders: [{ id: 'folder-a', path: 'Project A' }],
    inbox: { total: 2, pending: 1 },
    inboxFiles: [{ id: 'inbox-a', title: 'Captured' }],
  };

  const current = restrictContextForExpert(source, research);
  assert.equal(current.activeFileContent, 'private note body');
  assert.equal(current.project, null);
  assert.deepEqual(current.files.map((file) => file.id), ['a']);
  assert.deepEqual(current.inboxFiles, []);

  const project = restrictContextForExpert({ ...source, scope: 'project' }, research);
  assert.equal(project.activeFile, null);
  assert.equal(project.activeFileContent, null);
  assert.equal(project.project.name, 'Project A');
  assert.deepEqual(project.files.map((file) => file.id), ['a', 'b']);
  assert.deepEqual(project.inboxFiles, []);
});

test('expert-bound sessions do not leak history across experts', async () => {
  const session = sessions.createSession({ title: '通用会话', expertId: 'general' });
  sessions.appendMessage(session.id, { role: 'user', content: '只有通用助手可以看到的内部上下文' });
  const upstream = await listenOnce(() => JSON.stringify({ reply: 'ok', suggestions: [], references: [], actions: [] }));
  try {
    const result = await chat({
      message: 'Research the project notes.',
      context: { scope: 'project', files: [], folders: [] },
      sessionId: session.id,
      expertId: 'knowledge-researcher',
      provider: providerFor(upstream),
    });
    const messages = upstream.bodies[0].messages;
    assert.ok(messages.every((message) => !message.content.includes('只有通用助手可以看到')));
    assert.equal(result.meta.expertId, 'knowledge-researcher');
    assert.deepEqual(sessions.listSessions({ expertId: 'knowledge-researcher' }).filter((item) => item.id === session.id), []);
  } finally {
    await upstream.close();
    sessions.deleteSession(session.id);
  }
});

test('read-only experts block writes and confirm experts do not inherit global auto-approval', async () => {
  const readOnlyUpstream = await listenOnce(() => '```lattice-actions\n[{"type":"move","path":"notes/a.md","targetPath":"archive/a.md"}]\n```');
  try {
    const readOnlyResult = await chat({
      message: 'Move the note.',
      context: { files: [], folders: [] },
      expertId: 'knowledge-researcher',
      mode: 'agent',
      autoApprove: true,
      provider: providerFor(readOnlyUpstream),
    });
    assert.deepEqual(readOnlyResult.actions, []);
    assert.equal(readOnlyResult.meta.executed.length, 0);
  } finally {
    await readOnlyUpstream.close();
  }

  const confirmUpstream = await listenOnce(() => '```lattice-actions\n[{"type":"move","path":"notes/a.md","targetPath":"archive/a.md"}]\n```');
  try {
    const confirmResult = await chat({
      message: 'Move the note after checking it.',
      context: { files: [], folders: [] },
      expertId: 'inbox-organizer',
      mode: 'agent',
      autoApprove: true,
      provider: providerFor(confirmUpstream),
    });
    assert.equal(confirmResult.actions[0].type, 'move');
    assert.equal(confirmResult.meta.executed.length, 0);
  } finally {
    await confirmUpstream.close();
  }
});

test('skill binding priority orders the injected prompt sections', () => {
  registry.saveSkill({
    id: 'priority-low',
    name: '低优先级 Skill',
    content: 'Low priority workflow.',
    tools: ['read'],
  });
  registry.saveSkill({
    id: 'priority-high',
    name: '高优先级 Skill',
    content: 'High priority workflow.',
    tools: ['read'],
  });
  try {
    registry.saveExpert({
      id: 'priority-order-expert',
      name: '排序测试专家',
      skills: [
        { id: 'priority-low', enabled: true, priority: 10, config: {} },
        { id: 'priority-high', enabled: true, priority: 90, config: {} },
      ],
    });
    const runtime = registry.loadRuntimeExpert('priority-order-expert');
    assert.deepEqual(runtime.skills.map(({ definition }) => definition.id), ['priority-high', 'priority-low'], '高优先级 Skill 应排在前面');
    const prompt = registry.buildExpertPromptSection(runtime);
    assert.ok(prompt.indexOf('priority-high') < prompt.indexOf('priority-low'), '提示词中高优先级 Skill 应先出现');
  } finally {
    registry.deleteExpert('priority-order-expert');
    registry.deleteSkill('priority-high');
    registry.deleteSkill('priority-low');
  }
});

test('suggestExperts scores routing keyword hits with confidence threshold and priority', () => {
  const suggestions = registry.suggestExperts('帮我把 Inbox 里的收集内容整理归档');
  const inbox = suggestions.find((item) => item.id === 'inbox-organizer');
  assert.ok(inbox, '应建议 Inbox 整理专家');
  assert.ok(inbox.matched.length >= 2, `默认阈值下需要命中 2 个关键词，实际命中：${inbox.matched.join('、')}`);

  assert.ok(!registry.suggestExperts('帮我把 Inbox 里的内容整理归档', { excludeId: 'inbox-organizer' }).some((item) => item.id === 'inbox-organizer'));
  assert.deepEqual(registry.suggestExperts('   '), []);
  assert.deepEqual(registry.suggestExperts('今天天气怎么样'), []);

  const lowThreshold = registry.saveExpert({
    id: 'low-threshold-expert',
    name: '低阈值专家',
    routing: { keywords: ['天气'], priority: 10, confidenceThreshold: 0.4 },
  });
  assert.equal(lowThreshold.source, 'workspace');
  const relaxed = registry.suggestExperts('今天天气怎么样');
  assert.ok(relaxed.some((item) => item.id === 'low-threshold-expert'), '阈值降到 0.4 后命中 1 个关键词即应建议');
  registry.deleteExpert('low-threshold-expert');
});

test('experts only execute actions covered by their capability tools', async () => {
  registry.saveExpert({
    id: 'search-only-expert',
    name: '仅检索专家',
    capabilities: { tools: ['search'], writePolicy: 'auto', maxRounds: 3 },
  });
  const upstream = await listenOnce(() => '```lattice-actions\n[{"type":"read","path":"notes/a.md"}]\n```');
  try {
    const result = await chat({
      message: 'Read the note.',
      context: { files: [], folders: [] },
      expertId: 'search-only-expert',
      mode: 'agent',
      autoApprove: true,
      provider: providerFor(upstream),
    });
    assert.deepEqual(result.actions, [], '未勾选 read 的专家不应执行读取动作');
    assert.equal(result.meta.executed.length, 0);
  } finally {
    await upstream.close();
    registry.deleteExpert('search-only-expert');
  }
});
