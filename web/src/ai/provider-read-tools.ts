import { aiApi } from '../api/ai.ts';
import type { RequestOptions } from '../api/client.ts';
import { filesApi } from '../api/files.ts';
import { createAgentToolGateway, type AgentPermissionScope } from './agent-tool-gateway.ts';
import type { AgentTool, AgentToolCall } from '../lib/ai-agent.ts';

const MAX_READ_CHARS = 12_000;
const MAX_SEARCH_BLOCKS = 8;
const MAX_SEARCH_BLOCK_CHARS = 1_600;

export const PROVIDER_READ_TOOL_NAMES = [
  'lattice_file_read',
  'lattice_note_read',
  'lattice_note_search',
] as const;

export type ProviderReadToolName = typeof PROVIDER_READ_TOOL_NAMES[number];

export interface ProviderReadToolsOptions {
  allowedPaths: readonly string[];
  requestOptions?: RequestOptions;
}

export interface ProviderReadExecutionResult {
  id: string;
  status: 'completed' | 'failed';
  result: Record<string, unknown>;
  error?: string;
}

export interface ProviderReadCheckpointDescriptor {
  id: string;
  toolName: ProviderReadToolName;
  callId: string;
  input: Record<string, string | number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrap(value: unknown): unknown {
  return isRecord(value) && 'data' in value ? value.data : value;
}

function boundedString(value: unknown, max = MAX_READ_CHARS): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function numberInput(input: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
}

function readInput(input: Record<string, unknown>): { path: string; offset: number; limit: number } {
  return {
    path: String(input.path ?? '').trim(),
    offset: numberInput(input, 'offset', 0, 100_000),
    limit: numberInput(input, 'limit', MAX_READ_CHARS, MAX_READ_CHARS),
  };
}

function safeFileRead(value: unknown): Record<string, unknown> {
  const data = unwrap(value);
  if (!isRecord(data)) return { status: 'completed', value: boundedString(data) };
  return {
    status: 'completed',
    ...(typeof data.path === 'string' ? { path: data.path } : {}),
    ...(typeof data.size === 'number' ? { size: data.size } : {}),
    ...(typeof data.offset === 'number' ? { offset: data.offset } : {}),
    ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
    ...(typeof data.eof === 'boolean' ? { eof: data.eof } : {}),
    content: boundedString(data.content),
  };
}

function safeSearch(value: unknown): Record<string, unknown> {
  const data = unwrap(value);
  if (!isRecord(data)) return { status: 'completed', blocks: [] };
  const rawBlocks = Array.isArray(data.blocks) ? data.blocks : [];
  const blocks = rawBlocks.slice(0, MAX_SEARCH_BLOCKS).flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      citationId: boundedString(item.citationId, 80),
      noteId: boundedString(item.noteId, 120),
      path: boundedString(item.path, 1024),
      title: boundedString(item.title, 200),
      anchor: boundedString(item.anchor, 200),
      excerpt: boundedString(item.excerpt, 500),
      content: boundedString(item.content, MAX_SEARCH_BLOCK_CHARS),
      score: typeof item.score === 'number' ? item.score : undefined,
      trusted: item.trusted === true ? true : false,
    }];
  });
  return {
    status: 'completed',
    query: boundedString(data.query, 200),
    strategy: boundedString(data.strategy, 80),
    permissionFiltered: data.permissionFiltered === true,
    blocks,
  };
}

function markdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path);
}

