/** Return the first available default name among a folder's siblings. */
export function nextFolderName(siblings = []) {
  const usedNames = new Set(
    siblings
      .map((folder) => String(folder?.name ?? '').trim().toLocaleLowerCase())
      .filter(Boolean),
  );

  let name = '未命名';
  let suffix = 2;
  while (usedNames.has(name.toLocaleLowerCase())) {
    name = `未命名 ${suffix}`;
    suffix += 1;
  }
  return name;
}
