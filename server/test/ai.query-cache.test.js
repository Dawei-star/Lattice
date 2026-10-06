import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-qcache-'));
process.env.DB_FILE = path.join(runtimeRoot, 'lattice.db');
process.env.NODE_ENV = 'test';

const { openDatabase, getDb } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrate.js');
openDatabase();
runMigrations();

const settings = await import('../src/modules/ai/ai.settings.js');
const { retrieveContext } = await import('../src/modules/ai/ai.retrieval.js');

/** mock embedding 上游：按输入文本长度返回固定三维向量，统计请求次数 */
async function listenEmbeddingUpstream(counter) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      counter.hits += 1;
      const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        data: inputs.map((input, index) => ({ index, embedding: [input.length % 7, 1, 0] })),
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/embeddings`,
    // undici keep-alive 连接会让 close() 永不完成，先强制断开
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('query embedding is cached: identical question hits upstream only once', async () => {
  const counter = { hits: 0 };
  const upstream = await listenEmbeddingUpstream(counter);

  try {
    // 落库 embedding 配置（明文兼容模式，测试环境无加密 Key）
    settings.saveServerSettings({
      providers: [],
      activeProviderId: null,
      embedding: { endpoint: upstream.endpoint, model: 'mock-embedding', apiKey: 'k'.repeat(20) },
    });

    getDb()
      .prepare('INSERT OR IGNORE INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('qc-note-1', '缓存样例', '这是一篇讲知识管理的笔记，包含若干段落，用于验证查询向量缓存。', new Date().toISOString(), new Date().toISOString());

    await retrieveContext('什么是知识管理');
    assert.equal(counter.hits, 1, '首次查询应请求一次 embedding');

    // 完全相同的问题：命中缓存，不再请求上游
    await retrieveContext('什么是知识管理');
    assert.equal(counter.hits, 1, '相同问题应命中缓存');

    // 首尾空白差异：规范化后同样命中
    await retrieveContext('  什么是知识管理  ');
    assert.equal(counter.hits, 1, '规范化后应命中缓存');

    // 不同问题：新请求
    await retrieveContext('如何整理收件箱');
    assert.equal(counter.hits, 2);
  } finally {
    await upstream.close();
  }
});