export function createProviderReadTools(options: ProviderReadToolsOptions): AgentTool[] {
  const permissionScope: AgentPermissionScope = { allowedPaths: options.allowedPaths };
  const requestOptions = options.requestOptions;
  const readFile = async (input: Record<string, unknown>) => {
    const { path, offset, limit } = readInput(input);
    return safeFileRead(await filesApi.read(path, offset, limit, requestOptions));
  };

  return [
    {
      name: 'lattice_file_read',
      kind: 'read',
      riskLevel: 'L0',
      description: '读取授权范围内 Vault 文件的正文片段，不执行任何写操作。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault 相对路径' },
          offset: { type: 'integer', minimum: 0, description: '字符起始偏移' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ_CHARS, description: '最多读取字符数' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      timeoutMs: 15_000,
      supportsUndo: false,
      idempotent: true,
      permission: { pathFields: ['path'], requiresScope: true },
      execute: readFile,
    },
    {
      name: 'lattice_note_read',
      kind: 'read',
      riskLevel: 'L0',
      description: '读取授权范围内 Markdown 笔记正文片段，不执行任何写操作。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Markdown 笔记的 Vault 相对路径' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ_CHARS },
        },
        required: ['path'],
        additionalProperties: false,
      },
      timeoutMs: 15_000,
      supportsUndo: false,
      idempotent: true,
      permission: { pathFields: ['path'], requiresScope: true },
      execute: async (input) => {
        const { path } = readInput(input);
        if (!markdownPath(path)) throw new Error('笔记读取工具只允许 Markdown 文件');
        return readFile(input);
      },
    },
    {
      name: 'lattice_note_search',
      kind: 'read',
      riskLevel: 'L0',
      description: '在授权范围内检索笔记并返回带来源的短片段，不执行任何写操作。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 12 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      timeoutMs: 30_000,
      supportsUndo: false,
      idempotent: true,
      permission: { requiresScope: true },
      execute: async (input) => {
        const query = String(input.query ?? '').trim().slice(0, 200);
        if (!query) throw new Error('检索关键词不能为空');
        const value = await aiApi.retrievalPreview({
          query,
          limit: numberInput(input, 'limit', 8, 12),
          allowedPaths: [...options.allowedPaths],
        }, requestOptions);
        return safeSearch(value);
      },
    },
  ];
}

export function isProviderReadToolCall(call: { name?: string } | null | undefined): boolean {
  return Boolean(call?.name && (PROVIDER_READ_TOOL_NAMES as readonly string[]).includes(call.name));
}

export function isProviderReadToolName(value: unknown): value is ProviderReadToolName {
  return typeof value === 'string' && (PROVIDER_READ_TOOL_NAMES as readonly string[]).includes(value);
}

export function providerReadCheckpointDescriptor(call: AgentToolCall): ProviderReadCheckpointDescriptor | null {
  if (!isProviderReadToolName(call.name) || !isRecord(call.input) || !call.id.trim()) return null;
  if (call.name === 'lattice_note_search') {
    const query = String(call.input.query ?? '').trim().slice(0, 200);
    if (!query) return null;
    return {
      id: `provider-read:${call.id}`,
      toolName: call.name,
      callId: call.id,
      input: { query, limit: numberInput(call.input, 'limit', 8, 12) },
    };
  }
  const { path, offset, limit } = readInput(call.input);
  if (!path) return null;
  return {
    id: `provider-read:${call.id}`,
    toolName: call.name,
    callId: call.id,
    input: { path: path.slice(0, 1024), offset, limit },
  };
}

export function providerReadCallFromCheckpoint(step: {
  id?: string;
  toolName?: string;
  callId?: string;
  input?: Record<string, string | number>;
}): AgentToolCall | null {
  if (!isProviderReadToolName(step.toolName) || typeof step.callId !== 'string' || !step.callId.trim() || !isRecord(step.input)) return null;
  const input = step.input;
  if (step.toolName === 'lattice_note_search') {
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 200) : '';
    if (!query) return null;
    return {
      id: step.callId,
      name: step.toolName,
      input: { query, limit: numberInput(input, 'limit', 8, 12) },
    };
  }
  const path = typeof input.path === 'string' ? input.path.trim().slice(0, 1024) : '';
  if (!path) return null;
  return {
    id: step.callId,
    name: step.toolName,
    input: {
      path,
      offset: numberInput(input, 'offset', 0, 100_000),
      limit: numberInput(input, 'limit', MAX_READ_CHARS, MAX_READ_CHARS),
    },
  };
}

export async function executeProviderReadToolCalls(
  calls: AgentToolCall[],
  options: ProviderReadToolsOptions & { runId: string; signal: AbortSignal },
): Promise<ProviderReadExecutionResult[]> {
  const tools = createProviderReadTools(options);
  const gateway = createAgentToolGateway({ tools, runId: options.runId, actor: 'local-user', role: 'editor' });
  const context = {
    runId: options.runId,
    actor: 'local-user',
    role: 'editor',
    signal: options.signal,
    permissionScope: { allowedPaths: options.allowedPaths },
  };
  const preflight = await gateway.preflight(calls, context);
  return Promise.all(preflight.map(async (item) => {
    if (!item.allowed) {
      return { id: item.call.id, status: 'failed', result: { status: 'denied', error: item.reason ?? '工具未通过权限检查' }, error: item.reason };
    }
    try {
      const value = await gateway.execute(item.call, context);
      const result = isRecord(value) ? value : { status: 'completed', value: boundedString(value) };
      return { id: item.call.id, status: 'completed', result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: item.call.id, status: 'failed', result: { status: 'failed', error: message.slice(0, 500) }, error: message };
    }
  }));
}
