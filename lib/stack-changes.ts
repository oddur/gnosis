import type { ReviewSubject, ReviewMember } from './workbench';
import type { PrChanges, PrChangeFile } from './pr-changes';
import type { PrMetadata } from './types';
import type { GitHubReviewThread, GitHubReviewThreads } from './review-threads';

export interface StackComparison {
  key: string;
  subjectId: string;
  members: { metadata: PrMetadata; comparisonBase: string }[];
  fileSources: Partial<Record<string, string[]>>;
  fileSourcePaths?: Partial<Record<string, Record<string, string>>>;
}

/** A connected group is not necessarily a comparable stack. Never invent a tip. */
export function linearStack(subject: ReviewSubject): ReviewMember[] {
  if (subject.kind !== 'stack' || subject.members.length < 2)
    throw new Error('Combined changes require at least two PRs in a stack.');
  const byUrl = new Map(subject.members.map((m) => [m.url, m]));
  const children = new Map<string, string>(),
    parents = new Map<string, string>();
  for (const edge of subject.edges) {
    if (!byUrl.has(edge.parent) || !byUrl.has(edge.child))
      throw new Error('The stack has missing PRs. Review by PR until its full dependency chain is available.');
    if (children.has(edge.parent) || parents.has(edge.child))
      throw new Error('This stack branches into multiple paths. Review by PR to inspect every path.');
    children.set(edge.parent, edge.child);
    parents.set(edge.child, edge.parent);
  }
  const roots = subject.members.filter((m) => !parents.has(m.url));
  if (roots.length !== 1) throw new Error('This stack has no single base-to-tip chain. Review by PR.');
  const ordered: ReviewMember[] = [];
  let member: ReviewMember | undefined = roots[0];
  while (member && !ordered.includes(member)) {
    ordered.push(member);
    member = byUrl.get(children.get(member.url) ?? '');
  }
  if (member || ordered.length !== subject.members.length)
    throw new Error('This stack has no single base-to-tip chain. Review by PR.');
  const repo = ordered[0].baseRepo;
  if (!repo || ordered.some((m) => m.baseRepo !== repo || m.headRepo !== repo))
    throw new Error(
      'Combined changes currently require all branches in the same repository. Review by PR for this stack.'
    );
  return ordered;
}

export function stackRevisionKey(subject: ReviewSubject) {
  return JSON.stringify([
    subject.id,
    subject.members
      .map((m) => [m.url, m.baseRepo, m.baseBranch, m.baseSha, m.headRepo, m.headBranch, m.headSha])
      .sort((a, b) => a[0].localeCompare(b[0])),
    subject.edges.map((e) => [e.parent, e.child]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
}
export const stackFileProgressKey = (snapshot: PrChanges, file: PrChangeFile) =>
  `stack:${JSON.stringify([snapshot.stackComparison?.subjectId, snapshot.url, file.path, file.changeId])}`;

/** Map only coordinates whose immutable source side is exactly the displayed side. */
export function combinedThreadIsInline(
  snapshot: PrChanges,
  file: PrChangeFile,
  source: StackComparison['members'][number],
  data: GitHubReviewThreads,
  thread: GitHubReviewThread
) {
  if (
    thread.isOutdated ||
    thread.line === null ||
    data.headSha !== source.metadata.headSha ||
    data.baseSha !== source.metadata.baseSha
  )
    return false;
  return thread.diffSide === 'RIGHT'
    ? source.metadata.headSha === snapshot.metadata.headSha && thread.path === file.path
    : source.comparisonBase === snapshot.comparisonBase && thread.path === (file.previousPath ?? file.path);
}

/** Follow each file backwards through renames; stop at its creation rather than a reused path. */
export function stackFileSources(path: string, snapshots: PrChanges[]) {
  let current = path;
  const found: { url: string; path: string }[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    const file = snapshot.files.find((f) => f.path === current);
    if (!file) continue;
    found.push({ url: snapshot.url, path: file.path });
    if (file.status === 'added') break;
    if (file.previousPath) current = file.previousPath;
  }
  return found.reverse();
}
