import { invoke, isTauri } from '@tauri-apps/api/core';

export interface NativeNoteFile {
  path: string;
  title: string;
  bytes: number;
  modifiedAt: number | null;
}

/** 检索命中：在笔记元数据之外附带命中上下文摘要。 */
export interface NativeSearchMatch extends NativeNoteFile {
  excerpt: string;
}

/** `vault_scan` 的增量同步统计。 */
export interface NativeScanSummary {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** 读取失败而跳过的文件（超限 / 非 UTF-8），不阻断整次扫描。 */
  skipped: number;
  total: number;
  durationMs: number;
}

export interface NativeIndexStats {
  notes: number;
  dbBytes: number;
}

export interface NativeNoteContents {
  path: string;
  raw: string;
  sha256: string;
}

export const nativeVault = {
  available: isTauri,
  info: () => invoke<{ path: string }>('vault_info'),
  open: (path: string) => invoke<{ path: string }>('vault_open', { path }),
  list: () => invoke<NativeNoteFile[]>('vault_list'),
  read: (path: string) => invoke<NativeNoteContents>('vault_read', { path }),
  readAsset: (path: string) => invoke<string>('vault_read_asset', { path }),
  write: (path: string, raw: string, expectedHash: string | null = null) =>
    invoke<NativeNoteContents>('vault_write', { path, raw, expectedHash }),
  search: (query: string, limit = 20) =>
    invoke<NativeSearchMatch[]>('vault_search', { query, limit }),
  /** 增量对齐文件系统与索引：未变化的文件不读盘。 */
  scan: () => invoke<NativeScanSummary>('vault_scan'),
  indexStats: () => invoke<NativeIndexStats>('vault_index_stats'),
};
