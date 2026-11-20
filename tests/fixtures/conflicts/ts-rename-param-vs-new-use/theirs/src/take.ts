export function take<T>(items: T[], count: number) {
  if (count <= 0) return [];
  return items.slice(0, count);
}
