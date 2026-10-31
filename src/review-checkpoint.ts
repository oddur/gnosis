import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlannerOutput, WriterSlideOutput } from '../lib/types';
export const reviewFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Only unfinished generations are reused. Keys include account, exact input, model and instructions. */
export async function openReviewCheckpoint(directory: string, identity: unknown) {
  const file = path.join(directory, `${reviewFingerprint(identity)}.json`);
  let data: { plan?: PlannerOutput; slides: Record<string, WriterSlideOutput> } = { slides: {} };
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Partial<typeof data>;
    if (
      saved.plan &&
      Array.isArray(saved.plan.topics) &&
      saved.slides &&
      Object.values(saved.slides).every((slide) => typeof slide.narrative === 'string')
    )
      data = { plan: saved.plan, slides: saved.slides };
  } catch {
    /* Missing/corrupt checkpoints regenerate without affecting saved reviews. */
  }
  let writes = Promise.resolve();
  function save() {
    const json = JSON.stringify(data);
    writes = writes
      .catch(() => {})
      .then(async () => {
        await mkdir(directory, { recursive: true });
        const temporary = file + '.' + randomUUID();
        try {
          await writeFile(temporary, json, { mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
    return writes;
  }
  return {
    get plan() {
      return data.plan;
    },
    get: (key: string): WriterSlideOutput | undefined => data.slides[key],
    async setPlan(plan: PlannerOutput) {
      data.plan = plan;
      await save();
    },
    async set(key: string, slide: WriterSlideOutput) {
      data.slides[key] = slide;
      await save();
    },
    async clear() {
      await writes;
      await unlink(file).catch(() => {});
    },
  };
}

/** Drain every writer so successful topics finish saving before reporting partial failure. */
export async function collectReviewTopics<T>(topics: (() => Promise<T>)[], signal: AbortSignal): Promise<T[]> {
  const settled = await Promise.allSettled(topics.map((run) => run()));
  signal.throwIfAborted();
  const failures = settled.filter((result) => result.status === 'rejected');
  if (failures.length) {
    const first = failures[0].reason as unknown;
    throw Error(
      `${settled.length - failures.length} of ${settled.length} topics saved. Retry this explanation to reuse completed topics. ${first instanceof Error ? first.message : String(first)}`
    );
  }
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}
