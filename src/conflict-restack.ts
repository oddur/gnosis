import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONFLICT_FILE_LIMIT,
  hasConflictMarkers,
  type ConflictSession,
  type RestackPlan,
  type ConflictFile,
} from '../lib/conflict-resolution';
import type { PrActionState } from '../lib/pr-actions';

type Git = (
  args: string[],
  input?: string,
  allowed?: number[],
  signal?: AbortSignal
) => Promise<{ code: number; stdout: Buffer; stderr: string }>;
interface Deps {
  git: Git;
  read: (url: string) => Promise<PrActionState>;
  directory: string;
  remote: (repo: string) => string;
  signal: AbortSignal;
  report: (text: string) => void;
}
const text = async (git: Git, args: string[]) => (await git(args)).stdout.toString('utf8').trim();
type WritableState = PrActionState & { headRepo: string };
function writable(state: PrActionState, session: ConflictSession): asserts state is WritableState {
  if (state.account !== session.account || !state.canUpdateBranch || state.archived || state.state !== 'OPEN')
    throw new Error(`Cannot update ${state.url}. Check its status and branch permissions.`);
  if (!state.headRepo || state.headRepo !== session.headRepo || state.repository !== session.headRepo)
    throw new Error(
      'Restacking currently requires all branches in the same repository so they can be pushed atomically.'
    );
}

