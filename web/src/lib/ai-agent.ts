import type { AiRiskLevel } from './ai-policy.ts';

// W7 循环退役：Agent 循环已下沉 Rust 内核（ai/core/agent，W7b 读轮 / W7c 写确认）。
// 本文件只保留「工具描述面」——web 网关（agent-tool-gateway）与读工具执行
// （provider-read-tools）仍按此形状与内核对齐；runAiAgent 及其决策类型已随
// web 循环退役删除（W7c 死代码清理）。

export type AgentToolKind = 'read' | 'write';

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  kind: AgentToolKind;
  description?: string;
  riskLevel?: AiRiskLevel;
  inputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  supportsUndo?: boolean;
  idempotent?: boolean;
  retry?: {
    /** Total attempts, including the initial call. Non-idempotent tools are capped at one. */
    maxAttempts?: number;
    backoffMs?: number;
    retryable?: (error: unknown) => boolean;
  };
  /** Return true/string on success; return false or an error message on invalid output. */
  validateResult?: (value: unknown) => boolean | string;
  permission?: {
    pathFields?: string[];
    requiresScope?: boolean;
  };
  execute: (input: Record<string, unknown>, context: {
    signal: AbortSignal;
    call: AgentToolCall;
    runId?: string;
    actor?: string;
    role?: string;
    idempotencyKey?: string;
    attempt?: number;
  }) => Promise<unknown>;
}
