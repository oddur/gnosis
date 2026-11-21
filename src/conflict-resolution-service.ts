import crypto from 'node:crypto';
import path from 'node:path';
import { settleInOrder } from '../lib/bounded';
import fs from 'node:fs/promises';
import {
  CONFLICT_FILE_LIMIT,
  hasConflictMarkers,
  validateConflictRequest,
  type ConflictFile,
  type ConflictSession,
  type ConflictRequest,
  type ConflictReply,
  type BaseMove,
} from '../lib/conflict-resolution';
import {
  BASE_KEEPS_MOVING,
  BASE_MOVE_ROUNDS,
  HEAD_MOVED,
  RETARGETED,
  blockProposals,
  carryFile,
  conflictKeys,
  relabelMarkers,
  revisionChange,
  withProposals,
  withResult,
} from '../lib/conflict-carry';
import { conflictCount } from '../lib/conflict-blocks';
import { withUnions } from '../lib/conflict-union';
import type { Verdict } from '../lib/conflict-verify';
import { verdictKey } from '../lib/conflict-verdict-key';
import { withoutUnconfirmed } from './conflict-checks';
import type { SyntaxLanguage } from '../lib/syntax-scope';
import type { StateStorage } from './app-data-store';
import type { PrActionState } from '../lib/pr-actions';
import { hasMergeConflicts } from '../lib/merge-conflicts';
import { runConflictProcess } from './conflict-process';
import { createConflictMemory } from './conflict-rerere';
import { prepareRestack, publishRestack, restackWorktreePath } from './conflict-restack';
import {
  SHARED_LAYOUT_FILE,
  STORES_DIRECTORY,
  conflictStoreDirectory,
  conflictStoreRefPrefix,
  conflictStoreRemote,
  createStoreLocks,
  localCloneObjectDirectory,
  readSharedLayout,
  type SharedLayout,
} from './conflict-object-store';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const oid = (value: string) => /^[a-f0-9]{40,64}$/.test(value);
const repoName = (value: string) => /^[\w.-]+\/[\w.-]+$/.test(value);
/** Why background work stopped: a request of yours came for the same PR. */
export const BACKGROUND_YIELDED = 'Background preparation stopped for your request.';
/** Thrown when you can't push to the PR branch, before anything is prepared. */
export const NO_PERMISSION = 'You need permission to update this open PR branch.';
/** Background drafts kept, newest first, and the age after which one leaves (src/conflict-precompute.ts). */
const BACKGROUND_DRAFTS = 8;
const BACKGROUND_AGE = 7 * 24 * 60 * 60 * 1000;
interface Context {
  account: string;
  token: string;
}
interface Deps {
  /** `names` lists saved states, so startup cleanup can tell which cache directories a saved session needs. */
  storage: Pick<StateStorage, 'read' | 'write' | 'flush'> & { names?: () => string[] };
  directory: () => string;
  context: () => Context;
  read: (url: string) => Promise<PrActionState>;
  /** `read` for many PRs at once, one promise per URL in order. */
  readMany?: (urls: string[]) => Promise<PrActionState>[];
  mergiraf: () => string;
  /**
   * Milliseconds for structural merge while preparing, for one retry, and for all retries together: 5000, 10000 and
   * 30000. Tests change them.
   */
  structuralTimeouts?: [number, number, number];
  suggest: (
    context: { session: ConflictSession; file: ConflictFile; instructions: string },
    signal: AbortSignal
  ) => Promise<{ contents?: string; explanation: string }>;
  /** The merge base GitHub reports for `base...head` in `repo`. Without it, conflicts use the full-history path. */
  mergeBase?: (repo: string, base: string, head: string) => Promise<string | undefined>;
  /** The checkout linked to a repository in Settings, if any. Its objects are read, never written. */
  localClone?: (repo: string) => string | undefined;
  /** Tests use local bare remotes. Production only constructs github.com URLs. */
  remote?: (repo: string) => string;
  dependents?: (url: string) => string[];
  /**
   * Checks one file's proposals (src/conflict-checks.ts). The verdict is saved with the file, so its buckets are known
   * before any dialog opens. Without it, the renderer checks them. Undefined: the check could not run, so nothing is
   * saved and the next open checks again.
   */
  verify?: (file: ConflictFile, disabled: SyntaxLanguage[]) => Promise<Verdict | undefined>;
  /** The languages that are off in Settings › Code intelligence: a saved verdict counts only for the same ones. */
  disabledLanguages?: () => SyntaxLanguage[];
  /** Background drafts kept (BACKGROUND_DRAFTS). Tests change it. */
  backgroundDrafts?: number;
}
/** A single scope hash leaves room for Git's internal worktree paths on Windows. */
export async function conflictSessionDirectory(root: string, account: string, id: string): Promise<string> {
  const legacy = path.join(root, hash(account), id);
  try {
    await fs.access(legacy);
    return legacy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path.join(root, 'sessions', hash(JSON.stringify([account, id])));
}

export function createConflictResolutionService(deps: Deps) {
  const memory = createConflictMemory(() => path.join(deps.directory(), 'resolution-memory'));
  const memoryScope = (session: Pick<ConflictSession, 'account' | 'headRepo'>) =>
    `${session.account.toLowerCase()}:${session.headRepo.toLowerCase()}`;
  const busy = new Set<string>();
  /** Background work that holds a PR's lock (a run or a drop). A request of yours stops it and waits: it never fails on it. */
  const backgroundWork = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  /** Takes the PR's lock for background work, which yields to you (`yieldToYou`). `signal` still stops it too. */
  function asBackground<T>(key: string, signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forward, { once: true });
    busy.add(key);
    const done = (async () => {
      try {
        return await task(controller.signal);
      } catch (error) {
        // Stopped for a request of yours: say so, whatever the step that stopped reported.
        const reason: unknown = controller.signal.reason;
        throw reason instanceof Error && reason.message === BACKGROUND_YIELDED ? reason : error;
      } finally {
        busy.delete(key);
        backgroundWork.delete(key);
        signal?.removeEventListener('abort', forward);
      }
    })();
    backgroundWork.set(key, { controller, done });
    return done;
  }
  /** Stops background work on the PR and waits for it to let go of the lock. */
  async function yieldToYou(key: string) {
    for (let work = backgroundWork.get(key); work; work = backgroundWork.get(key)) {
      work.controller.abort(new Error(BACKGROUND_YIELDED));
      await work.done.catch(() => {});
    }
  }
  const withStore = createStoreLocks();
  const storageKey = (account: string, id: string) => `conflict-draft:${account}:${id}`;
  const directory = (account: string, id: string) => conflictSessionDirectory(deps.directory(), account, id);
  async function persist(session: ConflictSession) {
    deps.storage.write(storageKey(session.account, session.id), session);
    await deps.storage.flush();
  }
  function sessionFor(ctx: Context, id: string): ConflictSession {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid conflict session.');
    const value = deps.storage.read(storageKey(ctx.account, id)) as ConflictSession | undefined;
    if (!value || value.account !== ctx.account || value.id !== id)
      throw new Error('Open this PR’s conflict workspace again.');
    return structuredClone(value);
  }
  function assertAccount(ctx: Context) {
    const current = deps.context();
    if (current.account !== ctx.account || current.token !== ctx.token)
      throw new Error('GitHub account changed. Reopen the conflict workspace.');
  }
  const remote = (repo: string) => {
    if (!repoName(repo)) throw new Error('Invalid GitHub repository.');
    return deps.remote?.(repo) ?? `https://github.com/${repo}.git`;
  };
  /** Git with an isolated configuration. `token` adds GitHub credentials for network commands. */
  async function runGit(
    cwd: string,
    args: string[],
    signal: AbortSignal,
    options: { token?: string; input?: string | Buffer; allowed?: number[]; lazyFetch?: boolean } = {}
  ) {
    // Isolate user/system Git config: no credential helper, hooks or custom merge driver can execute.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...(options.lazyFetch === false ? { GIT_NO_LAZY_FETCH: '1' } : {}),
      ...(options.token
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
          }
        : {}),
    };
    const result = await runConflictProcess(
      'git',
      [
        '--literal-pathspecs',
        '-c',
        'core.longpaths=true',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'credential.helper=',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        `protocol.file.allow=${deps.remote ? 'always' : 'never'}`,
        ...args,
      ],
      { cwd, env, input: options.input, signal, timeout: 180_000 }
    );
    if (!(options.allowed ?? [0]).includes(result.code)) {
      let safe = result.stderr.replace(/AUTHORIZATION:[^\r\n]*/gi, '[redacted]');
      if (options.token) safe = safe.replaceAll(options.token, '[redacted]');
      throw new Error(`Git could not complete this operation. ${safe.slice(0, 1500)}`);
    }
    return result;
  }
  async function git(
    ctx: Context,
    id: string,
    args: string[],
    signal: AbortSignal,
    input?: string | Buffer,
    allowed = [0],
    options: { cwd?: string; lazyFetch?: boolean } = {}
  ) {
    assertAccount(ctx);
    return runGit(options.cwd ?? (await directory(ctx.account, id)), args, signal, {
      token: ctx.token,
      input,
      allowed,
      lazyFetch: options.lazyFetch,
    });
  }
  async function current(session: ConflictSession, ctx: Context) {
    const state = await deps.read(session.url);
    assertAccount(ctx);
    if (state.account !== ctx.account || state.state !== 'OPEN' || state.archived || !state.canUpdateBranch)
      throw new Error('You cannot update this PR branch with the connected account.');
    // New commits on the PR are someone else's work: block. New base commits alone are merged again at publish.
    const change = revisionChange(session, state);
    if (change === 'head-moved') throw new Error(HEAD_MOVED);
    if (change === 'retargeted') throw new Error(RETARGETED);
    return { state, change };
  }
  async function blob(ctx: Context, id: string, sha: string, signal: AbortSignal) {
    if (!oid(sha)) throw new Error('Invalid Git object.');
    const size = Number((await git(ctx, id, ['cat-file', '-s', sha], signal)).stdout.toString());
    if (size > CONFLICT_FILE_LIMIT)
      throw new Error('File exceeds the 1 MB conflict editor limit. Resolve it with a local merge tool.');
    const data = (await git(ctx, id, ['cat-file', 'blob', sha], signal)).stdout;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.includes('\0')) throw new Error('Binary files require a local merge tool.');
    return text;
  }
  interface MergeSpec {
    headRepo: string;
    baseRepo: string;
    headSha: string;
    baseSha: string;
    headBranch: string;
    baseBranch: string;
  }
  interface Prepared {
    merge: { code: number; stdout: Buffer };
    tree: string;
    parts: string[];
    /** Set when the cache is shallow: Git has the three commits, not the history between them. */
    mergeBase?: string;
  }
  /**
   * Git labels the common ancestor's conflict lines with the `--merge-base` argument. Without one it uses an
   * abbreviation whose length grows with the repository, so a shallow cache would label them differently.
   */
  const ancestorLabel = (sha: string) => sha.slice(0, 12);
  const exists = (file: string) =>
    fs.stat(file).then(
      () => true,
      () => false
    );
  const accountChanged = (error: unknown) =>
    error instanceof Error && error.message.startsWith('GitHub account changed');
  function parseMerge(merge: { code: number; stdout: Buffer }) {
    const parts = merge.stdout.toString('utf8').split('\0');
    const tree = (parts.shift() ?? '').trim();
    if (!oid(tree)) throw new Error('Resolve conflicts needs Git 2.40 or newer. Install a newer Git, then try again.');
    return { merge, tree, parts };
  }
  /** Starts a session from an empty directory. A legacy-path directory moves to the current layout. */
  async function resetSession(ctx: Context, id: string) {
    const dir = await directory(ctx.account, id);
    await dropStoreRefs(ctx.account, id, dir);
    await fs.rm(dir, { recursive: true, force: true });
    const next = await directory(ctx.account, id);
    await fs.mkdir(next, { recursive: true, mode: 0o700 });
    return next;
  }
  async function dropStoreRefs(account: string, id: string, dir: string) {
    const layout = await readSharedLayout(dir);
    if (!layout) return;
    const store = path.resolve(deps.directory(), layout.store);
    if (!store.startsWith(path.join(deps.directory(), STORES_DIRECTORY) + path.sep) || !(await exists(store))) return;
    await withStore(store, async () => {
      const prefix = conflictStoreRefPrefix(account, id);
      const refs = (
        await runGit(store, ['for-each-ref', '--format=%(refname)', prefix], new AbortController().signal)
      ).stdout
        .toString('utf8')
        .split('\n')
        .filter(Boolean);
      if (refs.length)
        await runGit(store, ['update-ref', '--stdin'], new AbortController().signal, {
          input: refs.map((ref) => `delete ${ref}\n`).join(''),
        });
    });
  }
  /** Today's path: the whole history of both commits, without blobs. Used when the shallow path cannot run. */
  async function prepareFull(
    ctx: Context,
    id: string,
    spec: MergeSpec,
    signal: AbortSignal,
    report: (text: string) => void
  ): Promise<Prepared> {
    await resetSession(ctx, id);
    await git(ctx, id, ['init', '--bare', '.'], signal);
    report('Fetching the PR and base history into a private Git cache.');
    for (const [name, repo, sha] of [
      ['pr', spec.headRepo, spec.headSha],
      ['base', spec.baseRepo, spec.baseSha],
    ]) {
      await git(ctx, id, ['config', `remote.${name}.url`, remote(repo)], signal);
      await git(ctx, id, ['config', `remote.${name}.promisor`, 'true'], signal);
      await git(ctx, id, ['config', `remote.${name}.partialclonefilter`, 'blob:none'], signal);
      await git(ctx, id, ['fetch', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', name, sha], signal);
    }
    report('Finding conflicts. Your checkout is not modified.');
    // With one merge base, name it as the shallow path does, so both paths write identical conflict markers.
    const bases = (
      await git(ctx, id, ['merge-base', '--all', spec.headSha, spec.baseSha], signal, undefined, [0, 1])
    ).stdout
      .toString('utf8')
      .split('\n')
      .filter(oid);
    return parseMerge(
      await git(
        ctx,
        id,
        [
          '-c',
          'merge.conflictStyle=diff3',
          'merge-tree',
          '--write-tree',
          '--messages',
          '-z',
          ...(bases.length === 1 ? [`--merge-base=${ancestorLabel(bases[0])}`] : []),
          spec.headSha,
          spec.baseSha,
        ],
        signal,
        undefined,
        [0, 1]
      )
    );
  }
  /**
   * The fast path. GitHub names the merge base, so the cache needs three commits and their trees, not their history.
   * They come from a store shared by every PR in the repository, or from a linked local clone. The session repository
   * borrows those objects through alternates and lists the commits as shallow, so nothing walks past them.
   */
  async function prepareShallow(
    ctx: Context,
    id: string,
    spec: MergeSpec,
    signal: AbortSignal,
    report: (text: string) => void
  ): Promise<Prepared | undefined> {
    if (!deps.mergeBase) return;
    report('Finding the merge base on GitHub.');
    const mergeBase = await deps.mergeBase(spec.baseRepo, spec.baseSha, spec.headSha).catch((error: unknown) => {
      signal.throwIfAborted();
      console.warn('[conflicts] Could not read the merge base; fetching history instead.', error);
      return undefined;
    });
    signal.throwIfAborted();
    if (!mergeBase || !oid(mergeBase)) return;
    const dir = await resetSession(ctx, id);
    const store = conflictStoreDirectory(deps.directory(), ctx.account, spec.baseRepo);
    // Written first, so a failure part way still lets the reset drop this session's store refs.
    const layout: SharedLayout = { version: 1, store: path.relative(deps.directory(), store), mergeBase };
    await fs.writeFile(path.join(dir, SHARED_LAYOUT_FILE), JSON.stringify(layout), { mode: 0o600 });
    const clones = [
      ...new Set(
        (
          await Promise.all(
            [spec.baseRepo, spec.headRepo].map((repo) => localCloneObjectDirectory(deps.localClone?.(repo)))
          )
        ).filter((value): value is string => !!value)
      ),
    ];
    const wanted = [
      { repo: spec.headRepo, sha: spec.headSha, name: 'head' },
      { repo: spec.baseRepo, sha: spec.baseSha, name: 'base' },
      { repo: spec.baseRepo, sha: mergeBase, name: 'merge-base' },
    ];
    const commits = [...new Set(wanted.map((item) => item.sha))];
    await git(ctx, id, ['init', '--bare', '.'], signal);
    for (const [key, value] of [
      // Restack and rebase run `gc --auto`. A repack would need the borrowed objects and missing blobs.
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      // Store refs of other sessions are shallow there, so they must not count as complete history here.
      ['core.alternateRefsPrefixes', 'refs/gnosis-none/'],
    ])
      await git(ctx, id, ['config', key, value], signal);
    const alternates = path.join(dir, 'objects', 'info', 'alternates');
    // No promisor remote is configured yet, so a presence check cannot fetch a missing commit and its history.
    const present = async (sha: string) =>
      (await git(ctx, id, ['cat-file', '-e', `${sha}^{tree}`], signal, undefined, [0, 1, 128], { lazyFetch: false }))
        .code === 0;
    await withStore(store, async () => {
      await fs.mkdir(store, { recursive: true, mode: 0o700 });
      if (!(await exists(path.join(store, 'HEAD')))) {
        await git(ctx, id, ['init', '--bare', '.'], signal, undefined, [0], { cwd: store });
        for (const [key, value] of [
          ['gc.auto', '0'],
          ['maintenance.auto', 'false'],
          ['fetch.writeCommitGraph', 'false'],
        ])
          await git(ctx, id, ['config', key, value], signal, undefined, [0], { cwd: store });
      }
      await fs.writeFile(alternates, path.join(store, 'objects') + '\n', { mode: 0o600 });
      const stored = new Set<string>();
      for (const sha of commits) if (await present(sha)) stored.add(sha);
      if (clones.length) {
        await fs.writeFile(alternates, [path.join(store, 'objects'), ...clones].join('\n') + '\n', { mode: 0o600 });
        if (commits.some((sha) => !stored.has(sha))) report('Reading objects from your local clone.');
      }
      const missing: typeof wanted = [];
      for (const item of wanted)
        if (!missing.some((other) => other.sha === item.sha) && !stored.has(item.sha) && !(await present(item.sha)))
          missing.push(item);
      if (missing.length) {
        report(`Fetching ${missing.length} commit${missing.length === 1 ? '' : 's'} from GitHub.`);
        for (const repo of new Set(missing.map((item) => item.repo))) {
          const name = conflictStoreRemote(repo);
          for (const [key, value] of [
            [`remote.${name}.url`, remote(repo)],
            [`remote.${name}.promisor`, 'true'],
            [`remote.${name}.partialclonefilter`, 'blob:none'],
          ])
            await git(ctx, id, ['config', key, value], signal, undefined, [0], { cwd: store });
          await git(
            ctx,
            id,
            [
              'fetch',
              '--no-tags',
              '--no-write-fetch-head',
              '--recurse-submodules=no',
              '--depth=1',
              '--filter=blob:none',
              name,
              ...missing.filter((item) => item.repo === repo).map((item) => item.sha),
            ],
            signal,
            undefined,
            [0],
            { cwd: store }
          );
        }
        for (const item of missing) {
          if (!(await present(item.sha))) throw new Error(`GitHub did not send ${item.sha}.`);
          stored.add(item.sha);
        }
      }
      // Replace this session's refs, so the store keeps exactly the commits it borrows.
      const prefix = conflictStoreRefPrefix(ctx.account, id);
      const old = (
        await git(ctx, id, ['for-each-ref', '--format=%(refname)', prefix], signal, undefined, [0], { cwd: store })
      ).stdout
        .toString('utf8')
        .split('\n')
        .filter(Boolean);
      const kept = wanted.filter((item) => stored.has(item.sha));
      const updates = [
        ...old.filter((ref) => !kept.some((item) => ref === prefix + item.name)).map((ref) => `delete ${ref}\n`),
        ...kept.map((item) => `update ${prefix}${item.name} ${item.sha}\n`),
      ];
      if (updates.length) await git(ctx, id, ['update-ref', '--stdin'], signal, updates.join(''), [0], { cwd: store });
    });
    await fs.writeFile(path.join(dir, 'shallow'), [...commits].sort().join('\n') + '\n', { mode: 0o600 });
    // File versions arrive on demand, as in the full path. Git batches them: one request for rename candidates and
    // one for content merges. Fetching them in one request beforehand measured no faster on klanggames/seed.
    for (const [name, repo] of [
      ['pr', spec.headRepo],
      ['base', spec.baseRepo],
    ]) {
      await git(ctx, id, ['config', `remote.${name}.url`, remote(repo)], signal);
      await git(ctx, id, ['config', `remote.${name}.promisor`, 'true'], signal);
      await git(ctx, id, ['config', `remote.${name}.partialclonefilter`, 'blob:none'], signal);
    }
    report('Finding conflicts. Your checkout is not modified.');
    const prepared = parseMerge(
      await git(
        ctx,
        id,
        [
          '-c',
          'merge.conflictStyle=diff3',
          'merge-tree',
          '--write-tree',
          '--messages',
          '-z',
          `--merge-base=${ancestorLabel(mergeBase)}`,
          spec.headSha,
          spec.baseSha,
        ],
        signal,
        undefined,
        [0, 1]
      )
    );
    return { ...prepared, mergeBase };
  }
  /**
   * Both preparation paths run `git merge-tree --merge-base`, which needs Git 2.40. Older Git stops with a usage dump,
   * so say what to do before starting. A failed check runs again next time, after the user updates Git.
   */
  let gitVersion: Promise<void> | undefined;
  function checkGitVersion() {
    gitVersion ??= runGit(deps.directory(), ['--version'], new AbortController().signal)
      .then(({ stdout }) => {
        const match = /(\d+)\.(\d+)(?:\.\d+)?/.exec(stdout.toString('utf8'));
        if (match && (Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 40)))
          throw new Error(
            `Resolve conflicts needs Git 2.40 or newer; you have ${match[0]}. Install a newer Git, then try again.`
          );
      })
      .catch((error: unknown) => {
        gitVersion = undefined;
        throw error;
      });
    return gitVersion;
  }
  async function prepare(
    ctx: Context,
    id: string,
    spec: MergeSpec,
    signal: AbortSignal,
    report: (text: string) => void
  ): Promise<Prepared> {
    await fs.mkdir(deps.directory(), { recursive: true, mode: 0o700 });
    await checkGitVersion();
    for (const branch of [spec.headBranch, spec.baseBranch])
      await runGit(deps.directory(), ['check-ref-format', `refs/heads/${branch}`], signal);
    try {
      const prepared = await prepareShallow(ctx, id, spec, signal, report);
      if (prepared) return prepared;
    } catch (error) {
      signal.throwIfAborted();
      if (accountChanged(error)) throw error;
      console.warn('[conflicts] The shallow cache failed; fetching history instead.', error);
    }
    return prepareFull(ctx, id, spec, signal, report);
  }
  /** The conflicted files of a prepared merge, with their three versions and Git's conflict text. */
  async function conflictFiles(ctx: Context, id: string, prepared: Prepared, signal: AbortSignal) {
    const { merge, tree, parts } = prepared;
    const stages = new Map<string, Partial<Record<string, { mode: string; sha: string }>>>();
    for (const entry of parts) {
      if (!entry) break;
      const match = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error('Git returned an unsupported conflict format.');
      const file = stages.get(match[4]) ?? {};
      file[match[3]] = { mode: match[1], sha: match[2] };
      stages.set(match[4], file);
    }
    // Git emits conflicts which cannot be represented by text markers (rename, directory, mode, etc.).
    const unsupportedPaths = new Set<string>();
    let messageIndex = parts.indexOf('') + 1;
    while (messageIndex > 0 && messageIndex < parts.length && parts[messageIndex]) {
      const count = Number(parts[messageIndex++]);
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Unsupported Git conflict messages.');
      const paths = parts.slice(messageIndex, messageIndex + count);
      messageIndex += count;
      const type = parts[messageIndex++];
      messageIndex++;
      if (type.startsWith('CONFLICT') && type !== 'CONFLICT (contents)') paths.forEach((p) => unsupportedPaths.add(p));
    }
    for (const p of unsupportedPaths) if (!stages.has(p)) stages.set(p, {});
    if (stages.size > 100)
      throw new Error('This PR has more than 100 conflicted files. Resolve it with a local merge tool.');
    const files: ConflictFile[] = [];
    let bytes = 0;
    for (const [filePath, stage] of stages) {
      signal.throwIfAborted();
      const file: ConflictFile = {
        path: filePath,
        mode: stage['2']?.mode ?? '',
        base: '',
        ours: '',
        theirs: '',
        original: '',
        result: '',
        resolved: false,
        source: 'manual',
      };
      try {
        if (unsupportedPaths.has(filePath))
          throw new Error('This conflict needs a local merge tool (rename, deletion, or repository structure).');
        const ancestor = stage['1'],
          ours = stage['2'],
          theirs = stage['3'];
        if (
          !ancestor ||
          !ours ||
          !theirs ||
          ![ancestor, ours, theirs].every((s) => /^100(644|755)$/.test(s.mode)) ||
          new Set([ancestor, ours, theirs].map((s) => s.mode)).size > 1
        )
          throw new Error(
            'This is a rename, deletion, binary, or file-mode conflict. Resolve it with a local merge tool.'
          );
        const listing = (await git(ctx, id, ['ls-tree', '-z', tree, '--', filePath], signal)).stdout.toString('utf8');
        const match = /^(100(?:644|755)) blob ([a-f0-9]+)\t/.exec(listing);
        if (!match) throw new Error('This file cannot be resolved as a text conflict.');
        file.mode = match[1];
        [file.base, file.ours, file.theirs, file.original] = await Promise.all(
          [ancestor.sha, ours.sha, theirs.sha, match[2]].map((sha) => blob(ctx, id, sha, signal))
        );
        bytes += [file.base, file.ours, file.theirs, file.original].reduce(
          (total, text) => total + Buffer.byteLength(text),
          0
        );
        if (bytes > 12 * 1024 * 1024) throw new Error('The conflict session exceeds the text limit.');
        if (!hasConflictMarkers(file.original))
          throw new Error('This conflict requires file-level resolution in a local merge tool.');
        file.result = file.original;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.message.startsWith('Git could not')) throw error;
        file.unsupported = error instanceof Error ? error.message : String(error);
        file.base = file.ours = file.theirs = file.original = file.result = '';
      }
      files.push(file);
    }
    if (merge.code === 1 && !files.length)
      throw new Error('Git reported a repository-level conflict. Resolve it with a local merge tool.');
    return files;
  }
  /** Applies resolutions remembered from earlier publications in this repository. They still need review. */
  async function remember(ctx: Context, headRepo: string, files: ConflictFile[], signal: AbortSignal) {
    const remembered = await memory.apply(memoryScope({ account: ctx.account, headRepo }), files, signal);
    for (const file of files) {
      const contents = remembered.get(file.path);
      if (contents !== undefined) {
        const proposals = blockProposals(file.original, contents, 'rerere');
        file.result = proposals ? withProposals(file.original, proposals) : contents;
        if (proposals) file.proposals = proposals;
        file.source = 'rerere';
        file.explanation =
          'Git reused a resolution you previously reviewed in this repository. Check it in this PR context before marking the file reviewed.';
      }
    }
    return files;
  }
  /**
   * Checks each file's proposals that have no verdict for their current fingerprint, one file at a time. A file without
   * proposals drops its verdict. True when any verdict changed.
   */
  async function check(files: ConflictFile[], signal: AbortSignal, report: (text: string) => void = () => {}) {
    if (!deps.verify) return false;
    let changed = false;
    const disabled = deps.disabledLanguages?.() ?? [];
    const due: { file: ConflictFile; key: string }[] = [];
    for (const file of files) {
      if (file.unsupported || (!file.proposals && !file.wholeFile)) {
        if (file.verdict) changed = true;
        delete file.verdict;
        continue;
      }
      // A copy: proposalKey remembers its answer per object, and these files change in place.
      const key = verdictKey({ ...file }, disabled);
      if (file.verdict?.key !== key) due.push({ file, key });
    }
    if (due.length) report(`Checking ${due.length} ${due.length === 1 ? 'file' : 'files'}.`);
    for (const { file, key } of due) {
      signal.throwIfAborted();
      let verdict = await deps.verify(file, disabled);
      // A same-change proposal the checks didn't confirm is taken back (src/conflict-checks.ts); checked again once.
      const back = withoutUnconfirmed(file, verdict);
      if (back) {
        Object.assign(file, back);
        verdict = file.proposals ? await deps.verify(file, disabled) : undefined;
      }
      if (verdict) file.verdict = { key: back ? verdictKey({ ...file }, disabled) : key, verdict };
      else delete file.verdict;
      changed = true;
    }
    return changed;
  }
  /** Structural merge of one file's three versions. Exit code 1 means some conflicts remain in the output. */
  async function mergiraf(
    ctx: Context,
    id: string,
    branches: { head: string; base: string },
    file: ConflictFile,
    signal: AbortSignal,
    timeout = 10_000
  ) {
    const parent = await directory(ctx.account, id);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const temp = await fs.mkdtemp(path.join(parent, 'mergiraf-'));
    try {
      const names = ['base', 'ours', 'theirs'].map((name) => path.join(temp, name));
      await Promise.all(
        names.map((name, i) => fs.writeFile(name, [file.base, file.ours, file.theirs][i], { mode: 0o600 }))
      );
      const result = await runConflictProcess(
        deps.mergiraf(),
        [
          'merge',
          ...names,
          `--path-name=${file.path}`,
          '--timeout',
          String(timeout),
          '--base-name',
          'Common ancestor',
          `--left-name=${branches.head}`,
          `--right-name=${branches.base}`,
        ],
        { cwd: temp, signal, timeout: timeout * 2 }
      );
      if (result.code > 1) throw new Error('Mergiraf could not resolve this file. Use the manual editor or an agent.');
      const output = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
      if (Buffer.byteLength(output) > CONFLICT_FILE_LIMIT) throw new Error('The proposed result is too large.');
      return output;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  /**
   * Runs structural merge on every text conflict that your earlier resolutions did not settle, a few files at a time.
   * Each conflict it resolves becomes a proposal. A result that also changes lines outside the conflicts is kept whole,
   * for you to check. A file that runs out of time gets one more try on its own, with the Suggest budget. Any file it
   * still fails on stays as Git wrote it, with a note that says why.
   */
  async function mergeStructurally(
    ctx: Context,
    id: string,
    branches: { head: string; base: string },
    files: ConflictFile[],
    signal: AbortSignal,
    report: (text: string) => void,
    /** Store what it proposes beside the draft, without applying it: the draft may be your own. */
    keepDraft = false
  ) {
    const queue = files.filter((file) => !file.unsupported && file.source !== 'rerere');
    if (!queue.length) return files;
    // A development build without `npm run prepare:mergiraf` has no binary: the conflicts stay as Git wrote them.
    if (!(await exists(deps.mergiraf()))) {
      for (const file of queue) file.structuralNote = 'Structural merge isn’t available in this build.';
      return files;
    }
    // A note from an earlier try (no binary, out of time) gives way to this one.
    for (const file of queue) delete file.structuralNote;
    report(`Combining both sides’ changes in ${queue.length} ${queue.length === 1 ? 'file' : 'files'}.`);
    /** Keeps what structural merge proposed for one file. False when it ran out of time. */
    const propose = async (file: ConflictFile, budget: number) => {
      const started = Date.now();
      let output: string;
      try {
        output = await mergiraf(ctx, id, branches, file, signal, budget);
      } catch (error) {
        signal.throwIfAborted();
        console.warn(`[conflicts] Structural merge skipped ${file.path}.`, error);
        if (error instanceof Error && error.message.startsWith('The operation timed out')) return false;
        file.structuralNote = 'Structural merge couldn’t combine this file.';
        file.structuralRan = true;
        return true;
      }
      // Out of time, Mergiraf falls back to Git's line merge and says nothing: whatever it printed is not its merge.
      if (Date.now() - started >= budget) return false;
      const merged = blockProposals(file.original, output, 'mergiraf');
      const whole = !merged && !hasConflictMarkers(output);
      // Where it left a conflict open and both sides only added lines there, both additions (lib/conflict-union.ts).
      const proposals = whole ? undefined : withUnions(file.path, file.original, merged);
      if (proposals) {
        file.proposals = proposals;
        if (!keepDraft) {
          file.result = withProposals(file.original, proposals);
          file.source = 'mergiraf';
        }
      } else if (whole) file.wholeFile = { source: 'mergiraf', text: output };
      // Only a file with no proposal at all gets the note: "Try structural merge again" never replaces unions.
      else file.structuralNote = 'Structural merge couldn’t combine this file.';
      file.structuralRan = true;
      return true;
    };
    const [first, retry, cap] = deps.structuralTimeouts ?? [5000, 10_000, 30_000];
    /** Four files at a time. A file that runs out of time goes on `late`. */
    const pool = async (files: ConflictFile[], budget: () => number, late: ConflictFile[]) => {
      const work = async () => {
        for (let file = files.shift(); file; file = files.shift())
          if (budget() <= 0 || !(await propose(file, budget()))) late.push(file);
      };
      await Promise.all([work(), work(), work(), work()]);
    };
    const late: ConflictFile[] = [];
    await pool(queue, () => first, late);
    // One more try each with the Suggest budget, within a total limit, so many slow files cannot hold up opening.
    const deadline = Date.now() + cap;
    const failed: ConflictFile[] = [];
    await pool(late, () => Math.min(retry, deadline - Date.now()), failed);
    for (const file of failed) {
      console.warn(`[conflicts] Structural merge timed out on ${file.path}.`);
      file.structuralNote = 'Structural merge timed out.';
    }
    return files;
  }
  async function preparation(
    ctx: Context,
    id: string,
    prepared: Prepared,
    files: ConflictFile[],
    revisions: { headSha: string; baseSha: string },
    signal: AbortSignal
  ): Promise<ConflictSession['preparation']> {
    if (files.length) return 'conflicts';
    // A shallow cache has no history to walk, but the merge base answers the same question.
    const containsBase = prepared.mergeBase
      ? prepared.mergeBase === revisions.baseSha
      : (
          await git(
            ctx,
            id,
            ['merge-base', '--is-ancestor', revisions.baseSha, revisions.headSha],
            signal,
            undefined,
            [0, 1]
          )
        ).code === 0;
    return containsBase ? 'up-to-date' : 'clean-merge';
  }
  /** A three-way merge of plain text. Undefined when the two edits overlap. */
  async function mergeText(dir: string, ours: string, base: string, theirs: string, signal: AbortSignal) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = await fs.mkdtemp(path.join(dir, 'carry-'));
    try {
      const names = ['ours', 'base', 'theirs'];
      await Promise.all(
        names.map((name, i) => fs.writeFile(path.join(temp, name), [ours, base, theirs][i], { mode: 0o600 }))
      );
      const result = await runGit(temp, ['merge-file', '-p', ...names], signal, {
        allowed: Array.from({ length: 256 }, (_, i) => i),
      });
      if (result.code !== 0) return undefined;
      return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    } catch (error) {
      signal.throwIfAborted();
      console.warn('[conflicts] Could not carry a resolution as text.', error);
      return undefined;
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  /**
   * Moves the user's resolutions onto a fresh merge. Blocks whose conflict text is unchanged reuse the user's result.
   * When the user also edited lines around the blocks, a text merge keeps those edits. Files that no longer conflict
   * drop out: Git merged them cleanly.
   */
  async function carryFiles(
    dir: string,
    previous: ConflictFile[],
    files: ConflictFile[],
    keepReview: boolean,
    signal: AbortSignal
  ) {
    const byPath = new Map(previous.map((file) => [file.path, file]));
    const carried: ConflictFile[] = [];
    const reopened: string[] = [];
    let conflicts = 0;
    for (const next of files) {
      signal.throwIfAborted();
      const old = byPath.get(next.path);
      let result = carryFile(old, next, keepReview);
      if (!result.mapped && old && !old.unsupported && !next.unsupported && !hasConflictMarkers(old.result)) {
        const merged = await mergeText(
          dir,
          old.result,
          relabelMarkers(old.original, next.original),
          next.original,
          signal
        );
        if (merged !== undefined) {
          const open = conflictCount(merged);
          result = {
            // A text merge of the whole file: its blocks no longer line up with the fresh proposals.
            file: { ...withResult(old, next, merged, keepReview && open === 0 && old.resolved), proposals: undefined },
            reused: conflictCount(next.original) - open,
            open,
            mapped: true,
          };
        }
      }
      // Nothing carried over: keep the fresh merge, with any remembered resolution.
      const file = result.reused ? result.file : { ...next, resolved: false };
      carried.push(file);
      if (!file.resolved) {
        reopened.push(file.path);
        conflicts += file.unsupported ? 1 : Math.max(result.reused ? result.open : conflictCount(next.original), 1);
      }
    }
    return { files: carried, reopened, conflicts };
  }
  /**
   * The base branch moved but the PR did not. Merge the new base commit again, reuse the user's resolutions, and stop
   * once a fresh read of the PR shows the same base. A base that keeps moving fails after a few rounds.
   */
  async function followBase(
    ctx: Context,
    session: ConflictSession,
    state: PrActionState,
    signal: AbortSignal,
    report: (text: string) => void
  ): Promise<BaseMove> {
    const from = session.baseSha;
    const previous = session.files;
    let live = state;
    for (let round = 0; round < BASE_MOVE_ROUNDS; round++) {
      if (!oid(live.baseSha)) throw new Error('GitHub has not returned the branch revisions yet.');
      report(`${session.baseBranch} moved. Merging its latest commit and reusing your resolutions.`);
      const spec: MergeSpec = {
        headRepo: session.headRepo,
        baseRepo: session.baseRepo,
        headSha: session.headSha,
        baseSha: live.baseSha,
        headBranch: session.headBranch,
        baseBranch: session.baseBranch,
      };
      const prepared = await prepare(ctx, session.id, spec, signal, report);
      const fresh = await conflictFiles(ctx, session.id, prepared, signal);
      // A file whose conflicts are the same as before keeps its proposals. Every other file gets them again, so a
      // conflict the carry cannot reuse takes the fresh proposal and the draft and its proposals describe the same
      // blocks.
      const before = new Map(previous.map((file) => [file.path, file]));
      const changed = fresh.filter((file) => {
        const old = before.get(file.path);
        if (!old || old.unsupported || file.unsupported || conflictKeys(old.original) !== conflictKeys(file.original))
          return true;
        // A whole-file proposal covers every line, and a note describes one run on these versions: both carry only
        // when the file's three versions are the same. Otherwise structural merge runs again.
        if (old.wholeFile || old.structuralNote) {
          if (old.base !== file.base || old.ours !== file.ours || old.theirs !== file.theirs) return true;
          file.wholeFile = old.wholeFile;
          file.structuralNote = old.structuralNote;
        }
        file.structuralRan = old.structuralRan;
        if (old.proposals) {
          file.proposals = old.proposals;
          file.result = withProposals(file.original, old.proposals);
          file.source = old.source;
        }
        return false;
      });
      await remember(ctx, session.headRepo, changed, signal);
      await mergeStructurally(
        ctx,
        session.id,
        { head: session.headBranch, base: session.baseBranch },
        changed,
        signal,
        report
      );
      const carried = await carryFiles(await directory(ctx.account, session.id), previous, fresh, true, signal);
      session.baseSha = live.baseSha;
      session.tree = prepared.tree;
      session.files = carried.files;
      await check(session.files, signal, report);
      session.preparation = await preparation(ctx, session.id, prepared, carried.files, session, signal);
      live = (await current(session, ctx)).state;
      if (live.baseSha === session.baseSha)
        return { from, to: session.baseSha, conflicts: carried.conflicts, files: carried.reopened };
    }
    throw new Error(BASE_KEEPS_MOVING);
  }
  async function open(
    ctx: Context,
    url: string,
    restart: boolean,
    keep: boolean,
    signal: AbortSignal,
    report: (text: string) => void,
    /** Prepared in the background (src/conflict-precompute.ts): hears the number of conflicted files once known. */
    background?: (files: number) => void
  ) {
    const state = await deps.read(url);
    signal.throwIfAborted();
    assertAccount(ctx);
    if (
      state.account !== ctx.account ||
      !state.headRepo ||
      !state.canUpdateBranch ||
      state.archived ||
      state.state !== 'OPEN'
    )
      throw new Error(NO_PERMISSION);
    if (!oid(state.headSha) || !oid(state.baseSha))
      throw new Error('GitHub has not returned the branch revisions yet.');
    const id = hash(url);
    const saved = deps.storage.read(storageKey(ctx.account, id)) as ConflictSession | undefined;
    // A background draft counts only for the revisions it was prepared on. Your own draft, or a push still to restack,
    // is never replaced in the background.
    const current = !!saved && revisionChange(saved, state) === 'none';
    if (background && saved && (saved.background ? current : saved.status !== 'published' || !!saved.restack))
      return saved;
    if (background || (saved?.background && !current)) {
      restart = true;
      keep = false;
    }
    // Recover a successful atomic restack push whose response or local persistence was interrupted, before anything
    // decides what to show, so the history below says truthfully whether dependent PRs were restacked.
    let recovered = false;
    const pendingRestack = saved?.status === 'published' ? saved.restack : undefined;
    if (pendingRestack?.status === 'prepared') {
      const urls = pendingRestack.branches.map((branch) => branch.url);
      const states = await settleInOrder(deps.readMany ? deps.readMany(urls) : urls.map((u) => deps.read(u)));
      assertAccount(ctx);
      recovered =
        states.length > 0 &&
        states.every(
          (value, index) =>
            value.account === ctx.account &&
            value.headRepo === pendingRestack.branches[index].repo &&
            value.headBranch === pendingRestack.branches[index].branch &&
            value.headSha === pendingRestack.branches[index].newSha
        );
      if (recovered) pendingRestack.status = 'published';
    }
    const published = !restart && saved?.status === 'published' ? saved : undefined;
    // GitHub reports conflicts again (main moved): prepare afresh, whatever state a restack is in. The push stays history.
    const conflictsAgain = !!published && hasMergeConflicts(state);
    if (
      published?.restack &&
      !conflictsAgain &&
      published.restack.status !== 'published' &&
      (published.commitSha !== state.headSha || published.headBranch !== state.headBranch || published.headRepo !== state.headRepo)
    ) {
      return { ...published, stale: true };
    }
    const dependents = deps.dependents?.(url) ?? [];
    // Dependent PRs that a push left to restack: the published screen offers that next.
    const leftToRestack = (pushed: ConflictSession) =>
      pushed.restack?.status === 'published'
        ? []
        : pushed.restack?.branches.length
          ? pushed.restack.branches.map((branch) => branch.url)
          : dependents;
    const restackPending = !!published && (published.restack ? published.restack.status !== 'published' : !!dependents.length);
    const pushedHead = !!published && !conflictsAgain && published.commitSha === state.headSha;
    // A push finished in an earlier session is history, not a result to show again: the published record, or the
    // `lastPush` of a preparation made while GitHub was still computing. Clean now: say so, with the push as history.
    // Still computing: prepare afresh below so Git answers, keeping the push in `lastPush`.
    const history: ConflictSession['lastPush'] =
      pushedHead && !restackPending && !recovered && published?.commitSha
        ? { commitSha: published.commitSha, headSha: published.headSha }
        : !restart && saved?.status === 'editing' && !saved.files.length ? saved.lastPush : undefined;
    if (saved && history?.commitSha === state.headSha && state.mergeable === 'MERGEABLE' && !hasMergeConflicts(state))
      return { ...saved, dependents, reopened: true, lastPush: history };
    // The push, or the restack push just recovered, is this session's result: show it.
    if (
      !restart &&
      !conflictsAgain &&
      (!pushedHead || restackPending || recovered) &&
      saved?.commitSha === state.headSha
    ) {
      saved.status = 'published';
      saved.dependents = dependents;
      await persist(saved);
      return saved;
    }
    // New base commits alone leave the draft usable: preview and publish merge them again.
    if (saved?.status === 'editing' && !restart && saved.files.length > 0) {
      const change = revisionChange(saved, state);
      if (change === 'head-moved' || change === 'retargeted') return { ...saved, stale: true, staleReason: change };
      // Files that structural merge never gave a result (a draft from an older build, no binary, out of time) get the
      // pass on reopen, while the draft is still Git's conflict. It never changes the draft: what it finds is stored
      // beside it. A Suggest result or your own edit is left alone.
      const untried = saved.files.filter(
        (f) =>
          !f.structuralRan &&
          !f.resolved &&
          f.source === 'manual' &&
          f.result === f.original &&
          !f.proposals &&
          !f.wholeFile
      );
      if (untried.length)
        await mergeStructurally(
          ctx,
          id,
          { head: saved.headBranch, base: saved.baseBranch },
          untried,
          signal,
          report,
          true
        );
      // A draft saved before the main process checked proposals, or by a build without the checks, gets them now.
      if ((await check(saved.files, signal, report)) || untried.length) {
        signal.throwIfAborted();
        assertAccount(ctx);
        saved.version++;
        await persist(saved);
      }
      return { ...saved, stale: false };
    }
    const prepared = await prepare(
      ctx,
      id,
      {
        headRepo: state.headRepo,
        baseRepo: state.repository,
        headSha: state.headSha,
        baseSha: state.baseSha,
        headBranch: state.headBranch,
        baseBranch: state.baseBranch,
      },
      signal,
      report
    );
    const found = await conflictFiles(ctx, id, prepared, signal);
    background?.(found.length);
    let files = await mergeStructurally(
      ctx,
      id,
      { head: state.headBranch, base: state.baseBranch },
      await remember(ctx, state.headRepo, found, signal),
      signal,
      report
    );
    const { tree } = prepared;
    // Load latest changes keeps the resolutions whose conflicts did not change. New PR commits need a fresh review.
    if (keep && saved?.status === 'editing' && saved.files.length)
      files = (
        await carryFiles(
          await directory(ctx.account, id),
          saved.files,
          files,
          ['none', 'base-moved'].includes(revisionChange(saved, state)),
          signal
        )
      ).files;
    await check(files, signal, report);
    const session: ConflictSession = {
      id,
      account: ctx.account,
      url,
      title: state.title,
      headRepo: state.headRepo,
      baseRepo: state.repository,
      headBranch: state.headBranch,
      baseBranch: state.baseBranch,
      headSha: state.headSha,
      baseSha: state.baseSha,
      tree,
      files,
      version: (saved?.version ?? 0) + 1,
      status: 'editing',
      dependents,
      preparation: await preparation(ctx, id, prepared, files, state, signal),
      ...(background ? { background: Date.now() } : {}),
    };
    // The push a fresh preparation replaces, while it is still the PR head: its commit, undo point and restack.
    const unrestacked = saved?.status === 'published' ? leftToRestack(saved) : [];
    const lastPush: ConflictSession['lastPush'] =
      saved?.status === 'published' && saved.commitSha
        ? { commitSha: saved.commitSha, headSha: saved.headSha, ...(unrestacked.length ? { unrestacked } : {}) }
        : saved?.lastPush;
    // Kept while it is the PR head, and after someone pushed on top while dependent PRs still wait for a restack.
    if (lastPush && (lastPush.commitSha === state.headSha || lastPush.unrestacked?.length)) session.lastPush = lastPush;
    signal.throwIfAborted();
    assertAccount(ctx);
    await persist(session);
    return session;
  }
  /** Startup cleanup removes full-history caches of saved drafts. The merge is rebuilt here when it is needed. */
  async function restoreMerge(
    ctx: Context,
    session: ConflictSession,
    signal: AbortSignal,
    report: (text: string) => void
  ) {
    const dir = await directory(ctx.account, session.id);
    if (await exists(path.join(dir, 'HEAD'))) {
      const checks = await Promise.all(
        [session.tree, `${session.headSha}^{tree}`, `${session.baseSha}^{tree}`].map((object) =>
          git(ctx, session.id, ['cat-file', '-e', object], signal, undefined, [0, 1, 128], { lazyFetch: false })
        )
      );
      if (checks.every((result) => result.code === 0)) return;
    }
    report('Restoring this PR’s private Git cache.');
    const spec: MergeSpec = {
      headRepo: session.headRepo,
      baseRepo: session.baseRepo,
      headSha: session.headSha,
      baseSha: session.baseSha,
      headBranch: session.headBranch,
      baseBranch: session.baseBranch,
    };
    let prepared = await prepare(ctx, session.id, spec, signal, report);
    // Git computes its own merge bases on the full path; with several of them the result can differ.
    if (prepared.tree !== session.tree && prepared.mergeBase)
      prepared = await prepareFull(ctx, session.id, spec, signal, report);
    if (prepared.tree !== session.tree)
      throw new Error('The saved resolution no longer matches its revisions. Reopen the workspace and start again.');
  }
  /** Restack walks history. A shallow or removed cache fetches it first, as the full path always did. */
  async function restoreHistory(
    ctx: Context,
    session: ConflictSession,
    signal: AbortSignal,
    report: (text: string) => void
  ) {
    if (!session.commitSha || !oid(session.commitSha)) return;
    const dir = await directory(ctx.account, session.id);
    if (!(await exists(path.join(dir, 'HEAD')))) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await git(ctx, session.id, ['init', '--bare', '.'], signal);
      for (const [name, repo] of [
        ['pr', session.headRepo],
        ['base', session.baseRepo],
      ]) {
        await git(ctx, session.id, ['config', `remote.${name}.url`, remote(repo)], signal);
        await git(ctx, session.id, ['config', `remote.${name}.promisor`, 'true'], signal);
        await git(ctx, session.id, ['config', `remote.${name}.partialclonefilter`, 'blob:none'], signal);
      }
    }
    const shallow = await exists(path.join(dir, 'shallow'));
    const present =
      (
        await git(
          ctx,
          session.id,
          ['cat-file', '-e', `${session.commitSha}^{commit}`],
          signal,
          undefined,
          [0, 1, 128],
          {
            lazyFetch: false,
          }
        )
      ).code === 0;
    if (present && !shallow) return;
    report('Fetching the PR history for its dependent PRs.');
    await git(
      ctx,
      session.id,
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--filter=blob:none',
        ...(shallow ? ['--unshallow'] : []),
        'pr',
        session.commitSha,
      ],
      signal
    );
  }
  function assertReviewed(session: ConflictSession) {
    if (session.preparation === 'up-to-date')
      throw new Error('The PR already contains the base branch. No update is needed.');
    if (session.files.some((f) => !f.resolved || f.unsupported || hasConflictMarkers(f.result)))
      throw new Error('Resolve and mark every file reviewed before publishing.');
  }
  async function resultTree(
    ctx: Context,
    session: ConflictSession,
    signal: AbortSignal,
    report: (text: string) => void
  ) {
    assertReviewed(session);
    await restoreMerge(ctx, session, signal, report);
    await git(ctx, session.id, ['read-tree', session.tree], signal);
    for (const file of session.files) {
      const sha = (await git(ctx, session.id, ['hash-object', '-w', '--stdin'], signal, file.result)).stdout
        .toString()
        .trim();
      await git(ctx, session.id, ['update-index', '-z', '--index-info'], signal, `${file.mode} ${sha}\t${file.path}\0`);
    }
    return (await git(ctx, session.id, ['write-tree'], signal)).stdout.toString().trim();
  }
  let maintenance: Promise<unknown> = Promise.resolve();
  /**
   * Removes cache directories that no saved session needs, and store refs that no remaining session borrows. A store
   * without refs is removed whole. Full-history caches of drafts and published PRs go too: drafts rebuild their merge
   * from the shared store when they publish, and restacks fetch history again. Paused or prepared restacks keep theirs.
   */
  /** Background drafts beyond the newest `keep`, or older than a week, of every account: each with its account. */
  function staleBackground(keep: number) {
    const drafts: { name: string; account: string; id: string; at: number }[] = [];
    for (const name of deps.storage.names?.() ?? []) {
      const match = /^conflict-draft:(.*):([a-f0-9]{64})$/.exec(name);
      const saved = match ? (deps.storage.read(name) as ConflictSession | null | undefined) : undefined;
      if (match && saved?.background && !busy.has(name))
        drafts.push({ name, account: match[1], id: match[2], at: saved.background });
    }
    drafts.sort((a, b) => b.at - a.at);
    return drafts.filter((draft, i) => i >= keep || Date.now() - draft.at > BACKGROUND_AGE);
  }
  /** Removes a draft and its cache, as Discard does. */
  async function drop(account: string, id: string) {
    deps.storage.write(storageKey(account, id), null);
    await deps.storage.flush();
    const dir = await directory(account, id);
    await dropStoreRefs(account, id, dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
  /** Drops a background draft under the PR's lock, so no run or open interleaves. Skipped while the PR is busy. */
  async function dropBackground(account: string, id: string) {
    const key = storageKey(account, id);
    if (busy.has(key) || !(deps.storage.read(key) as ConflictSession | undefined)?.background) return;
    // A request of yours that comes meanwhile waits for the drop to finish; it is short.
    await asBackground(key, undefined, () => drop(account, id));
  }
  async function cleanUp(): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    if (!deps.storage.names) return { removed };
    // Their caches go below, with every other directory no saved session needs.
    const stale = staleBackground(deps.backgroundDrafts ?? BACKGROUND_DRAFTS);
    for (const { name } of stale) deps.storage.write(name, null);
    if (stale.length) await deps.storage.flush();
    const root = deps.directory();
    if (!(await exists(root))) return { removed };
    const keep = new Set<string>();
    const borrowed = new Map<string, Set<string>>();
    const busyDirectories = async () =>
      new Set(
        await Promise.all(
          [...busy].map(async (key) => {
            const [, account, id] = /^conflict-draft:(.*):([a-f0-9]{64})$/.exec(key) ?? [];
            return account && id ? directory(account, id) : '';
          })
        )
      );
    for (const name of deps.storage.names()) {
      const match = /^conflict-draft:(.*):([a-f0-9]{64})$/.exec(name);
      if (!match) continue;
      const saved = deps.storage.read(name) as ConflictSession | null | undefined;
      if (!saved || saved.account !== match[1] || saved.id !== match[2]) continue;
      const dir = await directory(saved.account, saved.id);
      const layout = await readSharedLayout(dir);
      const restacking = saved.restack?.status === 'prepared' || saved.restack?.status === 'blocked';
      if (!restacking && (saved.status !== 'editing' || !layout)) continue;
      keep.add(dir);
      if (layout) {
        const store = path.resolve(root, layout.store);
        borrowed.set(store, (borrowed.get(store) ?? new Set()).add(conflictStoreRefPrefix(saved.account, saved.id)));
      }
    }
    const candidates: string[] = [];
    const names = async (dir: string) =>
      (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^[a-f0-9]{64}$/.test(n));
    for (const name of await names(path.join(root, 'sessions'))) candidates.push(path.join(root, 'sessions', name));
    // Legacy layout: <account hash>/<PR hash>.
    for (const account of await names(root))
      for (const name of await names(path.join(root, account))) candidates.push(path.join(root, account, name));
    for (const dir of candidates) {
      if (keep.has(dir) || (await busyDirectories()).has(dir)) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    }
    for (const account of await names(root)) await fs.rmdir(path.join(root, account)).catch(() => {});
    const signal = new AbortController().signal;
    for (const name of await names(path.join(root, STORES_DIRECTORY))) {
      const store = path.join(root, STORES_DIRECTORY, name);
      await withStore(store, async () => {
        // A session that started since the scan may have just added refs; keep those of every busy session too.
        const live = new Set(borrowed.get(store));
        for (const key of busy) {
          const [, account, id] = /^conflict-draft:(.*):([a-f0-9]{64})$/.exec(key) ?? [];
          if (account && id) live.add(conflictStoreRefPrefix(account, id));
        }
        const refs = (await runGit(store, ['for-each-ref', '--format=%(refname)', 'refs/gnosis/'], signal)).stdout
          .toString('utf8')
          .split('\n')
          .filter(Boolean);
        const stale = refs.filter((ref) => ![...live].some((prefix) => ref.startsWith(prefix)));
        if (stale.length === refs.length && !live.size) {
          await fs.rm(store, { recursive: true, force: true });
          removed.push(store);
        } else if (stale.length)
          await runGit(store, ['update-ref', '--stdin'], signal, {
            input: stale.map((ref) => `delete ${ref}\n`).join(''),
          });
      });
    }
    return { removed };
  }
  return {
    /**
     * Prepares a PR's conflicts in the background: fetch, merge, earlier resolutions, structural merge and the checks,
     * saved as a background draft. Leaves your own draft alone. Undefined while another operation runs for the PR.
     */
    async prepareInBackground(url: string, signal: AbortSignal, files: (count: number) => void = () => {}) {
      const ctx = deps.context();
      if (!ctx.token || !ctx.account) throw new Error('Connect GitHub before resolving conflicts.');
      const key = storageKey(ctx.account, hash(url));
      // Your draft, or a push still to restack: nothing to do, before any work. open() keeps the full rule.
      const saved = deps.storage.read(key) as ConflictSession | undefined;
      if (saved && !saved.background && (saved.status === 'editing' || saved.restack)) return saved;
      if (busy.has(key)) return undefined;
      return asBackground(key, signal, async (yielding) => {
        await maintenance;
        return open(ctx, url, false, false, yielding, () => {}, files);
      });
    },
    /** The saved draft for this PR head, while it is being edited: a background one or yours. */
    draft(url: string, headSha: string) {
      const ctx = deps.context();
      if (!ctx.account) return undefined;
      const saved = deps.storage.read(storageKey(ctx.account, hash(url))) as ConflictSession | undefined;
      return saved?.status === 'editing' && saved.headSha === headSha && saved.files.length ? saved : undefined;
    },
    /** Removes a background draft (the PR moved or merges cleanly now). Your own draft is never removed. */
    async forgetBackground(url: string) {
      const account = deps.context().account;
      if (account) await dropBackground(account, hash(url));
    },
    /** Keeps the newest background drafts, of every account, and removes the others with their caches. */
    async trimBackground(keep = deps.backgroundDrafts ?? BACKGROUND_DRAFTS) {
      for (const { account, id } of staleBackground(keep)) await dropBackground(account, id);
    },
    /** Run once after saved data loads. Conflict requests wait for it. */
    maintain() {
      const task = cleanUp();
      maintenance = task.catch((error: unknown) => console.warn('[conflicts] Cache cleanup failed.', error));
      return task;
    },
    async run(
      request: ConflictRequest,
      signal: AbortSignal,
      report: (text: string) => void = () => {}
    ): Promise<ConflictReply> {
      validateConflictRequest(request);
      signal.throwIfAborted();
      const ctx = deps.context();
      if (!ctx.token || !ctx.account) throw new Error('Connect GitHub before resolving conflicts.');
      const id = request.kind === 'open' ? hash(request.url) : request.id;
      const key = storageKey(ctx.account, id);
      // Background work on this PR stops for you; only another request of yours makes this one wait.
      await yieldToYou(key);
      if (busy.has(key)) throw new Error('A conflict operation is already running for this PR.');
      busy.add(key);
      try {
        // Cleanup checks `busy` before each removal; a request that starts later waits for it to finish.
        await maintenance;
        if (request.kind === 'open') {
          const session = await open(ctx, request.url, !!request.restart, !!request.keep, signal, report);
          // A draft prepared in the background becomes yours once you open it: it is no longer replaced or evicted.
          const stored = deps.storage.read(key) as ConflictSession | undefined;
          if (stored?.background) {
            delete stored.background;
            await persist(stored);
          }
          delete session.background;
          return { session };
        }
        const session = sessionFor(ctx, id);
        if (request.version !== session.version)
          throw new Error('The saved resolution changed. Reopen the workspace before continuing.');
        if (
          request.kind === 'restack-prepare' ||
          request.kind === 'restack-publish' ||
          request.kind === 'restack-save' ||
          request.kind === 'restack-continue'
        ) {
          if (session.status !== 'published')
            throw new Error('Publish this PR’s conflict resolution before restacking its dependents.');
          const restackDeps = {
            git: (args: string[], input?: string, allowed?: number[], overrideSignal?: AbortSignal) =>
              git(ctx, id, args, overrideSignal ?? signal, input, allowed),
            read: deps.read,
            readMany: deps.readMany,
            directory: await directory(ctx.account, id),
            remote,
            signal,
            report,
          };
          if (request.kind === 'restack-prepare') {
            if (session.restack?.status === 'blocked')
              await git(
                ctx,
                id,
                [
                  'worktree',
                  'remove',
                  '--force',
                  await restackWorktreePath(await directory(ctx.account, id), session.restack.token),
                ],
                signal,
                undefined,
                [0, 128]
              );
            // A failed preparation must not leave an older plan publishable.
            session.restack = undefined;
            await persist(session);
            await restoreHistory(ctx, session, signal, report);
            session.dependents = deps.dependents?.(session.url) ?? [];
            await memory.record(memoryScope(session), session.files, signal);
            session.restack = await memory.withRepository(memoryScope(session), await directory(ctx.account, id), () =>
              prepareRestack(session, session.dependents ?? [], restackDeps)
            );
          } else if (request.kind === 'restack-save') {
            const file = session.restack?.blocked?.files.find((file) => file.path === request.path);
            if (
              session.restack?.status !== 'blocked' ||
              !file ||
              file.unsupported ||
              Buffer.byteLength(request.contents) > CONFLICT_FILE_LIMIT
            )
              throw new Error('This paused file cannot be edited.');
            if (request.resolved && hasConflictMarkers(request.contents))
              throw new Error('Remove the remaining conflict markers first.');
            file.result = request.contents;
            file.resolved = request.resolved;
          } else if (request.kind === 'restack-continue') {
            if (session.restack?.status !== 'blocked') throw new Error('No restack is paused.');
            await memory.record(memoryScope(session), session.restack.blocked?.files ?? [], signal);
            session.restack = await memory.withRepository(memoryScope(session), await directory(ctx.account, id), () =>
              prepareRestack(session, session.dependents ?? [], restackDeps, true)
            );
          } else {
            if (
              !session.restack ||
              session.restack.branches.some((branch) => !request.reviewed.includes(branch.url)) ||
              new Set(request.reviewed).size !== session.restack.branches.length
            )
              throw new Error('Review every dependent PR update before pushing.');
            await publishRestack(session, request.previewToken, restackDeps);
          }
          assertAccount(ctx);
          session.version++;
          await persist(session);
          return { session };
        }
        if (session.status !== 'editing')
          throw new Error('This resolution has already been published. Refresh the PR.');
        let baseMoved: BaseMove | undefined;
        if (request.kind === 'discard') {
          await drop(ctx.account, id);
          return { session };
        }
        if (request.kind === 'save') {
          const file = session.files.find((f) => f.path === request.path);
          if (
            !file ||
            file.unsupported ||
            typeof request.contents !== 'string' ||
            Buffer.byteLength(request.contents) > CONFLICT_FILE_LIMIT
          )
            throw new Error('This file cannot be saved in the conflict editor.');
          if (request.resolved && hasConflictMarkers(request.contents))
            throw new Error('Remove the remaining conflict markers first.');
          if (file.result !== request.contents) {
            file.source = 'manual';
            file.explanation = undefined;
          }
          file.result = request.contents;
          file.resolved = request.resolved;
        } else if (request.kind === 'resolve') {
          if (!['mergiraf', 'agent'].includes(request.engine) || (request.instructions?.length ?? 0) > 10000)
            throw new Error('Invalid resolution request.');
          const files = session.files.filter((f) => !f.unsupported && f.path === request.path);
          if (!files.length) throw new Error('Select an unresolved text file.');
          for (const file of files) {
            report(`Proposing a resolution for ${file.path}.`);
            if (request.engine === 'agent') {
              if (file.base.length + file.ours.length + file.theirs.length > 220_000)
                throw new Error('This file is too large for agent context. Use the manual editor.');
              const result = await deps.suggest({ session, file, instructions: request.instructions ?? '' }, signal);
              if (result.contents !== undefined) {
                if (typeof result.contents !== 'string' || Buffer.byteLength(result.contents) > CONFLICT_FILE_LIMIT)
                  throw new Error('The agent returned an invalid file.');
                file.result = result.contents;
              }
              file.explanation = result.explanation;
            } else {
              // Preparation already ran Mergiraf on these three versions and kept its whole-file result. Otherwise it
              // runs again on request, with the full budget, not the first try's.
              let output = file.wholeFile?.text;
              if (output === undefined) {
                const budget = Math.max(...(deps.structuralTimeouts ?? [5000, 10_000, 30_000]).slice(1));
                const started = Date.now();
                try {
                  output = await mergiraf(
                    ctx,
                    id,
                    { head: session.headBranch, base: session.baseBranch },
                    file,
                    signal,
                    budget
                  );
                } catch (error) {
                  signal.throwIfAborted();
                  if (!(error instanceof Error && error.message.startsWith('The operation timed out'))) throw error;
                }
                // Out of time, Mergiraf falls back to Git's line merge and says nothing, as in mergeStructurally: that
                // output is not its merge. The draft stays as it was, and the note says so.
                if (output === undefined || Date.now() - started >= budget) {
                  file.structuralNote = 'Structural merge timed out again.';
                  continue;
                }
              }
              file.result = output;
              file.explanation = hasConflictMarkers(file.result)
                ? 'Mergiraf left conflicts that need your input.'
                : 'Mergiraf proposed a result. Review it before marking the file reviewed.';
            }
            file.source = request.engine;
            // The draft is a whole-file suggestion now: it no longer derives from the per-conflict proposals. A
            // whole-file proposal stays, so Reset file returns to it.
            delete file.proposals;
            delete file.structuralNote;
            file.resolved = false;
          }
        } else {
          const digestOf = (tree: string) =>
            hash(`${session.id}:${session.version}:${tree}:${session.headSha}:${session.baseSha}`);
          /** Merges new base commits again. With new conflicts, the user resolves them before anything is pushed. */
          const follow = async (state: PrActionState) => {
            const moved = await followBase(ctx, session, state, signal, report);
            session.version++;
            await persist(session);
            return moved;
          };
          if (request.kind === 'preview') {
            assertReviewed(session);
            const { state, change } = await current(session, ctx);
            const baseMoved = change === 'base-moved' ? await follow(state) : undefined;
            if (baseMoved?.conflicts) return { session, baseMoved };
            const tree = await resultTree(ctx, session, signal, report);
            const patch = (
              await git(ctx, id, ['diff', '--no-ext-diff', '--no-textconv', '--binary', session.headSha, tree], signal)
            ).stdout.toString('utf8');
            const validation = await git(
              ctx,
              id,
              ['diff', '--check', session.headSha, tree],
              signal,
              undefined,
              [0, 2]
            );
            const { parsePatchFiles } = await import('@pierre/diffs');
            return {
              session,
              ...(baseMoved ? { baseMoved } : {}),
              preview: {
                patch,
                token: digestOf(tree),
                validation: validation.stdout.toString('utf8'),
                files: parsePatchFiles(patch).flatMap((p) => p.files),
              },
            };
          }
          // The token proves the user reviewed this draft, so it is checked against the draft as previewed.
          let tree = await resultTree(ctx, session, signal, report);
          if (
            request.previewToken !== digestOf(tree) ||
            typeof request.message !== 'string' ||
            !request.message.trim() ||
            request.message.length > 2000
          )
            throw new Error('Review the complete resolution and enter a commit message before publishing.');
          report('Checking revisions before updating the PR branch.');
          const { state, change } = await current(session, ctx);
          if (change === 'base-moved') {
            // The user's resolutions are unchanged; only commits from the base branch are added to the merge.
            baseMoved = await follow(state);
            if (baseMoved.conflicts) return { session, baseMoved };
            tree = await resultTree(ctx, session, signal, report);
          }
          await memory.record(memoryScope(session), session.files, signal);
          const sha = (
            await git(
              ctx,
              id,
              [
                '-c',
                `user.name=${ctx.account}`,
                '-c',
                `user.email=${ctx.account}@users.noreply.github.com`,
                'commit-tree',
                tree,
                '-p',
                session.headSha,
                '-p',
                session.baseSha,
              ],
              signal,
              request.message.trim() + '\n'
            )
          ).stdout
            .toString()
            .trim();
          assertAccount(ctx);
          // Record the proposed commit before the network write, so reopen can recover an interrupted response.
          session.commitSha = sha;
          await persist(session);
          // A lease checks the exact original head. The new commit has that head as its first parent.
          await git(
            ctx,
            id,
            [
              'push',
              '--porcelain',
              `--force-with-lease=refs/heads/${session.headBranch}:${session.headSha}`,
              remote(session.headRepo),
              `${sha}:refs/heads/${session.headBranch}`,
            ],
            signal
          );
          session.status = 'published';
          session.commitSha = sha;
        }
        if (session.status !== 'published') {
          // Only the file a request changed: Suggest drops its proposals, and a save changes the draft the per-conflict
          // checks read (proposalKey includes it). Checks of an unchanged key are skipped.
          if (request.kind === 'resolve' || request.kind === 'save')
            await check(
              session.files.filter((f) => !request.path || f.path === request.path),
              signal,
              report
            );
          signal.throwIfAborted();
          assertAccount(ctx);
        }
        session.version++;
        await persist(session);
        return { session, ...(baseMoved ? { baseMoved } : {}) };
      } finally {
        busy.delete(key);
      }
    },
  };
}
