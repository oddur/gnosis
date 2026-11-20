import type { Octokit } from '@octokit/rest';
import type {
  MergeMethod,
  PrActionMember,
  PrActionRequest,
  PrActionResult,
  PrActionState,
  PrMergePlan,
} from '../lib/pr-actions';
import { chunked, mapBounded, settleInOrder } from '../lib/bounded';
import { githubRateLimit } from '../lib/github-client';
import { aliasedGraphql } from '../lib/github-graphql-batch';
import { singleMergePlan, draftActionBlockedReason, branchUpdateBlockedReason, closeBlockedReason } from '../lib/pr-actions';

const METHODS: MergeMethod[] = ['MERGE', 'SQUASH', 'REBASE'];
const memberFields =
  'url number title headRefName headRefOid baseRefName baseRefOid baseRef{target{oid}} state isDraft';
interface GraphMember {
  url: string;
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  baseRef: { target: { oid: string } } | null;
  state: string;
  isDraft: boolean;
}
interface GraphPr extends GraphMember {
  id: string;
  headRepository: { nameWithOwner: string; viewerPermission?: string | null } | null;
  maintainerCanModify?: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision?: string | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  viewerCanEnableAutoMerge: boolean;
  viewerCanDisableAutoMerge: boolean;
  viewerCanUpdateBranch: boolean;
  viewerDidAuthor: boolean;
  autoMergeRequest: { mergeMethod: MergeMethod } | null;
  mergeQueue: { id: string } | null;
  isInMergeQueue: boolean;
  stack: null | {
    number: number;
    baseRefName: string;
    entries: {
      totalCount: number;
      nodes: { position: number; pullRequest: (GraphMember & { mergeQueue: { id: string } | null }) | null }[];
    };
  };
}
interface GraphRepo {
  nameWithOwner: string;
  isArchived: boolean;
  viewerPermission: string | null;
  viewerDefaultMergeMethod: MergeMethod;
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  pullRequest: GraphPr | null;
}
/** Pull requests per aliased stack query, small enough to answer well within GitHub's time limit. */
const PRS_PER_QUERY = 20;
const repoFields =
  'nameWithOwner isArchived viewerPermission viewerDefaultMergeMethod mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed';
const prFields = `${memberFields} id headRepository{nameWithOwner viewerPermission} maintainerCanModify mergeable mergeStateStatus reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}
        viewerCanEnableAutoMerge viewerCanDisableAutoMerge viewerCanUpdateBranch viewerDidAuthor autoMergeRequest{mergeMethod} mergeQueue{id} isInMergeQueue
        stack{number baseRefName entries(first:100){totalCount nodes{position pullRequest{${memberFields} mergeQueue{id}}}}}`;
