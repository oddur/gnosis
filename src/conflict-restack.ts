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
import { conflictCount, parseConflicts } from '../lib/conflict-blocks';
import { blockResolutions, carryFile, carrySource, type CarriedFile, type CarrySource } from '../lib/conflict-carry';
import { blockBuckets } from '../lib/conflict-verify';

type Git = (
  args: string[],
  input?: string,
  allowed?: number[],
  signal?: AbortSignal
) => Promise<{ code: number; stdout: Buffer; stderr: string }>;
interface Deps {
  git: Git;
  read: (url: string) => Promise<PrActionState>;
  /** `read` for many PRs at once, one promise per URL in order, such as one aliased GitHub query for the stack. */
  readMany?: (urls: string[]) => Promise<PrActionState>[];
  directory: string;
  remote: (repo: string) => string;
  signal: AbortSignal;
  report: (text: string) => void;
  /**
   * The main merge's preparation for a paused commit's files (src/conflict-resolution-service.ts `mergeStructurally`):
   * structural merge, unions, same-change and move proposals. `branches` names the sides: the updated parent, then
   * the PR. Without it, every paused file waits for you, as before #445 item 21.
   */
  propose?: (
    files: ConflictFile[],
    branches: { head: string; base: string },
    /** Keep each file's draft and store the proposals beside it: the draft holds choices of yours. */
    keepDraft: boolean
  ) => Promise<void>;
  /** The main merge's checks of those proposals (`check`, in the main-process worker). */
  check?: (files: ConflictFile[]) => Promise<void>;
  /**
   * Your reviewed paused files, kept by the service beside the draft, never in the plan the renderer reads. Read for
   * carrying your choices to the same conflicts; a continued pause adds its files to it in place.
   */
  carry?: ConflictFile[];
}
/** How a replayed conflict was resolved: by the checks (`merged`), by you (`yours`: carried), or still open. */
export type ReplayBucket = 'merged' | 'yours' | 'check' | 'decide';
/**
 * Each conflict of a replayed file after the pipeline: the view's rule (blockBuckets), with the conflicts your earlier
 * choices were carried to as yours. Fail closed: a conflict that still shows markers, or that blockBuckets calls
 * Decided although nobody chose it in this replay, is Decide. Anything but Merged or yours stops the replay for you.
 */
export function replayBuckets(file: ConflictFile, carried: readonly number[] = []): ReplayBucket[] {
  if (file.unsupported) return ['decide'];
  const segments = parseConflicts(file.original);
  const blocks = segments.filter((segment) => segment.kind === 'conflict');
  if (!blocks.length) return ['decide'];
  const texts = blockResolutions(segments, file.result);
  const buckets = blockBuckets(
    file,
    file.result,
    file.verdict?.verdict,
    file.picks?.map((pick) => pick ?? undefined)
  );
  return blocks.map((segment, i) => {
    const text = texts?.[segment.index];
    if (text === undefined || hasConflictMarkers(text)) return 'decide';
    if (carried.includes(segment.index)) return 'yours';
    const bucket = buckets[i];
    return bucket === 'merged' || bucket === 'check' ? bucket : 'decide';
  });
}
/** Continue found the worktree somewhere else than the pause it would write: it writes nothing. */
export const REPLAY_MOVED = 'The replay moved on since this pause; prepare again.';
/**
 * A partly carried file's draft: your carried text for each carried conflict, structural merge's proposal for each
 * open one with a proposal, and Git's conflict for the rest. Built from the conflicts themselves, never by splitting
 * a draft again, which can be ambiguous.
 */
