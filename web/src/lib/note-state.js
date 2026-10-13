/** Apply the fields returned by a note mutation to a lightweight note list item. */
export function mergeSavedNoteIntoCollection(items, saved) {
  if (!saved?.id) return items;
  return items.map((item) => (
    item.id === saved.id
      ? ['title', 'folderId', 'filePath', 'updatedAt', 'isPinned', 'wordCount', 'properties']
        .reduce((next, field) => {
          if (saved[field] !== undefined) next[field] = saved[field];
          return next;
        }, { ...item })
      : item
  ));
}
