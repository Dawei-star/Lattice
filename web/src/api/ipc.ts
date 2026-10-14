/**
 * 桌面通道（Tauri IPC）与 HTTP 通道的双轨分发 —— 升级计划 P1-05 收尾项。
 *
 * 设计要点：
 *  1. **分发点唯一**：只有 `client.ts` 的 `requestRaw` 调用本模块，api 业务模块
 *     （vault/resources/canvas/files/experts/review...）保持不动，避免 81 个调用点二次改造。
 *  2. **缺命令不致命**：桌面形态下命中 `IPC_ROUTES` 的路由走 `invoke`，未命中或
 *     本轨道表达不了的请求一律回落 HTTP。迁移期两条通道并存，不会因为 Rust 侧
 *     还有 ⬜ 未实现的命令而中断功能（见 `ipc-routes.ts` 的排除清单）。
 *  3. **信封还原**：Rust 命令返回的是「数据本身」，HTTP 轨是 `{data, meta}`。
 *     本模块把命令返回值包装回信封，使 `http.get`（解包 `.data`）与
 *     `http.getFull`（读 `.meta`）两种用法语义不变。
 *  4. **错误归一**：Rust 命令错误类型是 `Result<T, String>`（线缆上是裸字符串，
 *     不含 code），HTTP 轨是 `{error:{code,message,details,requestId}}`。
 *     这里以 `IpcError` 抛出、由 `client.ts` 转成 `ApiError`（code 固定 `IPC_ERROR`），
 *     保证 UI 侧的 catch 分支行为一致。
 *  5. **无网络语义**：invoke 是进程内调用，不走重试、超时与离线判定；
 *     因此分发发生在 `requestRaw` 的重试循环之外。
 *
 * 不覆盖的形态（保持原样，登记为后续项）：SSE 流（`ai.ts` 的 postSse）、
 * 二进制下载（`vault-files.ts` 的 download）、URL 构造（assetUrl/attachmentUrl）、
 * 桌面桥（`window.latticeDesktop.*`）、SSE 票据换取（`workspace-auth.ts`）。
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { IPC_ROUTES } from './ipc-routes.ts';

export type IpcHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** 分发上下文：与 `requestRaw` 的入参一一对应。 */
export interface IpcCallContext {
  /** 动态段捕获值（已 `decodeURIComponent`） */
  readonly params: Readonly<Record<string, string>>;
  /** `requestRaw` 的 query（保持原值，未做字符串化） */
  readonly query: Readonly<Record<string, unknown>>;
  /** JSON 请求体（`requestRaw` 的 body） */
  readonly body: unknown;
  /** 原始二进制体（`postRaw` 的 BodyInit，如 File / Blob / Uint8Array） */
  readonly rawBody: unknown;
}

/** `requestRaw` 期望的信封形状。 */
export interface IpcEnvelope {
  data: unknown;
  meta?: unknown;
}

/** 一条「HTTP 路由 → Tauri 命令」映射。 */
export interface IpcRoute {
  method: IpcHttpMethod;
  /** 静态路由写字符串；含动态段写 RegExp（不可带 `g` 标志，须用命名组） */
  path: string | RegExp;
  /** Tauri 命令名（= `src-tauri/src/lib.rs` 中的函数名） */
  command: string;
  /**
   * 构造 invoke 参数。返回 `undefined` 表示「本请求在桌面通道上表达不了」，
   * 交回 HTTP 轨处理（例如 rawBody 不是 File）。
   */
  args?: (ctx: IpcCallContext) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  /** 命令返回值 → 信封；缺省为 `{ data: value }` */
  envelope?: (value: unknown) => IpcEnvelope;
  /** 留档说明：为何需要自定义 args/envelope，供 P1-08 契约核销 */
  note?: string;
}

/** 桌面通道调用失败。由 `client.ts` 转成 `ApiError`。 */
export class IpcError extends Error {
  readonly command: string;

  constructor(command: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IpcError';
    this.command = command;
  }

  /** invoke 的 reject 值是 Rust 的 `String`（见模块注释 4） */
  private static toMessage(error: unknown): string {
    if (typeof error === 'string' && error) return error;
    if (error instanceof Error && error.message) return error.message;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
    return '桌面通道调用失败';
  }

  static from(command: string, error: unknown): IpcError {
    return new IpcError(command, IpcError.toMessage(error), { cause: error });
  }
}

export interface IpcHandled {
  handled: true;
  payload: unknown;
}

export interface IpcSkipped {
  handled: false;
  reason: 'not-desktop' | 'no-route' | 'unsupported';
}

export type IpcDispatchResult = IpcHandled | IpcSkipped;

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface MatchedRoute {
  route: IpcRoute;
  params: Record<string, string>;
}

/** 按注册顺序查找路由；静态段先于动态段注册（见 ipc-routes.ts 的排序约定）。 */
export function matchIpcRoute(method: string, path: string): MatchedRoute | null {
  for (const route of IPC_ROUTES) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === path) return { route, params: {} };
      continue;
    }
    const match = route.path.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(match.groups ?? {})) {
      params[key] = decodeParam(value ?? '');
    }
    return { route, params };
  }
  return null;
}

/**
 * 尝试走桌面通道。
 *
 * - 非桌面形态、无匹配路由、或路由自述表达不了 → `{ handled: false }`，调用方回落 HTTP；
 * - 命中并成功 → `{ handled: true, payload }`，payload 是 `{data, meta?}` 信封；
 * - 命令报错 → 抛 `IpcError`。
 */
export async function dispatchViaIpc(
  method: string,
  path: string,
  ctx: Omit<IpcCallContext, 'params'>,
): Promise<IpcDispatchResult> {
  if (!isTauri()) {
    return { handled: false, reason: 'not-desktop' };
  }

  const matched = matchIpcRoute(method.toUpperCase(), path);
  if (!matched) return { handled: false, reason: 'no-route' };

  const { route, params } = matched;
  const args = route.args ? await route.args({ ...ctx, params }) : {};
  if (args === undefined) return { handled: false, reason: 'unsupported' };

  let value: unknown;
  try {
    value = await invoke(route.command, args);
  } catch (error) {
    throw IpcError.from(route.command, error);
  }

  return { handled: true, payload: route.envelope ? route.envelope(value) : { data: value } };
}
