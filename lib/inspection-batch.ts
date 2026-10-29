/** Publish independent members as they finish, with bounded concurrency. */
export async function loadInspectionBatch<T, V>(
  members: T[],
  read: (member: T, signal: AbortSignal) => Promise<V>,
  receive: (member: T, result: { value: V } | { error: unknown }) => void,
  signal: AbortSignal,
  concurrency = 3
) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, members.length) }, async () => {
      while (!signal.aborted && cursor < members.length) {
        const member = members[cursor++];
        try {
          const value = await read(member, signal);
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancellation can occur during the awaited read
          if (!signal.aborted) receive(member, { value });
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancellation can occur during the awaited read
          if (!signal.aborted) receive(member, { error });
        }
      }
    })
  );
}

export interface InspectionFailure {
  url: string;
  message: string;
  retryAt?: number;
}
export function inspectionFailure(url: string, error: unknown): InspectionFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const date = /(?:Try again after|requests can resume after) (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(detail)?.[1];
  const retryAt = date ? Date.parse(date) : undefined;
  const message = /HTTP 50[0234]/.test(detail)
    ? 'GitHub is temporarily unable to load this PR.'
    : /too long|timeout|timed out/i.test(detail)
      ? 'GitHub took too long to respond.'
      : /rate.?limit|allowance|requests can resume/i.test(detail)
        ? 'GitHub’s API allowance is temporarily unavailable.'
        : detail.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  return { url, message, retryAt: Number.isFinite(retryAt) ? retryAt : undefined };
}
