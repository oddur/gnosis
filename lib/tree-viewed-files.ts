/** Input already obeys file-type and Viewed filters; search comes from Pierre's matcher. */
export function treeViewedFiles<T extends { key: string }>(
  entries: readonly T[],
  item: { kind: 'file' | 'directory'; path: string },
  matchingPaths?: ReadonlySet<string>
): T[] {
  const prefix = item.path.endsWith('/') ? item.path : `${item.path}/`;
  return entries.filter(
    (entry) =>
      (item.kind === 'directory' ? entry.key.startsWith(prefix) : entry.key === item.path) &&
      (!matchingPaths || matchingPaths.has(entry.key))
  );
}

/** A folder and its selected descendants contribute each matching file only once. */
export function selectedTreeFiles<T extends { key: string }>(
  entries: readonly T[],
  selectedPaths: readonly string[],
  matchingPaths?: ReadonlySet<string>
): T[] {
  const selected = new Set(selectedPaths);
  const directories = selectedPaths.filter(path => path.endsWith('/'));
  return entries.filter(entry => (!matchingPaths || matchingPaths.has(entry.key)) &&
    (selected.has(entry.key) || directories.some(path => entry.key.startsWith(path))));
}
