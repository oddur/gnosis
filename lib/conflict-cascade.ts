/**
 * The cascade preview (#445 item 22): before you push a PR's conflict resolution, a dry run replays the PRs stacked on
 * it onto the merge commit you would push, in a private worktree, and says what each would need. Nothing is pushed and
 * no branch or ref changes. The preview is advisory: the restack after the push decides again, and asks for every
 * Reviewed tick its own rule asks for. Pure; no Node or Electron.
 */

/**
 * What the dry run found for one dependent PR:
 * - `clean`: replays without a conflict;
 * - `merged`: every conflict was Merged by the checks;
 * - `carried`: settled by your choices, carried over to the same conflicts or remembered;
 * - `conflicts`: the replay stops on `conflicts` new Check or Decide conflicts;
 * - `waiting`: above a PR that stops, so not replayed yet.
 */
export type CascadeOutcome = 'clean' | 'merged' | 'carried' | 'conflicts' | 'waiting';
export interface CascadePr {
  url: string;
  title: string;
  outcome: CascadeOutcome;
  /** New Check or Decide conflicts where the replay stopped (`conflicts` only). */
  conflicts?: number;
  /** Merge commits the replay recreated. A clean recreation can still lose what the original merge added. */
  merges: number;
  /** The restack would ask for this update's Reviewed tick, by its own rule (src/conflict-restack.ts). */
  review: boolean;
}
export interface CascadePreview {
  /** The draft version it was made from: a change to the draft makes it out of date. */
  version: number;
  /** The PR being resolved. */
  url: string;
  prs: CascadePr[];
}
/** What the renderer shows: running, waiting for power, the result, or why it couldn't run. */
export type CascadeState =
  | { state: 'checking' }
  | { state: 'battery' }
  | { state: 'ready'; preview: CascadePreview }
  | { state: 'failed'; message: string };

const number = (url: string) => `#${/\/pull\/(\d+)$/.exec(url)?.[1] ?? '?'}`;
function list(items: string[]) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "Resolving #101 also settles #102 and #103. #104 has 1 new conflict. #105 waits for #104." */
export function cascadeSentence(preview: CascadePreview): string {
  const settled = preview.prs.filter((pr) => pr.outcome === 'clean' || pr.outcome === 'merged' || pr.outcome === 'carried');
  const stopped = preview.prs.find((pr) => pr.outcome === 'conflicts');
  const waiting = preview.prs.filter((pr) => pr.outcome === 'waiting');
  const parts: string[] = [];
  if (settled.length) parts.push(`Resolving ${number(preview.url)} also settles ${list(settled.map((pr) => number(pr.url)))}.`);
  if (stopped) parts.push(`${number(stopped.url)} has ${plural(stopped.conflicts ?? 1, 'new conflict')}.`);
  if (stopped && waiting.length)
    parts.push(`${list(waiting.map((pr) => number(pr.url)))} ${waiting.length === 1 ? 'waits' : 'wait'} for ${number(stopped.url)}.`);
  return parts.join(' ');
}
/** One PR's line under the sentence, such as "#102 · Merged and checked". */
export function cascadePrLine(pr: CascadePr): string {
  const what =
    pr.outcome === 'clean'
      ? 'Replays cleanly'
      : pr.outcome === 'merged'
        ? 'Merged and checked'
        : pr.outcome === 'carried'
          ? 'Settled by your choices'
          : pr.outcome === 'conflicts'
            ? `${plural(pr.conflicts ?? 1, 'new conflict')} to check or decide`
            : 'Checked after the PR below it';
  const merges = pr.merges && pr.outcome !== 'waiting' ? ` · Recreates ${plural(pr.merges, 'merge commit')}` : '';
  const tick = pr.outcome === 'waiting' ? '' : pr.review ? ' · Needs your review' : ' · No review needed';
  return `${number(pr.url)} · ${what}${merges}${tick}`;
}
