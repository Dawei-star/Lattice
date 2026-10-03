#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = (process.env.LATTICE_API_URL ?? 'http://127.0.0.1:5177/api').replace(/\/+$/, '');
const ACCESS_TOKEN = process.env.LATTICE_AI_ACCESS_TOKEN?.trim() ?? '';
const WORKSPACE_TOKEN = process.env.LATTICE_WORKSPACE_ACCESS_TOKEN?.trim() || ACCESS_TOKEN;
const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

try {
  if (command === 'chat') {
    const agent = args.includes('--agent');
    const autoApprove = agent && !args.includes('--confirm-writes');
    const message = args.filter((arg) => !arg.startsWith('--')).join(' ').trim();
    if (!message) throw new Error('chat 需要一段自然语言消息');
    await printJson(await request('/ai/chat', 'POST', {
      message,
      actor: 'cli-user',
      role: process.env.LATTICE_ROLE ?? 'editor',
      provider: providerFromEnv(),
      context: { files: [], folders: [] },
      // --agent：任务循环模式，模型自主多轮执行工具；默认自动执行写操作，
      // 加 --confirm-writes 则写操作仍走 preview → execute 两步
      mode: agent ? 'agent' : 'assist',
      autoApprove: agent ? autoApprove : false,
    }));
  } else if (command === 'preview') {
    const body = parseJsonArgument(args, 'preview');
    await printJson(await request('/ai/operations/preview', 'POST', {
      ...body,
      actor: 'cli-user',
      role: process.env.LATTICE_ROLE ?? 'editor',
    }));
  } else if (command === 'execute') {
    const confirmed = args.includes('--confirm');
    const body = parseJsonArgument(args.filter((arg) => arg !== '--confirm'), 'execute');
    await printJson(await request('/ai/operations/execute', 'POST', {
      ...body,
      confirmed,
      actor: 'cli-user',
      role: process.env.LATTICE_ROLE ?? 'editor',
      source: 'cli',
    }));
  } else if (command === 'history') {
    const limitIndex = args.indexOf('--limit');
    let limit = '80';
    if (limitIndex >= 0) {
      const raw = args[limitIndex + 1];
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error('--limit 需要一个正整数，例如 --limit 40');
      }
      limit = raw;
    }
    await printJson(await request(`/ai/history?limit=${encodeURIComponent(limit)}`));
  } else {
    throw new Error(`未知命令：${command}`);
  }
} catch (error) {
  console.error(`lattice-ai: ${error.message}`);
  process.exitCode = 1;
}

async function request(path, method = 'GET', body) {
  // 120 秒兜底：agent 模式的多轮任务可能较慢，但服务端不可达时脚本不能挂死
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(WORKSPACE_TOKEN ? { 'X-Workspace-Token': WORKSPACE_TOKEN } : {}),
      ...(ACCESS_TOKEN ? { Authorization: `Bearer ${ACCESS_TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload?.data ?? payload;
}

function parseJsonArgument(values, commandName) {
  const raw = values.join(' ').trim();
  if (!raw) throw new Error(`${commandName} 需要 JSON，例如 {"actions":[...]}`);
  try {
    return JSON.parse(raw);
  } catch {
    // PowerShell 会把整个参数包进一层引号：剥掉首尾成对引号后重试。
    // 先按原文解析，避免误伤首尾恰好都是引号的真实 JSON（如 "a" and "b" 类内容）
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      const stripped = raw.slice(1, -1).trim();
      try {
        return JSON.parse(stripped);
      } catch {
        // 落到 --file 分支给出更可操作的提示
      }
    }
  }
  const fileIndex = values.indexOf('--file');
  const fileName = fileIndex >= 0 ? values[fileIndex + 1] : '';
  if (fileName) {
    try {
      return JSON.parse(fs.readFileSync(path.resolve(fileName), 'utf8'));
    } catch (fileError) {
      throw new Error(`${commandName} 无法读取 JSON 文件：${fileError.message}`);
    }
  }
  throw new Error(`${commandName} 的参数不是有效 JSON；PowerShell 可改用 --file plan.json`);
}

function providerFromEnv() {
  if (!process.env.LATTICE_AI_ENDPOINT || !process.env.LATTICE_AI_API_KEY) return null;
  return {
    endpoint: process.env.LATTICE_AI_ENDPOINT,
    apiKey: process.env.LATTICE_AI_API_KEY,
    model: process.env.LATTICE_AI_MODEL ?? 'gpt-4o-mini',
    authHeader: process.env.LATTICE_AI_AUTH_HEADER === 'x-api-key' ? 'x-api-key' : 'bearer',
  };
}

async function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  console.log(`Lattice AI file manager\n\nCommands:\n  npm run ai -- chat <message>            助手模式：问答与操作计划\n  npm run ai -- chat --agent <task>       任务模式：自主多轮执行，写操作默认自动\n  npm run ai -- chat --agent --confirm-writes <task>\n                                          任务模式，但写操作需手动 preview/execute\n  npm run ai -- preview --file plan.json\n  npm run ai -- execute --confirm --file plan.json\n  npm run ai -- history --limit 40\n\nEnvironment:\n  LATTICE_API_URL         API base (default: http://127.0.0.1:5177/api)\n  LATTICE_ROLE            viewer, editor or admin (default: editor)\n  LATTICE_AI_ENDPOINT     optional OpenAI-compatible endpoint\n  LATTICE_AI_API_KEY      optional provider key\n  LATTICE_AI_MODEL        optional provider model\n  LATTICE_AI_ACCESS_TOKEN optional workspace bearer token\n`);
}