/** Keep Git's worktree metadata path below its Windows limit; resume older drafts in place. */
export async function restackWorktreePath(directory: string, token: string): Promise<string> {
  const legacy = path.join(directory, `restack-${token}`);
  try {
    await fs.access(legacy);
    return legacy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path.join(directory, `restack-${token.slice(0, 16)}`);
}

/** Prepare in a private linked worktree; no remote branch is changed here. */
export async function prepareRestack(
  session: ConflictSession,
  urls: string[],
  deps: Deps,
  resume = false
): Promise<RestackPlan> {
  if (!session.commitSha || !urls.length) throw new Error('No dependent PRs were found. Refresh the stack first.');
  if (urls.length > 30 || new Set(urls).size !== urls.length || urls.includes(session.url))
    throw new Error('Choose a single linear stack with at most 30 dependent PRs.');
  const root = await deps.read(session.url);
  writable(root, session);
  if (root.headSha !== session.commitSha || root.headBranch !== session.headBranch)
    throw new Error('The resolved PR changed. Reopen its conflict workspace before restacking.');
  const states: WritableState[] = [];
  let parent = root;
  for (const url of urls) {
    const state = await deps.read(url);
    writable(state, session);
    if (state.baseBranch !== parent.headBranch || state.baseSha !== parent.headSha)
      throw new Error(`The dependency for ${url} changed. Refresh the stack before restacking.`);
    if (!/^[a-f\d]{40,64}$/.test(state.headSha)) throw new Error('GitHub has not returned the branch revision.');
    await deps.git(['check-ref-format', `refs/heads/${state.headBranch}`]);
    states.push(state);
    parent = state;
  }
  if (new Set([root.headBranch, ...states.map((state) => state.headBranch)]).size !== states.length + 1)
    throw new Error('A stack branch occurs more than once. Refresh its dependencies.');
  const expected = states.map(({ url, headSha, baseSha, headBranch, baseBranch }) => ({
    url,
    headSha,
    baseSha,
    headBranch,
    baseBranch,
  }));
  const previous = resume ? session.restack : undefined;
  if (
    resume &&
    (!previous ||
      previous.status !== 'blocked' ||
      previous.rootSha !== root.headSha ||
      JSON.stringify(previous.expected) !== JSON.stringify(expected))
  )
    throw new Error('The stack changed. Prepare the restack again.');
  const plan: RestackPlan = previous ?? {
    token: crypto.randomBytes(32).toString('hex'),
    status: 'prepared',
    rootSha: root.headSha,
    expected,
    branches: [],
  };
  const worktree = await restackWorktreePath(deps.directory, plan.token);
  let keepWorktree = resume;
  const git: Git = (args, input, allowed, signal) =>
    deps.git(
      [
        '-C',
        worktree,
        '-c',
        'rerere.enabled=true',
        '-c',
        'rerere.autoupdate=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        `user.name=${session.account}`,
        '-c',
        `user.email=${session.account}@users.noreply.github.com`,
        ...args,
      ],
      input,
      allowed,
      signal
    );
  try {
    deps.report('Preparing a private worktree for the dependent PRs. Git may fetch file contents.');
    if (!resume) await deps.git(['worktree', 'add', '--detach', worktree, root.headSha]);
    const realWorktree = await fs.realpath(worktree);
    let oldParent = plan.branches.at(-1)?.oldSha ?? session.headSha;
    let newParent = plan.branches.at(-1)?.newSha ?? root.headSha;
    for (const state of states.slice(plan.branches.length)) {
      deps.signal.throwIfAborted();
      deps.report(`Rebasing ${state.headBranch} onto its updated parent. Nothing has been pushed.`);
      await deps.git([
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--filter=blob:none',
        deps.remote(state.headRepo),
        state.headSha,
      ]);
      const ancestor = await deps.git(['merge-base', '--is-ancestor', oldParent, state.headSha], undefined, [0, 1]);
      if (ancestor.code)
        throw new Error(`${state.headBranch} no longer contains its expected parent. Refresh the stack.`);
      const containsNew = await deps.git(['merge-base', '--is-ancestor', newParent, state.headSha], undefined, [0, 1]);
      const boundary = containsNew.code === 0 ? newParent : oldParent;
      const commits = Number(await text(deps.git, ['rev-list', '--count', `${boundary}..${state.headSha}`]));
      if (commits > 500)
        throw new Error(`${state.headBranch} has more than 500 commits to replay. Restack it locally.`);
      let reused = resume ? (plan.blocked?.reused ?? 0) : 0;
      let result;
      if (resume) {
        const files = plan.blocked?.files ?? [];
        if (
          !files.length ||
          files.some((file) => !file.resolved || file.unsupported || hasConflictMarkers(file.result))
        )
          throw new Error('Resolve and review every paused file before continuing the restack.');
        for (const file of files) {
          const absolute = path.resolve(worktree, file.path);
          const real = await fs.realpath(absolute);
          if (!real.startsWith(realWorktree + path.sep) || !(await fs.lstat(absolute)).isFile())
            throw new Error('The paused file is not a regular file in the private worktree.');
          await fs.writeFile(absolute, file.result);
          await git(['add', '--', file.path]);
        }
        result = await git(['-c', 'core.editor=true', 'rebase', '--continue'], undefined, [0, 1]);
        resume = false;
      } else
        result = await git(
          ['rebase', '--rebase-merges', '--no-gpg-sign', '--onto', newParent, boundary, state.headSha],
          undefined,
          [0, 1]
        );
      let rounds = 0;
      while (result.code && rounds++ < commits + 10) {
        const entries = (await git(['ls-files', '-u', '-z'])).stdout.toString('utf8').split('\0').filter(Boolean);
        const paths = new Map<string, { mode: string; stage: string; sha: string }[]>();
        for (const entry of entries) {
          const match = /^(\d+) ([a-f\d]+) ([123])\t([\s\S]+)$/.exec(entry);
          if (match)
            paths.set(match[4], [...(paths.get(match[4]) ?? []), { mode: match[1], sha: match[2], stage: match[3] }]);
        }
        if (paths.size > 100)
          throw new Error(
            'More than 100 files conflict during this restack. Resolve this stack with a local Git tool.'
          );
        if (!paths.size) throw new Error(`Git could not replay ${state.headBranch}. ${result.stderr.slice(0, 600)}`);
        const remaining = new Set(
          (await git(['-c', 'core.quotePath=false', 'rerere', 'remaining'])).stdout.toString('utf8').trim().split('\n')
        );
        const unresolved: ConflictFile[] = [];
        for (const [file, stages] of paths) {
          const absolute = path.resolve(worktree, file);
          const stat = await fs.lstat(absolute).catch(() => undefined);
          const safe =
            absolute.startsWith(worktree + path.sep) &&
            stat?.isFile() &&
            stat.size <= CONFLICT_FILE_LIMIT &&
            stages.length === 3 &&
            stages.every((stage) => /^100(644|755)$/.test(stage.mode)) &&
            new Set(stages.map((stage) => stage.mode)).size === 1 &&
            (await fs.realpath(absolute)).startsWith(realWorktree + path.sep);
          if (
            !safe ||
            file.includes('\n') ||
            remaining.has(file) ||
            hasConflictMarkers(await fs.readFile(absolute, 'utf8'))
          ) {
            const item: ConflictFile = {
              path: file,
              mode: stages[0]?.mode ?? '',
              base: '',
              ours: '',
              theirs: '',
              original: '',
              result: '',
              resolved: false,
              source: 'manual',
            };
            try {
              if (!safe || !(await fs.realpath(absolute)).startsWith(realWorktree + path.sep))
                throw new Error('Resolve this rename, deletion, binary, or file-mode conflict with a local Git tool.');
              const versions = [];
              for (const stage of [...stages].sort((a, b) => a.stage.localeCompare(b.stage))) {
                if (Number(await text(git, ['cat-file', '-s', stage.sha])) > CONFLICT_FILE_LIMIT)
                  throw new Error('This file exceeds the 1 MB conflict editor limit.');
                const value = new TextDecoder('utf-8', { fatal: true }).decode(
                  (await git(['cat-file', 'blob', stage.sha])).stdout
                );
                if (value.includes('\0')) throw new Error('Binary conflicts require a local Git tool.');
                versions.push(value);
              }
              [item.base, item.ours, item.theirs] = versions;
              item.original = item.result = await fs.readFile(absolute, 'utf8');
              if (!hasConflictMarkers(item.original))
                throw new Error('This conflict needs file-level resolution with a local Git tool.');
            } catch (error) {
              item.unsupported = error instanceof Error ? error.message : String(error);
            }
            unresolved.push(item);
          } else {
            await git(['add', '--', file]);
            reused++;
          }
        }
        if (
          unresolved.reduce(
            (bytes, file) => bytes + Buffer.byteLength(file.base + file.ours + file.theirs + file.original),
            0
          ) >
          8 * 1024 * 1024
        )
          throw new Error(
            'The paused conflicts exceed the 8 MB editor limit. Resolve this stack with a local Git tool.'
          );
        if (unresolved.length) {
          plan.status = 'blocked';
          plan.blocked = {
            url: state.url,
            title: state.title,
            reason:
              'The restack is paused on a new conflict. Edit and review each result below, then continue. No dependent branches have been pushed.',
            paths: unresolved.map((file) => file.path),
            files: unresolved,
            reused,
          };
          keepWorktree = true;
          return plan;
        }
        result = await git(['-c', 'core.editor=true', 'rebase', '--continue'], undefined, [0, 1]);
      }
      if (result.code) throw new Error('The restack exceeded its replay limit. No branches were pushed.');
      const newSha = await text(git, ['rev-parse', 'HEAD']);
      const patch = (await git(['diff', '--no-ext-diff', '--no-textconv', state.headSha, newSha])).stdout.toString(
        'utf8'
      );
      if (
        Buffer.byteLength(patch) + plan.branches.reduce((bytes, branch) => bytes + Buffer.byteLength(branch.patch), 0) >
        8 * 1024 * 1024
      )
        throw new Error(
          'The restack preview exceeds 8 MB. Review and restack this large change with a local Git tool.'
        );
      const { parsePatchFiles } = await import('@pierre/diffs');
      const files = parsePatchFiles(patch).flatMap((value) => value.files);
      // Keep prepared objects reachable after closing the private worktree.
      await deps.git(['update-ref', `refs/gnosis/restack/${plan.token}/${plan.branches.length}`, newSha]);
      plan.branches.push({
        url: state.url,
        title: state.title,
        repo: state.headRepo,
        branch: state.headBranch,
        baseBranch: state.baseBranch,
        baseRepo: state.repository,
        baseSha: state.baseSha,
        oldSha: state.headSha,
        newSha,
        commits,
        reused,
        patch,
        files,
      });
      oldParent = state.headSha;
      newParent = newSha;
    }
    plan.status = 'prepared';
    plan.blocked = undefined;
    keepWorktree = false;
    return plan;
  } finally {
    const cleanup = AbortSignal.timeout(30_000);
    if (!keepWorktree) {
      await git(['rebase', '--abort'], undefined, [0, 1, 128], cleanup).catch(() => {});
      await deps.git(['worktree', 'remove', '--force', worktree], undefined, [0, 128], cleanup).catch(() => {});
    }
  }
}

export async function publishRestack(session: ConflictSession, token: string, deps: Deps) {
  const plan = session.restack;
  if (!plan || plan.status !== 'prepared' || plan.token !== token || !plan.branches.length)
    throw new Error('Prepare and review the dependent PR updates before pushing.');
  const root = await deps.read(session.url);
  writable(root, session);
  if (root.headSha !== plan.rootSha || root.headBranch !== session.headBranch)
    throw new Error('The resolved PR changed. Prepare the restack again.');
  for (const branch of plan.branches) {
    const current = await deps.read(branch.url);
    writable(current, session);
    if (
      current.headSha !== branch.oldSha ||
      current.headRepo !== branch.repo ||
      current.headBranch !== branch.branch ||
      current.baseSha !== branch.baseSha ||
      current.baseBranch !== branch.baseBranch ||
      current.repository !== branch.baseRepo
    )
      throw new Error(`${branch.branch} changed. Prepare and review the restack again.`);
  }
  deps.report('Pushing all dependent branches together, with revision guards.');
  await deps.git([
    'push',
    '--atomic',
    '--porcelain',
    `--force-with-lease=refs/heads/${session.headBranch}:${plan.rootSha}`,
    ...plan.branches.map((branch) => `--force-with-lease=refs/heads/${branch.branch}:${branch.oldSha}`),
    deps.remote(session.headRepo),
    `${plan.rootSha}:refs/heads/${session.headBranch}`,
    ...plan.branches.map((branch) => `${branch.newSha}:refs/heads/${branch.branch}`),
  ]);
  plan.status = 'published';
}
