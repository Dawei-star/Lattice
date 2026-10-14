import type { NoteSummary } from '../api/resources.ts';

/** 保存结果会覆盖到列表项上的字段集合。 */
export type MergeableNoteField = 'title' | 'folderId' | 'filePath' | 'updatedAt' | 'isPinned' | 'wordCount' | 'properties';

/** mergeSavedNoteIntoCollection 的 saved 参数形状（笔记详情/索引行的最小投影）。 */
export type MergeableNote = { id?: string } & Partial<Pick<NoteSummary, MergeableNoteField>>;

/** Apply the fields returned by a note mutation to a lightweight note list item. */
export function mergeSavedNoteIntoCollection<T extends { id: string }>(items: T[], saved: MergeableNote): T[] {
  if (!saved?.id) return items;
  const fields: MergeableNoteField[] = ['title', 'folderId', 'filePath', 'updatedAt', 'isPinned', 'wordCount', 'properties'];
  return items.map((item) => (
    item.id === saved.id
      ? fields.reduce((next, field) => {
          if (saved[field] !== undefined) (next as unknown as Record<string, unknown>)[field] = saved[field];
          return next;
        }, { ...item })
      : item
  ));
}