export function composeCarried(
  original: string,
  texts: readonly (string | undefined)[],
  proposals: readonly ({ text: string } | null | undefined)[] | undefined
) {
  return parseConflicts(original)
    .map((segment) =>
      segment.kind === 'text'
        ? segment.text
        : (texts[segment.index] ?? proposals?.[segment.index]?.text ?? segment.block.raw)
    )
    .join('');
}
/** What `carry` keeps of a file you resolved: enough for carryFile to match its conflicts and reuse their text. */
function carried(file: ConflictFile): ConflictFile {
  return {
    path: file.path,
    mode: '',
    base: '',
    ours: '',
    theirs: '',
    original: file.original,
    result: file.result,
    resolved: true,
    source: 'manual',
    ...(file.picks ? { picks: file.picks } : {}),
  };
}
/** The newest carried files, at most 50 and 4 MB, one per conflict. */
export function carryList(files: ConflictFile[]): ConflictFile[] {
  const kept: ConflictFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of [...files].reverse()) {
    if (file.unsupported || !file.resolved || hasConflictMarkers(file.result)) continue;
    const key = `${file.path}\0${file.original}`;
    const size = Buffer.byteLength(file.original + file.result);
    if (seen.has(key) || kept.length >= 50 || bytes + size > 4 * 1024 * 1024) continue;
    seen.add(key);
    bytes += size;
    kept.unshift(carried(file));
  }
  return kept;
}
/**
 * Every read at once, through `readMany` when there is one, and all of them settled before any check runs, so no read
 * is left running when a check fails. Checks still run in stack order: `settled` throws a read's error at its place.
 */
