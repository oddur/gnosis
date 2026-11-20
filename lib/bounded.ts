/**
 * `fn` over every item, at most `limit` at a time. Results keep the order of `items`. After the first failure no new
 * item starts; the call waits for the items already running, then rejects with that first failure, so no work is
 * left running unobserved.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (!failure && cursor < items.length) {
        const index = cursor++;
        try {
          results[index] = await fn(items[index], index);
        } catch (error) {
          failure ??= { error };
        }
      }
    })
  );
  if (failure) throw failure.error;
  return results;
}

/** `items` in consecutive slices of at most `size`. */
export const chunked = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
