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