async function readSettled(deps: Deps, urls: string[]): Promise<PromiseSettledResult<PrActionState>[]> {
  return Promise.allSettled(deps.readMany ? deps.readMany(urls) : urls.map((url) => deps.read(url)));
}
function settled(result: PromiseSettledResult<PrActionState>): PrActionState {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
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
  const [rootRead, ...reads] = await readSettled(deps, [session.url, ...urls]);
  const root = settled(rootRead);
  writable(root, session);
  if (root.headSha !== session.commitSha || root.headBranch !== session.headBranch)
    throw new Error('The resolved PR changed. Reopen its conflict workspace before restacking.');
  const states: WritableState[] = [];
  let parent = root;
  for (const [index, url] of urls.entries()) {
    const state = settled(reads[index]);
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
  const carry = deps.carry ?? [];
  // Each carry source's conflicts, read once for the whole preparation.
  const sourceMaps = new WeakMap<ConflictFile, CarrySource | null>();
  const mapOf = (source: ConflictFile) => {
    if (!sourceMaps.has(source)) sourceMaps.set(source, carrySource(source) ?? null);
    return sourceMaps.get(source) ?? undefined;
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
        // The ancestor's lines in each conflict, as the main merge writes them: the checks and the rules need them.
        '-c',
        'merge.conflictStyle=diff3',
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
  /**
   * The main merge's pipeline on a paused commit's text conflicts: structural merge with unions, same-change and move
   * proposals, then your earlier choices for the same conflicts, then the checks. A file whose every conflict is Merged
   * or yours is written and staged; the others are left for you, with their proposals and verdicts.
   */
  async function settle(files: ConflictFile[], branches: { head: string; base: string }) {
    let merged = 0;
    let yours = 0;
    const work = files.filter((file) => !file.unsupported);
    if (!deps.propose || !work.length) return { left: files, merged, yours };
    // Your earlier choices first: structural merge runs only where a conflict is still open.
    const sources = [
      ...[...carry].reverse(),
      ...session.files.filter((file) => file.resolved && !file.unsupported && !hasConflictMarkers(file.result)),
    ];
    const carriedBlocks = new Map<ConflictFile, number[]>();
    const carriedTexts = new Map<ConflictFile, (string | undefined)[]>();
    for (const [index, file] of work.entries()) {
      let best: CarriedFile | undefined;
      for (const source of sources) {
        if (source.path !== file.path) continue;
        const map = mapOf(source);
        if (!map) continue;
        const attempt = carryFile(source, file, false, map);
        if (attempt.reused > (best?.reused ?? 0)) best = attempt;
      }
      const blocks = best?.carried;
      if (!best || !blocks?.length) continue;
      // Structural merge skips a remembered resolution's file: the open conflicts here still get their pass.
      const next: ConflictFile = { ...best.file, source: 'manual' };
      work[index] = next;
      carriedBlocks.set(next, blocks);
      carriedTexts.set(next, best.texts ?? []);
    }
    const fresh = work.filter((file) => !carriedBlocks.has(file));
    const partial = work.filter((file) => {
      const blocks = carriedBlocks.get(file);
      return !!blocks && blocks.length < conflictCount(file.original);
    });
    if (fresh.length) await deps.propose(fresh, branches, false);
    if (partial.length) await deps.propose(partial, branches, true);
    deps.signal.throwIfAborted();
    // A carried conflict is yours: it has no proposal, so neither the checks nor the view can call it Merged. The
    // others take structural merge's proposal beside your carried text.
    for (const file of partial) {
      const blocks = carriedBlocks.get(file) ?? [];
      const proposals = file.proposals?.map((proposal, i) => (blocks.includes(i) ? null : proposal));
      if (proposals?.some(Boolean)) {
        file.proposals = proposals;
        file.result = composeCarried(file.original, carriedTexts.get(file) ?? [], proposals);
      } else delete file.proposals;
      delete file.verdict;
    }
    await deps.check?.(work);
    deps.signal.throwIfAborted();
    const done = new Set<string>();
    for (const file of work) {
      const buckets = replayBuckets(file, carriedBlocks.get(file));
      if (hasConflictMarkers(file.result) || !buckets.every((bucket) => bucket === 'merged' || bucket === 'yours'))
        continue;
      await fs.writeFile(path.resolve(worktree, file.path), file.result);
      await git(['add', '--', file.path]);
      done.add(file.path);
      merged += buckets.filter((bucket) => bucket === 'merged').length;
      yours += buckets.filter((bucket) => bucket === 'yours').length;
    }
    if (done.size) await forgetRerere(done);
    const byPath = new Map(work.map((file) => [file.path, file]));
    const left = files.filter((file) => !done.has(file.path)).map((file) => byPath.get(file.path) ?? file);
    return { left, merged, yours };
  }
  /**
   * Git rerere records a staged result when the commit is made, and would offer it later as a resolution you reviewed.
   * These are the checks' results (or your carried choices, already kept): their entries leave the merge's rerere list,
   * and the preimages this replay recorded for them are removed, so nothing is left behind in the resolution memory.
   */
  async function forgetRerere(paths: Set<string>) {
    const file = path.resolve(worktree, await text(git, ['rev-parse', '--git-path', 'MERGE_RR']));
    const entries = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (entries === undefined) return;
    const cache = path.resolve(worktree, await text(git, ['rev-parse', '--git-path', 'rr-cache']));
    const kept: string[] = [];
    for (const entry of entries.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (!paths.has(entry.slice(tab + 1))) {
        kept.push(entry);
        continue;
      }
      // `<hash>` or `<hash>.<variant>`: rr-cache/<hash>/preimage[.<variant>], beside its postimage once resolved.
      const match = /^([a-f\d]{40,64})(?:\.(\d+))?$/.exec(entry.slice(0, tab));
      if (!match) continue;
      const suffix = match[2] && match[2] !== '0' ? `.${match[2]}` : '';
      const dir = path.join(cache, match[1]);
      // Only a preimage without a resolution: one with a postimage is an earlier resolution of yours.
      if (
        await fs.stat(path.join(dir, `postimage${suffix}`)).then(
          () => true,
          () => false
        )
      )
        continue;
      await fs.rm(path.join(dir, `preimage${suffix}`), { force: true });
      await fs.rmdir(dir).catch(() => {});
    }
    await fs.writeFile(file, kept.map((entry) => entry + '\0').join(''));
  }
  /** Where the worktree's replay stands: the commit Git is replaying, HEAD, and the unmerged paths. Empty when gone. */
  async function pausedAt(): Promise<{ commit: string; head: string; paths?: string[] }> {
    const read = async (args: string[]) => {
      const result = await git(args, undefined, [0, 1, 128]).catch(() => undefined);
      return result?.code === 0 ? result.stdout.toString('utf8') : undefined;
    };
    const commit = (await read(['rev-parse', '--verify', '-q', 'REBASE_HEAD']))?.trim() ?? '';
    const head = (await read(['rev-parse', '--verify', '-q', 'HEAD']))?.trim() ?? '';
    const listing = await read(['ls-files', '-u', '-z']);
    const paths = listing
      ?.split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf('\t') + 1));
    return { commit, head, paths: paths && [...new Set(paths)] };
  }
  try {
    deps.report('Preparing a private worktree for the dependent PRs. Git may fetch file contents.');
    if (!resume) await deps.git(['worktree', 'add', '--detach', worktree, root.headSha]);
    // A paused worktree that is gone, such as after a stale pause was refused, cannot take the pause's files.
    const realWorktree = await fs.realpath(worktree).catch((error: unknown) => {
      if (resume) throw new Error(REPLAY_MOVED);
      throw error;
    });
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
      // A recreated merge commit may drop what the original merge added (an evil merge), even when Git reports nothing.
      const merges = Number(await text(deps.git, ['rev-list', '--count', '--merges', `${boundary}..${state.headSha}`]));
      let reused = resume ? (plan.blocked?.reused ?? 0) : 0;
      // A PR whose replay paused had a Check or Decide: you reviewed its files, and its update needs its tick too.
      const review = resume;
      let merged = resume ? (plan.blocked?.merged ?? 0) : 0;
      let yours = resume ? (plan.blocked?.yours ?? 0) : 0;
      let result;
      if (resume) {
        const files = plan.blocked?.files ?? [];
        if (
          !files.length ||
          files.some((file) => !file.resolved || file.unsupported || hasConflictMarkers(file.result))
        )
          throw new Error('Resolve and review every paused file before continuing the restack.');
        // A Continue that failed after Git moved on leaves this pause stored while the worktree is at a later step.
        // Write nothing unless the worktree is paused exactly here: the same PR, commit, HEAD and conflicted paths.
        const here = await pausedAt();
        const blocked = plan.blocked;
        if (
          !blocked?.commit ||
          !blocked.head ||
          blocked.url !== state.url ||
          here.commit !== blocked.commit ||
          here.head !== blocked.head ||
          here.paths === undefined ||
          [...here.paths].sort().join('\0') !== [...blocked.paths].sort().join('\0')
        ) {
          keepWorktree = false;
          throw new Error(REPLAY_MOVED);
        }
        // The checks' Merged conflicts in a paused file stay theirs; you decided or accepted every other one there.
        for (const file of files) {
          const buckets = blockBuckets(
            file,
            file.result,
            file.verdict?.verdict,
            file.picks?.map((pick) => pick ?? undefined)
          );
          const own = buckets.filter((bucket) => bucket !== 'merged').length;
          merged += buckets.length - own;
          yours += buckets.length ? own : 1;
        }
        carry.splice(0, carry.length, ...carryList([...carry, ...files]));
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
        const settled = await settle(unresolved, { head: state.baseBranch, base: state.headBranch });
        merged += settled.merged;
        yours += settled.yours;
        if (settled.left.length) {
          plan.status = 'blocked';
          const identity = await pausedAt();
          plan.blocked = {
            url: state.url,
            title: state.title,
            reason:
              'The restack is paused on a new conflict. Edit and review each result below, then continue. No dependent branches have been pushed.',
            paths: settled.left.map((file) => file.path),
            files: settled.left,
            reused,
            merged,
            yours,
            commit: identity.commit,
            head: identity.head,
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
        merged,
        yours,
        merges,
        // Only a replay without a conflict or a merge commit, or whose every conflict the checks merged, needs no tick.
        review: review || reused > 0 || yours > 0 || merges > 0,
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
      // An abandoned pause leaves no preimage of its own behind in the resolution memory.
      await git(['rerere', 'clear'], undefined, [0, 1, 128], cleanup).catch(() => {});
      await git(['rebase', '--abort'], undefined, [0, 1, 128], cleanup).catch(() => {});
      await deps.git(['worktree', 'remove', '--force', worktree], undefined, [0, 128], cleanup).catch(() => {});
    }
  }
}

export async function publishRestack(session: ConflictSession, token: string, deps: Deps) {
  const plan = session.restack;
  if (!plan || plan.status !== 'prepared' || plan.token !== token || !plan.branches.length)
    throw new Error('Prepare and review the dependent PR updates before pushing.');
  const [rootRead, ...reads] = await readSettled(deps, [session.url, ...plan.branches.map((branch) => branch.url)]);
  const root = settled(rootRead);
  writable(root, session);
  if (root.headSha !== plan.rootSha || root.headBranch !== session.headBranch)
    throw new Error('The resolved PR changed. Prepare the restack again.');
  for (const [index, branch] of plan.branches.entries()) {
    const current = settled(reads[index]);
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
