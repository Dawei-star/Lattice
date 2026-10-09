/**
 * Obsidian .canvas 导入兼容性回归：
 * 读取时归一化（fromNode/toNode、"1"~"6" 颜色、group/link 节点），
 * 且归一化后的文档能通过 PUT 校验成功保存（此前 text 必填、宽高 180~720 会全部拒掉）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-canvas-obsidian-'));
const vaultDir = path.join(root, 'vault');
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(root, 'lattice.db');
process.env.VAULT_DIR = vaultDir;

const [{ createApp }, { openDatabase, closeDatabase }, { runMigrations }] = await Promise.all([
  import('../src/app.js'),
  import('../src/db/index.js'),
  import('../src/db/migrate.js'),
]);

openDatabase();
runMigrations();

const OBSIDIAN_CANVAS = {
  nodes: [
    { id: 'group-1', type: 'group', x: 0, y: 0, width: 1600, height: 900, label: '第一章' },
    { id: 'card-a', type: 'text', text: '卡片 A', x: 40, y: 80, width: 320, height: 200, color: '1' },
    { id: 'card-b', type: 'text', text: '卡片 B', x: 420, y: 120, width: 260, height: 160, color: '#9b59b6' },
    { id: 'card-c', type: 'text', text: '无色卡片', x: 700, y: 90, width: 240, height: 150 },
    { id: 'note-1', type: 'file', file: '笔记/北京大学.md', x: 60, y: 400, width: 300, height: 180 },
    { id: 'img-1', type: 'image', file: '附件/示意图.png', x: 500, y: 420, width: 400, height: 300 },
  ],
  edges: [
    { id: 'edge-1', fromNode: 'card-a', toNode: 'card-b', fromSide: 'right', toSide: 'left', color: '4' },
    { id: 'edge-2', fromNode: 'card-a', toNode: 'missing-node', fromSide: 'right', toSide: 'left' },
  ],
};

test('读取 Obsidian 画布时归一化边端点、颜色与节点类型，且归一化结果可保存', async (t) => {
  await fs.mkdir(path.join(vaultDir, '笔记'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, '导入.canvas'), JSON.stringify(OBSIDIAN_CANVAS));

  const server = createApp().listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const get = async (canvasPath) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/canvas?path=${encodeURIComponent(canvasPath)}`);
    return { status: response.status, payload: await response.json() };
  };

  const { status, payload } = await get('导入.canvas');
  assert.equal(status, 200);
  const { nodes, edges } = payload.data;

  // 边：fromNode/toNode → from/to，指向缺失节点的边被丢弃
  assert.deepEqual(edges, [
    { id: 'edge-1', from: 'card-a', to: 'card-b', fromSide: 'right', toSide: 'left', color: 'green' },
  ]);

  // 节点：group 排最前且 label 落到 text；"1" → red；#hex 按色相就近映射；file 节点带 path
  const group = nodes.find((node) => node.id === 'group-1');
  assert.equal(nodes[0].id, 'group-1');
  assert.equal(group.type, 'group');
  assert.equal(group.text, '第一章');
  assert.equal(group.width, 1600);
  assert.equal(group.height, 900);

  assert.equal(nodes.find((node) => node.id === 'card-a').color, 'red');
  assert.equal(nodes.find((node) => node.id === 'card-b').color, 'purple');
  const fileNode = nodes.find((node) => node.id === 'note-1');
  assert.equal(fileNode.text, '北京大学');
  assert.equal(fileNode.path, '笔记/北京大学.md');
  const imageNode = nodes.find((node) => node.id === 'img-1');
  assert.equal(imageNode.path, '附件/示意图.png');
  assert.equal(nodes.find((node) => node.id === 'card-c').color, undefined);

  // 归一化后的文档能通过 PUT 保存（大尺寸、group 类型、无 text 的节点都不再 400）
  const saveResponse = await fetch(`http://127.0.0.1:${port}/api/canvas?path=${encodeURIComponent('导入.canvas')}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges, confirmed: true }),
  });
  assert.equal(saveResponse.status, 200);

  const saved = await get('导入.canvas');
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.payload.data.edges.map((edge) => [edge.from, edge.to]), [['card-a', 'card-b']]);
});
