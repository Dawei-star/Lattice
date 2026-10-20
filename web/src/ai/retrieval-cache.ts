import type { AiPermissionContext } from './contracts.ts';

export interface AiRetrievalCacheRequest {
  query: string;
  queries?: readonly string[];
  limit?: number;
  folderId?: string | null;
  inboxStatus?: string | null;
  allowedPaths: readonly string[];
  permissionContext: AiPermissionContext;
}

export interface AiRetrievalCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function stablePermissionContext(context: AiPermissionContext): AiPermissionContext {
  return {
    actor: String(context.actor),
    role: String(context.role),
    scopeId: String(context.scopeId),
    permissionVersion: String(context.permissionVersion),
    contentVersion: String(context.contentVersion),
  };
}

/**
 * The cache key deliberately includes the complete permission and content
 * identity. A path list alone is not enough because role or ACL versions can
 * change while the visible paths stay the same.
 */
export function buildAiRetrievalCacheKey(input: AiRetrievalCacheRequest): string {
  return JSON.stringify({
    query: String(input.query ?? '').trim(),
    queries: (input.queries ?? []).map((query) => String(query).trim()),
    limit: input.limit ?? null,
    folderId: input.folderId ?? null,
    inboxStatus: input.inboxStatus ?? null,
    allowedPaths: [...input.allowedPaths].map((path) => String(path)).sort(),
    permissionContext: stablePermissionContext(input.permissionContext),
  });
}

/** Short-lived, in-memory read cache with request coalescing. */
export function createAiRetrievalCache<T>(options: AiRetrievalCacheOptions = {}) {
  const ttlMs = Math.max(1, Math.floor(options.ttlMs ?? 30_000));
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 24));
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, CacheEntry<T>>();
  const pending = new Map<string, Promise<T>>();

  const removeExpired = () => {
    const timestamp = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
  };

  const get = (request: AiRetrievalCacheRequest): T | undefined => {
    removeExpired();
    const key = buildAiRetrievalCacheKey(request);
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };

  const set = (request: AiRetrievalCacheRequest, value: T): void => {
    removeExpired();
    const key = buildAiRetrievalCacheKey(request);
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
  };

  const run = async (request: AiRetrievalCacheRequest, loader: () => Promise<T>): Promise<T> => {
    const cached = get(request);
    if (cached !== undefined) return cached;
    const key = buildAiRetrievalCacheKey(request);
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const promise = loader().then((value) => {
      set(request, value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };

  return {
    get,
    set,
    run,
    clear: () => {
      entries.clear();
      pending.clear();
    },
    size: () => entries.size,
  };
}
