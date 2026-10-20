import type { AgentTool, AgentToolCall, AgentToolKind } from '../lib/ai-agent.ts';
import { classifyAiWriteRisk, type AiRiskLevel } from '../lib/ai-policy.ts';

export interface AgentPermissionScope {
  /** Vault-relative paths the current actor may read or write. */
  allowedPaths?: readonly string[];
  scopeId?: string;
  permissionVersion?: string;
}

export interface AgentToolGatewayContext {
  runId: string;
  actor: string;
  role: string;
  signal: AbortSignal;
  permissionScope?: AgentPermissionScope;
  untrustedContext?: boolean;
  /** Set only after the user explicitly approves an external high-risk write. */
  externalWriteAuthorized?: boolean;
}

export interface AgentToolExecutionContext extends AgentToolGatewayContext {
  call: AgentToolCall;
  idempotencyKey: string;
}

export interface AgentToolGatewayOptions {
  tools: AgentTool[];
  runId?: string;
  actor?: string;
  role?: string;
  authorize?: (call: AgentToolCall, tool: AgentTool, context: AgentToolGatewayContext) => boolean | Promise<boolean>;
}

export interface AgentToolPreflightResult {
  allowed: boolean;
  call: AgentToolCall;
  reason?: string;
}

export interface AgentToolGateway {
  list: () => AgentTool[];
  find: (name: string) => AgentTool | undefined;
  preflight: (calls: AgentToolCall[], context: AgentToolGatewayContext) => Promise<AgentToolPreflightResult[]>;
  execute: (call: AgentToolCall, context: AgentToolGatewayContext) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredFields(tool: AgentTool): string[] {
  const schema = tool.inputSchema;
  if (!isRecord(schema) || !Array.isArray(schema.required)) return [];
  return schema.required.map((field) => String(field)).filter(Boolean);
}

function validateInput(tool: AgentTool, call: AgentToolCall): string | null {
  if (!call || typeof call.id !== 'string' || !call.id.trim()) return '工具调用缺少 call id';
  if (!isRecord(call.input)) return `工具 ${tool.name} 的输入必须是对象`;
  const missing = requiredFields(tool).filter((field) => call.input[field] === undefined || call.input[field] === null || call.input[field] === '');
  return missing.length ? `工具 ${tool.name} 缺少必填参数：${missing.join('、')}` : null;
}

function isWriteTool(tool: AgentTool) {
  return tool.kind === 'write' || tool.riskLevel === 'L1' || tool.riskLevel === 'L2' || tool.riskLevel === 'L3';
}

function riskForTool(tool: AgentTool, call: AgentToolCall): AiRiskLevel {
  if (tool.riskLevel) return tool.riskLevel;
  const risk = classifyAiWriteRisk({ ...(call.input as Record<string, unknown>), type: call.input.type ?? tool.kind }).level;
  // An undeclared write must fail closed instead of being treated as read-only.
  return tool.kind === 'write' && risk === 'L0' ? 'L2' : risk;
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//u.test(path) || path.split('/').includes('..')) return null;
  return path;
}

function isPathWithinScope(path: string, allowedPaths: readonly string[]) {
  return allowedPaths.some((allowed) => {
    const scope = normalizePath(allowed);
    return Boolean(scope && (path === scope || path.startsWith(`${scope}/`)));
  });
}

function securityReason(call: AgentToolCall, tool: AgentTool, context: AgentToolGatewayContext): string | null {
  const pathFields = tool.permission?.pathFields ?? ['path', 'targetPath', 'sourcePath', 'fromPath', 'toPath']
    .filter((field) => call.input[field] !== undefined && call.input[field] !== null);
  if (tool.permission?.requiresScope && !context.permissionScope?.allowedPaths) {
    return `工具 ${tool.name} 缺少有效权限范围`;
  }
  if (pathFields.length) {
    const allowedPaths = context.permissionScope?.allowedPaths;
    if (!allowedPaths) return `工具 ${tool.name} 未携带路径权限范围`;
    for (const field of pathFields) {
      const path = normalizePath(call.input[field]);
      if (!path) return `工具 ${tool.name} 的路径参数无效：${field}`;
      if (!isPathWithinScope(path, allowedPaths)) return `工具 ${tool.name} 超出授权路径范围：${path}`;
    }
  }
  if (context.untrustedContext && isWriteTool(tool) && ['L2', 'L3'].includes(riskForTool(tool, call)) && !context.externalWriteAuthorized) {
    return '不可信内容不能直接驱动高风险写操作，需要用户明确授权';
  }
  return null;
}

function idempotencyKey(runId: string, call: AgentToolCall) {
  return `${runId}:${call.id}:${call.name}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function defaultRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error && typeof error === 'object' && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable !== false;
  }
  return true;
}

function resultValidationError(tool: AgentTool, value: unknown): string | null {
  if (!tool.validateResult) return null;
  const verdict = tool.validateResult(value);
  if (verdict === true) return null;
  if (typeof verdict === 'string' && verdict.trim()) return verdict;
  return `工具 ${tool.name} 返回结果未通过校验`;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      timer = undefined as unknown as ReturnType<typeof globalThis.setTimeout>;
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function retryLimit(tool: AgentTool): number {
  if (!tool.idempotent) return 1;
  const configured = Number(tool.retry?.maxAttempts ?? 2);
  return Number.isFinite(configured) ? Math.min(3, Math.max(1, Math.floor(configured))) : 2;
}

async function executeWithRetry(
  tool: AgentTool,
  call: AgentToolCall,
  context: AgentToolGatewayContext,
  key: string,
): Promise<unknown> {
  const attempts = retryLimit(tool);
  const backoffMs = Math.min(2000, Math.max(0, Number(tool.retry?.backoffMs ?? 0) || 0));
  const retryable = tool.retry?.retryable ?? defaultRetryable;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (context.signal.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const value = await tool.execute(call.input, {
        signal: context.signal,
        call,
        runId: context.runId,
        actor: context.actor,
        role: context.role,
        idempotencyKey: key,
        attempt,
      });
      const validationError = resultValidationError(tool, value);
      if (validationError) throw new Error(validationError);
      return value;
    } catch (error) {
      lastError = error;
      if (isAbortError(error) || attempt >= attempts || !retryable(error)) throw error;
      await waitForRetry(backoffMs * 2 ** (attempt - 1), context.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? '工具执行失败'));
}

/**
 * Single execution boundary for Agent tools. It is intentionally transport-neutral:
 * a tool can call WorkspaceService, Tauri IPC, or an HTTP adapter without changing
 * the Agent loop.
 */
export function createAgentToolGateway(options: AgentToolGatewayOptions): AgentToolGateway {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const completed = new Map<string, unknown>();
  const inFlight = new Map<string, Promise<unknown>>();
  const defaultRunId = options.runId ?? 'run-unknown';
  const defaultActor = options.actor ?? 'local-user';
  const defaultRole = options.role ?? 'editor';

  const resolveContext = (context: AgentToolGatewayContext): AgentToolGatewayContext => ({
    runId: context.runId || defaultRunId,
    actor: context.actor || defaultActor,
    role: context.role || defaultRole,
    signal: context.signal,
    permissionScope: context.permissionScope,
    untrustedContext: context.untrustedContext === true,
    externalWriteAuthorized: context.externalWriteAuthorized === true,
  });

  return {
    list: () => [...tools.values()],
    find: (name) => tools.get(name),
    async preflight(calls, rawContext) {
      const context = resolveContext(rawContext);
      return Promise.all(calls.map(async (call): Promise<AgentToolPreflightResult> => {
        const tool = tools.get(call.name);
        if (!tool) return { allowed: false, call, reason: `未知工具：${call.name}` };
        const inputError = validateInput(tool, call);
        if (inputError) return { allowed: false, call, reason: inputError };
        if (context.role === 'viewer' && isWriteTool(tool)) return { allowed: false, call, reason: 'viewer 角色不能执行写工具' };
        const securityError = securityReason(call, tool, context);
        if (securityError) return { allowed: false, call, reason: securityError };
        if (options.authorize && !(await options.authorize(call, tool, context))) return { allowed: false, call, reason: `工具 ${call.name} 未通过权限复核` };
        return { allowed: true, call };
      }));
    },
    async execute(call, rawContext) {
      const context = resolveContext(rawContext);
      const tool = tools.get(call.name);
      if (!tool) throw new Error(`未知工具：${call.name}`);
      const inputError = validateInput(tool, call);
      if (inputError) throw new Error(inputError);
      if (context.role === 'viewer' && isWriteTool(tool)) throw new Error('viewer 角色不能执行写工具');
      const securityError = securityReason(call, tool, context);
      if (securityError) throw new Error(securityError);
      if (options.authorize && !(await options.authorize(call, tool, context))) throw new Error(`工具 ${call.name} 未通过权限复核`);
      const key = idempotencyKey(context.runId, call);
      if (tool.idempotent && completed.has(key)) return completed.get(key);
      if (tool.idempotent) {
        const pending = inFlight.get(key);
        if (pending) return pending;
        const execution = executeWithRetry(tool, call, context, key);
        inFlight.set(key, execution);
        try {
          const value = await execution;
          completed.set(key, value);
          return value;
        } finally {
          inFlight.delete(key);
        }
      }
      return executeWithRetry(tool, call, context, key);
    },
  };
}

export type { AgentToolKind, AiRiskLevel };