const writePermissions = ['WRITE', 'MAINTAIN', 'ADMIN'];
export function prActionTarget(url: string) {
  const m = typeof url === 'string' && /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(url);
  if (!m || !Number.isSafeInteger(Number(m[3]))) throw new Error('Choose a valid GitHub pull request.');
  return { owner: m[1], repo: m[2], pull_number: Number(m[3]) };
}
const member = (pr: GraphMember): PrActionMember => ({
  url: pr.url,
  number: pr.number,
  title: pr.title,
  headBranch: pr.headRefName,
  headSha: pr.headRefOid,
  // baseRefOid is the PR's historical base snapshot, not necessarily the current branch tip.
  baseSha: pr.baseRef?.target.oid ?? '',
  baseBranch: pr.baseRefName,
  state: pr.state,
  isDraft: pr.isDraft,
});
function normalize(repo: GraphRepo, checkedAt: number, account: string): PrActionState {
  const pr = repo.pullRequest;
  if (!pr) throw new Error('GitHub could not find this PR. Check your repository access.');
  const methods = METHODS.filter((m) =>
    m === 'MERGE' ? repo.mergeCommitAllowed : m === 'SQUASH' ? repo.squashMergeAllowed : repo.rebaseMergeAllowed
  );
  const entries = pr.stack?.entries.nodes.filter((e) => e.pullRequest).sort((a, b) => a.position - b.position) ?? [];
  return {
    ...member(pr),
    id: pr.id,
    account,
    checkedAt,
    headRepo: pr.headRepository?.nameWithOwner ?? null,
    ...(pr.headRepository && pr.headRepository.viewerPermission !== undefined
      ? { headRepoCanWrite: writePermissions.includes(pr.headRepository.viewerPermission ?? '') }
      : {}),
    ...(pr.maintainerCanModify !== undefined ? { maintainerCanModify: pr.maintainerCanModify } : {}),
    repository: repo.nameWithOwner,
    archived: repo.isArchived,
    canWrite: writePermissions.includes(repo.viewerPermission ?? ''),
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    checkState: pr.commits ? (pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null) : undefined,
    methods,
    defaultMethod: methods.includes(repo.viewerDefaultMergeMethod)
      ? repo.viewerDefaultMergeMethod
      : (methods[0] ?? 'SQUASH'),
    autoMerge: pr.autoMergeRequest?.mergeMethod ?? null,
    canEnableAuto: pr.viewerCanEnableAutoMerge,
    canDisableAuto: pr.viewerCanDisableAutoMerge,
    canUpdateBranch: pr.viewerCanUpdateBranch,
    canChangeDraft: pr.viewerDidAuthor || writePermissions.includes(repo.viewerPermission ?? ''),
    mergeQueue: !!pr.mergeQueue,
    inMergeQueue: pr.isInMergeQueue,
    stack: pr.stack
      ? {
          number: pr.stack.number,
          baseBranch: pr.stack.baseRefName,
          complete: entries.length === pr.stack.entries.totalCount,
          members: entries.flatMap((e) => (e.pullRequest ? [member(e.pullRequest)] : [])),
          mergeQueue: !!entries[0]?.pullRequest?.mergeQueue,
        }
      : null,
  };
}
export class PrMergeFailure extends Error {}
interface AsyncMergeResponse {
  status: 'pending' | 'merged' | 'enqueued' | 'failed';
  details: { message?: string; uuid?: string };
}
function asyncResult(data: AsyncMergeResponse, url: string, members: string[]): PrActionResult {
  if (data.status === 'failed')
    throw new PrMergeFailure(data.details.message ?? 'GitHub could not merge this stack. Nothing was merged.');
  if (data.status === 'pending' && data.details.uuid)
    return {
      status: 'pending',
      message: 'GitHub is processing the merge. Follow its progress in Activity.',
      operation: { url, uuid: data.details.uuid, members },
    };
  if (data.status === 'merged') return { status: 'merged', message: 'Merged on GitHub.' };
  if (data.status === 'enqueued')
    return { status: 'enqueued', message: 'Added to GitHub’s merge queue. The PRs have not merged yet.' };
  throw new Error('GitHub returned an unrecognized merge result. Check the PR on GitHub before trying again.');
}
/** Permission-aware actions. Every write rechecks the confirmed revisions; writes are never replayed. */
export function createPrActionsService(now = Date.now) {
  const accounts = new WeakMap<
    Octokit,
    { cache: Map<string, PrActionState>; pending: Map<string, Promise<PrActionState>>; busy: Set<string> }
  >();
  const account = (client: Octokit) => {
    let a = accounts.get(client);
    if (!a) {
      a = { cache: new Map(), pending: new Map(), busy: new Set() };
      accounts.set(client, a);
    }
    return a;
  };
  async function read(client: Octokit, url: string, force = false): Promise<PrActionState> {
    const { owner, repo, pull_number } = prActionTarget(url),
      a = account(client),
      saved = a.cache.get(url);
    if (!force && saved && now() - saved.checkedAt < 25_000) return saved;
    const existing = a.pending.get(url);
    if (!force && existing) return existing;
    const request = readOne(client, owner, repo, pull_number, url).finally(() => {
      if (a.pending.get(url) === request) a.pending.delete(url);
    });
    a.pending.set(url, request);
    return request;
  }
  /** One PR's state from its own query, saved in the capability cache. No coalescing; `read` adds that. */
  async function readOne(client: Octokit, owner: string, repo: string, number: number, url: string): Promise<PrActionState> {
    const data = await client.graphql<{ viewer: { login: string }; repository: GraphRepo | null }>(
      `query($owner:String!,$repo:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$repo){
      ${repoFields}
      pullRequest(number:$number){ ${prFields}
      }}}`,
      { owner, repo, number }
    );
    if (!data.repository) throw new Error('GitHub could not grant access to this repository.');
    const state = normalize(data.repository, now(), data.viewer.login);
    account(client).cache.set(url, state);
    return state;
  }
  /**
   * `read` for many PRs. The PRs of one repository share one aliased query (up to 50 each), so the repository settings
   * are read once. Each URL gets its own promise, which fails alone when its PR is missing. Cached and pending reads are
   * reused as in `read`.
   */
  function readMany(client: Octokit, urls: string[], force = false): Promise<PrActionState>[] {
    if (urls.length <= 1) return urls.map((url) => read(client, url, force));
    const a = account(client),
      reads = new Map<string, Promise<PrActionState>>(),
      groups = new Map<string, { owner: string; repo: string; members: { url: string; number: number }[] }>();
    for (const url of new Set(urls)) {
      let target: ReturnType<typeof prActionTarget>;
      try {
        target = prActionTarget(url);
      } catch (error) {
        reads.set(url, Promise.reject(error as Error));
        continue;
      }
      const saved = a.cache.get(url),
        existing = a.pending.get(url);
      if (!force && saved && now() - saved.checkedAt < 25_000) reads.set(url, Promise.resolve(saved));
      else if (!force && existing) reads.set(url, existing);
      else {
        const key = `${target.owner}/${target.repo}`.toLowerCase();
        const group = groups.get(key) ?? { owner: target.owner, repo: target.repo, members: [] };
        group.members.push({ url, number: target.pull_number });
        groups.set(key, group);
      }
    }
    for (const { owner, repo, members } of groups.values())
      for (const batch of chunked(members, PRS_PER_QUERY)) {
        type Data = { viewer: { login: string }; repository: (Omit<GraphRepo, 'pullRequest'> & Record<string, unknown>) | null };
        // A PR whose alias errored fails alone; the repository failing fails them all.
        const response = aliasedGraphql<Data>(
          client,
          `query($owner:String!,$repo:String!){viewer{login} repository(owner:$owner,name:$repo){
      ${repoFields}
      ${batch.map((m, j) => `p${j}: pullRequest(number:${m.number}){ ${prFields} }`).join('\n      ')}
      }}`,
          { owner, repo }
        );
        // A query that failed without saying where (a timeout, a server error) reads each member by itself, 3 at a time,
        // so one bad answer never fails the whole stack. A rate limit is not retried.
        const retried = response.then(
          () => undefined,
          (error: unknown) =>
            githubRateLimit(error)
              ? undefined
              : mapBounded(batch, 3, (m) =>
                  readOne(client, owner, repo, m.number, m.url).then(
                    (state) => ({ state }),
                    (failure: unknown) => ({ failure })
                  )
                )
        );
        const checked = response.then((answer) => {
          const repository = answer.data.repository;
          // An error anywhere but under one PR's alias leaves no member's state sound.
          const shared = answer.errorPaths.find((path) => !(path[0] === 'repository' && /^p\d+$/.test(String(path[1]))));
          if (shared) throw answer.error(...shared) ?? new Error('GitHub could not read this repository.');
          if (!repository) throw new Error('GitHub could not grant access to this repository.');
          return { login: answer.data.viewer.login, repository, answer };
        });
        for (const [j, { url }] of batch.entries()) {
          const request = checked
            .catch(async (error: unknown) => {
              const retry = (await retried)?.[j];
              if (!retry) throw error;
              if ('failure' in retry) throw retry.failure;
              return { retried: retry.state };
            })
            .then((read) => {
              if ('retried' in read) return read.retried;
              const { login, repository, answer } = read;
              const failed = answer.error('repository', `p${j}`);
              if (failed) throw failed;
              const state = normalize(
                { ...repository, pullRequest: (repository[`p${j}`] as GraphPr | null | undefined) ?? null } as GraphRepo,
                now(),
                login
              );
              a.cache.set(url, state);
              return state;
            })
            .finally(() => {
              if (a.pending.get(url) === request) a.pending.delete(url);
            });
          a.pending.set(url, request);
          reads.set(url, request);
        }
      }
    return urls.map((url) => reads.get(url) as Promise<PrActionState>);
  }
  async function stackPlan(client: Octokit, urls: string[], force = false): Promise<PrMergePlan> {
    if (!Array.isArray(urls) || urls.length < 2 || urls.length > 100 || new Set(urls).size !== urls.length)
      throw new Error('Choose a stack of 2–100 distinct PRs.');
    urls.forEach(prActionTarget);
    // User-initiated only. One query per repository through the shared scheduler, with a short capability cache.
    const states = await settleInOrder(readMany(client, urls, force));
    const target = states[states.length - 1];
    const native = target.stack;
    const openNative = native?.members.filter((m) => m.state !== 'MERGED');
    let blockedReason: string | undefined;
    if (states.some((s) => s.repository !== target.repository || s.headRepo !== target.repository))
      blockedReason = 'Whole-stack merging requires branches in the same repository.';
    else if (states.some((s) => s.archived || !s.canWrite || s.state !== 'OPEN' || s.isDraft || s.inMergeQueue))
      blockedReason = 'Every PR must be open, ready for review, and writable, and not already queued.';
    else if (native && (!native.complete || JSON.stringify(openNative?.map((m) => m.url)) !== JSON.stringify(urls)))
      blockedReason =
        'This view does not contain the complete GitHub stack in dependency order. Open the complete stack before merging.';
    else if (!native && states.some((s) => s.stack)) blockedReason = 'These PRs belong to different GitHub stacks.';
    else if (states.some((s, i) => i > 0 && s.baseBranch !== states[i - 1].headBranch))
      blockedReason = 'Whole-stack merging requires a linear chain of branches. Merge these PRs individually.';
    else if (states.some((s) => s.mergeable === 'CONFLICTING'))
      blockedReason = 'Resolve the stack’s merge conflicts first.';
    const methods = target.methods.filter((m) => states.every((s) => s.methods.includes(m)));
    return {
      target,
      members: states,
      baseBranch: native?.baseBranch ?? states[0].baseBranch,
      methods,
      mergeQueue: native?.mergeQueue ?? states[0].mergeQueue,
      createStack: !native,
      blockedReason,
    };
  }
  async function act(client: Octokit, req: PrActionRequest): Promise<PrActionResult> {
    const a = account(client);
    prActionTarget(req.url);
    if (
      ![
        'merge',
        'enable-auto',
        'disable-auto',
        'update-merge',
        'update-rebase',
        'mark-ready',
        'convert-draft',
        'close',
      ].includes(req.kind)
    )
      throw new Error('Unknown PR action.');
    if (!Array.isArray(req.revisions) || !req.revisions.length || req.revisions.length > 100)
      throw new Error('Confirm the PR revisions before continuing.');
    const urls = req.revisions.map((r) => r.url);
    urls.forEach(prActionTarget);
    if (new Set(urls).size !== urls.length || !urls.includes(req.url)) throw new Error('Invalid PR action targets.');
    if (urls.some((url) => a.busy.has(url))) throw new Error('An action for this PR is already in progress.');
    urls.forEach((url) => a.busy.add(url));
    try {
      if (req.commitTitle !== undefined && (typeof req.commitTitle !== 'string' || req.commitTitle.length > 256))
        throw new Error('Use a commit title of at most 256 characters.');
      if (req.commitBody !== undefined && (typeof req.commitBody !== 'string' || req.commitBody.length > 65536))
        throw new Error('Use a commit message of at most 65,536 characters.');
      if (req.comment !== undefined && (req.kind !== 'close' || typeof req.comment !== 'string' || req.comment.length > 65000))
        throw new Error('Use a comment of at most 65,000 characters.');
      // Creating a stack reads every member, the target included, in one forced read; nothing else needs the members.
      const stacked = req.kind === 'merge' && req.createStack ? await stackPlan(client, urls, true) : undefined;
      const state = stacked?.members.find((m): m is PrActionState => m.url === req.url) ?? (await read(client, req.url, true));
      if (req.account !== state.account)
        throw new Error('The GitHub account changed. Reopen this action before continuing.');
      const plan = stacked ?? singleMergePlan(state);
      const affected = req.kind === 'merge' ? plan.members : [state];
      if (
        affected.length !== req.revisions.length ||
        affected.some((m, i) => {
          const r = req.revisions[i];
          return r.url !== m.url || r.headSha !== m.headSha || r.baseSha !== m.baseSha || r.baseBranch !== m.baseBranch;
        })
      )
        throw new Error(
          'This PR or stack changed since confirmation. Refresh the action and inspect the new revisions before continuing.'
        );
      if (state.archived || state.state !== 'OPEN')
        throw new Error('This PR is no longer open in an active repository.');
      if (req.kind === 'merge' && plan.blockedReason) throw new Error(plan.blockedReason);
      if ((req.kind === 'merge' && !plan.mergeQueue) || req.kind === 'enable-auto') {
        if (!req.method || !plan.methods.includes(req.method))
          throw new Error('Choose a merge method allowed by this repository.');
      }
      const input = { pullRequestId: state.id, expectedHeadOid: state.headSha };
      const message = {
        ...(req.commitTitle?.trim() ? { commitHeadline: req.commitTitle.trim() } : {}),
        ...(req.commitBody?.trim() ? { commitBody: req.commitBody.trim() } : {}),
      };
      if (req.kind === 'merge') {
        if (plan.createStack) {
          if (req.createStack !== true) throw new Error('Confirm creating a GitHub stack before merging.');
          const target = prActionTarget(req.url);
          await client.request('POST /repos/{owner}/{repo}/stacks', {
            owner: target.owner,
            repo: target.repo,
            pull_requests: plan.members.map((m) => m.number),
          });
          // Creation is a distinct write. Revalidate GitHub’s actual membership before submitting a merge.
          const registered = await read(client, req.url, true),
            confirmed = singleMergePlan(registered);
          if (
            !registered.stack ||
            !registered.stack.complete ||
            registered.account !== req.account ||
            confirmed.blockedReason ||
            confirmed.baseBranch !== plan.baseBranch ||
            confirmed.mergeQueue !== plan.mergeQueue ||
            (!confirmed.mergeQueue && (!req.method || !confirmed.methods.includes(req.method))) ||
            confirmed.members.length !== req.revisions.length ||
            confirmed.members.some(
              (m, i) =>
                m.url !== req.revisions[i].url ||
                m.headSha !== req.revisions[i].headSha ||
                m.baseSha !== req.revisions[i].baseSha ||
                m.baseBranch !== req.revisions[i].baseBranch
            )
          )
            throw new Error(
              'The GitHub stack was created, but its revisions or merge requirements changed. Inspect it before requesting a merge.'
            );
        }
        if (state.stack || plan.createStack) {
          const target = prActionTarget(req.url);
          try {
            const response = await client.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async', {
              ...target,
              sha: state.headSha,
              merge_action: plan.mergeQueue ? 'merge_queue' : 'direct_merge',
              ...(!plan.mergeQueue
                ? {
                    merge_method: req.method?.toLowerCase(),
                    commit_title: req.commitTitle?.trim() || undefined,
                    commit_message: req.commitBody?.trim() || undefined,
                  }
                : {}),
            });
            return asyncResult(response.data as AsyncMergeResponse, req.url, urls);
          } catch (error) {
            if ((error as { status?: number }).status === 409)
              throw new Error(
                'GitHub already has a merge request for this stack, possibly with different options. Check its status on GitHub; no second request was sent.'
              );
            if ((error as { status?: number }).status === 404)
              throw new Error(
                'GitHub’s atomic stack merge is unavailable for this repository. Open the stack on GitHub.'
              );
            throw error;
          }
        }
        if (plan.mergeQueue) {
          await client.graphql(
            'mutation($input:EnqueuePullRequestInput!){enqueuePullRequest(input:$input){mergeQueueEntry{id}}}',
            { input }
          );
          return { status: 'enqueued', message: 'Added to GitHub’s merge queue. It has not merged yet.' };
        }
        const merged = await client.graphql<{ mergePullRequest: { pullRequest: { merged: boolean } | null } | null }>(
          'mutation($input:MergePullRequestInput!){mergePullRequest(input:$input){pullRequest{merged}}}',
          { input: { ...input, mergeMethod: req.method, ...message } }
        );
        if (!merged.mergePullRequest?.pullRequest?.merged)
          throw new Error(
            'GitHub did not confirm that this PR merged. Check its status on GitHub before trying again.'
          );
        return { status: 'merged', message: 'Merged on GitHub.' };
      }
      if (req.kind === 'close') {
        const reason = closeBlockedReason(state);
        if (reason) throw new Error(reason);
        const comment = req.comment?.trim();
        if (comment) {
          const target = prActionTarget(req.url);
          await client.issues.createComment({ owner: target.owner, repo: target.repo, issue_number: target.pull_number, body: comment });
        }
        let closed: { closePullRequest: { pullRequest: { state: string } | null } | null };
        try {
          closed = await client.graphql<typeof closed>(
            'mutation($input:ClosePullRequestInput!){closePullRequest(input:$input){pullRequest{state}}}',
            { input: { pullRequestId: state.id } }
          );
        } catch (error) {
          if (comment) throw new Error(`Your comment was posted, but GitHub did not close the PR: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        if (closed.closePullRequest?.pullRequest?.state !== 'CLOSED')
          throw new Error('GitHub did not confirm that this PR closed. Check it on GitHub before trying again.');
        return { status: 'completed', message: `Closed #${state.number}. You can reopen it on GitHub.` };
      }
      if (req.kind === 'mark-ready' || req.kind === 'convert-draft') {
        const reason = draftActionBlockedReason(state, req.kind);
        if (reason) throw new Error(reason);
        // These mutations accept only the PR ID; revision/account checks happen above.
        const draft = req.kind === 'convert-draft';
        const field = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
        const inputType = draft ? 'ConvertPullRequestToDraftInput' : 'MarkPullRequestReadyForReviewInput';
        const response = await client.graphql<Record<string, { pullRequest: { isDraft: boolean } | null } | null>>(
          `mutation($input:${inputType}!){${field}(input:$input){pullRequest{isDraft}}}`,
          { input: { pullRequestId: state.id } }
        );
        if (response[field]?.pullRequest?.isDraft !== draft)
          throw new Error('GitHub did not confirm the draft status change. Refresh this PR before trying again.');
        return { status: 'completed', message: draft ? 'PR converted to draft.' : 'PR marked ready for review.' };
      }
      if (req.kind === 'enable-auto') {
        if (state.stack) throw new Error('GitHub does not support auto-merge for native stacked PRs.');
        if (!state.canEnableAuto) throw new Error('GitHub does not allow enabling auto-merge for this PR right now.');
        await client.graphql(
          'mutation($input:EnablePullRequestAutoMergeInput!){enablePullRequestAutoMerge(input:$input){pullRequest{id}}}',
          { input: { ...input, mergeMethod: req.method, ...message } }
        );
        return {
          status: 'completed',
          message: 'Auto-merge enabled. GitHub will merge this PR when its requirements are met.',
        };
      }
      if (req.kind === 'disable-auto') {
        if (!state.autoMerge || !state.canDisableAuto)
          throw new Error('Auto-merge is no longer enabled or you cannot disable it.');
        await client.graphql(
          'mutation($input:DisablePullRequestAutoMergeInput!){disablePullRequestAutoMerge(input:$input){pullRequest{id}}}',
          { input: { pullRequestId: state.id } }
        );
        return { status: 'completed', message: 'Auto-merge disabled.' };
      }
      const updateBlocked = branchUpdateBlockedReason(state);
      if (updateBlocked) throw new Error(updateBlocked);
      await client.graphql(
        'mutation($input:UpdatePullRequestBranchInput!){updatePullRequestBranch(input:$input){pullRequest{headRefOid}}}',
        { input: { ...input, updateMethod: req.kind === 'update-rebase' ? 'REBASE' : 'MERGE' } }
      );
      return { status: 'completed', message: 'Branch update requested. GitHub may rerun checks for the new revision.' };
    } finally {
      urls.forEach((url) => {
        a.busy.delete(url);
        a.cache.delete(url);
      });
    }
  }
  return {
    read,
    readMany,
    stackPlan,
    act,
    async poll(client: Octokit, operation: NonNullable<PrActionResult['operation']>) {
      const target = prActionTarget(operation.url);
      if (!/^[\w-]{1,100}$/.test(operation.uuid)) throw new Error('Invalid merge operation.');
      const response = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}', {
        ...target,
        uuid: operation.uuid,
        headers: { 'cache-control': 'no-cache' },
      });
      return asyncResult(response.data as AsyncMergeResponse, operation.url, operation.members);
    },
  };
}
