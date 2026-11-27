/**
 * The ancestry read behind "Needs to move" for a PR that GitHub moved onto its merged parent's base, such as onto
 * main after the parent was squash-merged (#468). Such a PR no longer targets the parent's branch, so only its
 * commits tell whether it still carries the parent's: it does while its own commits (on its head, not on its base)
 * include the parent's last head commit. A parent merged with a merge commit put that commit on the base, so its
 * moved children carry nothing; a squash or rebase merge did not.
 *
 * One aliased GraphQL query reads up to 25 PRs' commit lists. An answer holds for the PR's head and base and the
 * parent's head it was read for, so the queue keeps it and reads again only when one of those changes. Fail closed:
 * a PR whose answer is missing, failed, from another head or base, or too long to list is never flagged.
 */
import type { Octokit } from '@octokit/rest';
import { chunked, mapBounded } from './bounded';
import { aliasedGraphql, type AliasedAnswer } from './github-graphql-batch';
import { parsePrUrl } from './github';
import { movedChildParent } from './stack-conflict-plan';
import type { ParentHeadInPr, ReviewMember, ReviewSubject } from './workbench';

/** One PR to check, and what the answer is for. */
export interface AncestryRequest extends ParentHeadInPr {
  url: string;
}
/** A saved answer. `contains` is null when GitHub listed too few of the PR's commits to tell. */
export interface AncestryAnswer extends ParentHeadInPr {
  contains: boolean | null;
}
/** Commits listed per PR. A PR with more, whose first 100 lack the parent's head, is left unknown. */
export const ANCESTRY_COMMITS = 100;
/** PRs per query: 25 lists of up to 100 commit ids. */
export const ANCESTRY_PER_QUERY = 25;

const sameRequest = (a: ParentHeadInPr, b: ParentHeadInPr) =>
  a.headSha === b.headSha && a.baseBranch === b.baseBranch && a.parentHeadSha === b.parentHeadSha;

/** Every open PR on its merged parent's base, with what an answer for it must match. One per PR. */
export function ancestryRequests(subjects: readonly Pick<ReviewSubject, 'members' | 'edges'>[]): AncestryRequest[] {
  const requests = new Map<string, AncestryRequest>();
  for (const subject of subjects)
    for (const member of subject.members) {
      const parent = movedChildParent(subject, member);
      if (parent && member.headSha && !requests.has(member.url))
        requests.set(member.url, { url: member.url, headSha: member.headSha, baseBranch: member.baseBranch, parentHeadSha: parent.headSha });
    }
  return [...requests.values()];
}

/** The requests without a saved answer for the same head, base and parent head. */
export function unanswered(requests: readonly AncestryRequest[], saved: Readonly<Record<string, AncestryAnswer>> | undefined) {
  return requests.filter((request) => {
    const answer = saved?.[request.url];
    return !answer || !sameRequest(answer, request);
  });
}

interface GraphCommits {
  headRefOid: string;
  baseRefName: string;
  commits: { totalCount: number; nodes: ({ commit: { oid: string } | null } | null)[] | null };
}

/**
 * Reads whether each PR's own commits include the parent's head, two queries at a time. Keyed by URL; a PR whose
 * answer GitHub did not give, or gave for another head or base, is left out. Rejects only when a whole query
 * fails, such as on a rate limit; the caller treats that as no answers.
 */
export async function readAncestry(octokit: Octokit, requests: readonly AncestryRequest[]): Promise<Map<string, AncestryAnswer>> {
  const answers = new Map<string, AncestryAnswer>();
  const targets = requests.flatMap((request) => {
    try {
      return [{ request, ...parsePrUrl(request.url) }];
    } catch {
      return [];
    }
  });
  await mapBounded(chunked(targets, ANCESTRY_PER_QUERY), 2, async (batch) => {
    const query = `query { ${batch
      .map(
        ({ owner, repo, pullNumber }, i) =>
          `a${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${pullNumber}) { headRefOid baseRefName commits(first:${ANCESTRY_COMMITS}) { totalCount nodes { commit { oid } } } } }`
      )
      .join('\n')} }`;
    const answer: AliasedAnswer<Record<string, { pullRequest: GraphCommits | null } | null>> = await aliasedGraphql(octokit, query);
    for (const [i, { request }] of batch.entries()) {
      const alias = `a${i}`;
      const pr = answer.data[alias]?.pullRequest;
      if (!pr || answer.failed(alias) || !pr.commits.nodes) continue;
      if (pr.headRefOid !== request.headSha || pr.baseRefName !== request.baseBranch) continue;
      const oids = pr.commits.nodes.map((node) => node?.commit?.oid);
      const found = oids.includes(request.parentHeadSha);
      const complete = oids.length >= pr.commits.totalCount && oids.every(Boolean);
      const { headSha, baseBranch, parentHeadSha } = request;
      answers.set(request.url, { headSha, baseBranch, parentHeadSha, contains: found ? true : complete ? false : null });
    }
  });
  return answers;
}

/**
 * `member` with `parentHeadInPr` as the saved answer says: set when its commits carry the parent's head, for its
 * current head and base; removed otherwise. The same object when nothing changes, so unchanged members keep their
 * identity.
 */
export function withParentHead(member: ReviewMember, saved: Readonly<Record<string, AncestryAnswer>> | undefined): ReviewMember {
  const answer = saved?.[member.url];
  const carries = answer?.contains === true && answer.headSha === member.headSha && answer.baseBranch === member.baseBranch;
  if (!carries) {
    if (!member.parentHeadInPr) return member;
    const rest = { ...member };
    delete rest.parentHeadInPr;
    return rest;
  }
  const current = member.parentHeadInPr;
  if (current && sameRequest(current, answer)) return member;
  return { ...member, parentHeadInPr: { headSha: answer.headSha, baseBranch: answer.baseBranch, parentHeadSha: answer.parentHeadSha } };
}
