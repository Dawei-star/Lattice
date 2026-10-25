// 模型目录 IPC 客户端（W3-7）：目录数据、动态发现、本机运行时探测。
// 桌面形态走 invoke；浏览器形态或命令失败一律回退内置目录（aiProviders.ts），
// 任何失败都不阻塞手填配置。

import { invoke, isTauri } from '@tauri-apps/api/core';
import { PROVIDERS, type AiCatalogModelInfo, type AiProviderCatalogEntry } from './aiProviders.ts';

/** 内核目录服务（ai_models_catalog 返回结构，camelCase）。 */
export interface CatalogService {
  key: string;
  label: string;
  endpoint?: string;
  keyUrl?: string;
  hint?: string;
  local?: boolean;
  models?: AiCatalogModelInfo[];
}

/** 动态发现的模型条目（ai_provider_models 返回结构）。 */
export interface DiscoveredModel {
  id: string;
  label?: string | null;
  ownedBy?: string | null;
  contextWindowTokens?: number | null;
}

/** 本机运行时探测结果（ai_runtime_detect 返回结构）。 */
export interface LocalRuntimeInfo {
  kind: string;
  endpoint: string;
  models: DiscoveredModel[];
}

/** 目录服务 → 服务商目录条目：Logo 按 key 就近匹配内置表，缺失回退自定义图标。 */
export function catalogServiceToEntry(service: CatalogService): AiProviderCatalogEntry {
  const known = PROVIDERS.find((provider) => provider.key === service.key);
  const models = Array.isArray(service.models) ? service.models : [];
  return {
    key: service.key,
    label: service.label,
    description: service.local ? '本机离线模型' : (known?.description ?? service.label),
    logo: known?.logo ?? '/provider-logos/custom.svg',
    endpoint: service.endpoint ?? '',
    keyUrl: service.keyUrl,
    hint: service.hint,
    local: service.local === true,
    models: models.map((model) => model.id),
    modelInfo: models,
  };
}

/** 合并目录：custom 恒在首位；目录服务替换同 key 内置项，目录独有的追加。 */
export function mergeCatalogServices(services: CatalogService[]): AiProviderCatalogEntry[] {
  const custom = PROVIDERS[0];
  const merged = [custom, ...PROVIDERS.slice(1).map((provider) => ({ ...provider }))];
  for (const service of services) {
    if (!service?.key || service.key === 'custom') continue;
    const entry = catalogServiceToEntry(service);
    const index = merged.findIndex((provider) => provider.key === service.key);
    if (index >= 1) merged[index] = entry;
    else merged.push(entry);
  }
  return merged;
}

/** 拉取目录条目（桌面 = 内置 JSON + Vault 覆盖；浏览器/失败 = 内置 PROVIDERS）。 */
export async function loadModelCatalogEntries(): Promise<AiProviderCatalogEntry[]> {
  if (!isTauri()) return PROVIDERS;
  try {
    const catalog = await invoke<{ services?: CatalogService[] }>('ai_models_catalog');
    const services = Array.isArray(catalog?.services) ? catalog.services : [];
    return services.length ? mergeCatalogServices(services) : PROVIDERS;
  } catch {
    return PROVIDERS;
  }
}

/** 按端点动态拉取真实模型清单（OpenAI 兼容 GET /models）。失败抛错，由调用方展示并回退手填。 */
export async function discoverProviderModels(
  endpoint: string,
  apiKey: string,
  authHeader: string,
): Promise<DiscoveredModel[]> {
  const models = await invoke<DiscoveredModel[]>('ai_provider_models', {
    endpoint,
    apiKey: apiKey || undefined,
    authHeader: authHeader || undefined,
  });
  return Array.isArray(models) ? models : [];
}

/** 扫描本机推理运行时（loopback 端口探测，免密钥）。失败返回空列表。 */
export async function detectLocalRuntimes(): Promise<LocalRuntimeInfo[]> {
  if (!isTauri()) return [];
  try {
    const runtimes = await invoke<LocalRuntimeInfo[]>('ai_runtime_detect');
    return Array.isArray(runtimes) ? runtimes : [];
  } catch {
    return [];
  }
}

/** 被 `.lattice/prompts` 覆盖的 Prompt 模板数量（W5；桌面专用，失败返回 0）。 */
export async function countOverriddenPrompts(): Promise<number> {
  if (!isTauri()) return 0;
  try {
    const list = await invoke<Array<{ overridden?: boolean }>>('ai_prompts_list');
    return Array.isArray(list) ? list.filter((item) => item?.overridden === true).length : 0;
  } catch {
    return 0;
  }
}
