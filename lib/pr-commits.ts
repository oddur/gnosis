import type { PrMetadata } from './types';
import type { ReviewSubject } from './workbench';
export interface PrCommit {
  sha: string;
  message: string;
  author: { name: string; login?: string; avatarUrl?: string };
  authoredAt: string;
  committer: string;
  committedAt: string;
  parents: string[];
  url: string;
  verified: boolean;
}
export interface PrCommits {
  version: 1;
  url: string;
  metadata: PrMetadata;
  commits: PrCommit[]; // GitHub's chronological order, independent of display sorting/filtering.
  fetchedAt: number;
}
export interface CommitSelection {
  url: string;
  prHeadSha: string;
  prBaseSha: string;
  firstSha: string;
  lastSha: string;
  parentSha?: string;
}
export const commitSelectionKey = (s: CommitSelection) =>
  JSON.stringify([s.url, s.prBaseSha, s.prHeadSha, s.firstSha, s.lastSha, s.parentSha ?? '']);

/** Remove only identical SHAs already represented by an ancestor PR, never sibling work. */
export function ownedCommits(subject: ReviewSubject, lists: PrCommits[]) {
  const byUrl = new Map(lists.map((list) => [list.url, list]));
  return subject.members.map((member) => {
    const ancestors = new Set<string>();
    const visit = (url: string) => {
      for (const edge of subject.edges.filter((e) => e.child === url)) {
        if (ancestors.has(edge.parent) || edge.parent === member.url) continue;
        ancestors.add(edge.parent);
        visit(edge.parent);
      }
    };
    visit(member.url);
    const inherited = new Set([...ancestors].flatMap((url) => byUrl.get(url)?.commits.map((c) => c.sha) ?? []));
    const list = byUrl.get(member.url);
    return {
      member,
      list,
      commits: list?.commits.filter((c) => !inherited.has(c.sha)) ?? [],
      omitted: list?.commits.filter((c) => inherited.has(c.sha)).length ?? 0,
    };
  });
}
export function selectedCommits(list: PrCommits, selection: CommitSelection) {
  if (
    list.url !== selection.url ||
    list.metadata.headSha !== selection.prHeadSha ||
    list.metadata.baseSha !== selection.prBaseSha
  )
    throw new Error('Reload the commit list before choosing this comparison.');
  const first = list.commits.findIndex((c) => c.sha === selection.firstSha),
    last = list.commits.findIndex((c) => c.sha === selection.lastSha);
  if (first < 0 || last < first) throw new Error('Choose a consecutive range from one PR.');
  const commits = list.commits.slice(first, last + 1);
  if (selection.parentSha && !commits[0].parents.includes(selection.parentSha))
    throw new Error('Choose a parent of the first selected commit.');
  return commits;
}
