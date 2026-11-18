/**
 * "+N lines since your review" on the Overview's morning page (#390): one compare read per re-review PR, from the
 * commit you last reviewed to the PR's head. Both ends are commits, so an answer never changes and is cached for good.
 */
export interface RereviewTarget {
  url: string;
  /** The commit your latest review was on. */
  from: string;
  /** The PR's head now. */
  to: string;
}
export interface RereviewLines extends RereviewTarget {
  /** Lines added and removed between the two commits, in every file GitHub lists. */
  lines: number;
  files: number;
}
/** Re-review reads one request asks for, at most. */
export const REREVIEW_LIMIT = 10;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/;
const SHA = /^[0-9a-f]{7,64}$/i;

export const rereviewCacheKey = (target: RereviewTarget) => `rereview-lines:v1:${target.url}:${target.from}:${target.to}`;

/** Validates targets that crossed IPC. Undefined when the request is malformed. */
export function parseRereviewTargets(value: unknown): RereviewTarget[] | undefined {
  if (!Array.isArray(value) || value.length > REREVIEW_LIMIT) return undefined;
  const targets: RereviewTarget[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined;
    const { url, from, to } = entry as Record<string, unknown>;
    if (typeof url !== 'string' || !PR_URL.test(url) || typeof from !== 'string' || !SHA.test(from) || typeof to !== 'string' || !SHA.test(to)) return undefined;
    targets.push({ url, from, to });
  }
  return targets;
}
/** The compare request for one target: `GET /repos/{owner}/{repo}/compare/{from}...{to}`, one commit per page. */
export function rereviewCompare(target: RereviewTarget): { owner: string; repo: string; basehead: string; per_page: number } {
  const match = PR_URL.exec(target.url);
  if (!match) throw new Error('Choose a valid GitHub pull request.');
  return { owner: match[1], repo: match[2], basehead: `${target.from}...${target.to}`, per_page: 1 };
}
/** Lines and files from a compare answer's file list. */
export function rereviewSize(target: RereviewTarget, files: readonly { additions?: number; deletions?: number }[] | undefined): RereviewLines {
  const list = files ?? [];
  return { ...target, lines: list.reduce((total, file) => total + (file.additions ?? 0) + (file.deletions ?? 0), 0), files: list.length };
}
export function isRereviewLines(value: unknown): value is RereviewLines {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.url === 'string' && typeof entry.from === 'string' && typeof entry.to === 'string' && typeof entry.lines === 'number' && typeof entry.files === 'number';
}
