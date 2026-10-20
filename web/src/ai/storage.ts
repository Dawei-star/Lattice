/**
 * Keep browser-side AI state isolated between vaults without putting raw
 * filesystem paths into storage keys.
 */
export function aiStorageNamespace(identity?: string | null): string {
  const value = String(identity ?? '').trim() || 'default';
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `ns-${(hash >>> 0).toString(16)}`;
}

export function aiStorageKey(base: string, identity?: string | null): string {
  return `${base}:${aiStorageNamespace(identity)}`;
}
