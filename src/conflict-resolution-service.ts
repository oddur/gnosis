import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  CONFLICT_FILE_LIMIT,
  hasConflictMarkers,
  validateConflictRequest,
  type ConflictFile,
  type ConflictSession,
  type ConflictRequest,
  type ConflictReply,
} from '../lib/conflict-resolution';
import type { StateStorage } from './app-data-store';
import type { PrActionState } from '../lib/pr-actions';
import { runConflictProcess } from './conflict-process';
import { createConflictMemory } from './conflict-rerere';
import { prepareRestack, publishRestack, restackWorktreePath } from './conflict-restack';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const oid = (value: string) => /^[a-f0-9]{40,64}$/.test(value);
const repoName = (value: string) => /^[\w.-]+\/[\w.-]+$/.test(value);
interface Context {
  account: string;
  token: string;
}
interface Deps {
  storage: StateStorage;
  directory: () => string;
  context: () => Context;
  read: (url: string) => Promise<PrActionState>;
  mergiraf: () => string;
  suggest: (
    context: { session: ConflictSession; file: ConflictFile; instructions: string },
    signal: AbortSignal
  ) => Promise<{ contents?: string; explanation: string }>;
  /** Tests use local bare remotes. Production only constructs github.com URLs. */
  remote?: (repo: string) => string;
  dependents?: (url: string) => string[];
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
  async function git(
    ctx: Context,
    id: string,
    args: string[],
    signal: AbortSignal,
    input?: string | Buffer,
    allowed = [0]
  ) {
    assertAccount(ctx);
    // Isolate user/system Git config: no credential helper, hooks or custom merge driver can execute.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const env = {
      ...inherited,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${ctx.token}`).toString('base64')}`,
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
      { cwd: await directory(ctx.account, id), env, input, signal, timeout: 180_000 }
    );
    if (!allowed.includes(result.code)) {
      const safe = result.stderr.replaceAll(ctx.token, '[redacted]').replace(/AUTHORIZATION:[^\r\n]*/gi, '[redacted]');
      throw new Error(`Git could not complete this operation. ${safe.slice(0, 1500)}`);
    }
    return result;
  }
  async function current(session: ConflictSession, ctx: Context) {
    const state = await deps.read(session.url);
    assertAccount(ctx);
    if (state.account !== ctx.account || state.state !== 'OPEN' || state.archived || !state.canUpdateBranch)
      throw new Error('You cannot update this PR branch with the connected account.');
    if (
      state.headSha !== session.headSha ||
      state.baseSha !== session.baseSha ||
      state.headRepo !== session.headRepo ||
      state.headBranch !== session.headBranch ||
      state.baseBranch !== session.baseBranch ||
      state.repository !== session.baseRepo
    )
      throw new Error(
        'The PR or its base branch changed. Reopen the workspace and start a new resolution before publishing.'
      );
    return state;
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
  async function open(
    ctx: Context,
    url: string,
    restart: boolean,
    signal: AbortSignal,
    report: (text: string) => void
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
      throw new Error('You need permission to update this open PR branch.');
    if (!oid(state.headSha) || !oid(state.baseSha))
      throw new Error('GitHub has not returned the branch revisions yet.');
    const id = hash(url);
    const saved = deps.storage.read(storageKey(ctx.account, id)) as ConflictSession | undefined;
    if (
      !restart &&
      saved?.status === 'published' &&
      saved.restack &&
      saved.restack.status !== 'published' &&
      (saved.commitSha !== state.headSha || saved.headBranch !== state.headBranch || saved.headRepo !== state.headRepo)
    ) {
      return { ...saved, stale: true };
    }
    if (!restart && saved?.commitSha === state.headSha) {
      saved.status = 'published';
      saved.dependents = deps.dependents?.(url) ?? [];
      const restack = saved.restack;
      if (restack?.status === 'prepared') {
        // Recover a successful atomic push whose response or local persistence was interrupted.
        const states = await Promise.all(restack.branches.map((branch) => deps.read(branch.url)));
        assertAccount(ctx);
        if (
          states.length &&
          states.every(
            (value, index) =>
              value.account === ctx.account &&
              value.headRepo === restack.branches[index].repo &&
              value.headBranch === restack.branches[index].branch &&
              value.headSha === restack.branches[index].newSha
          )
        )
          restack.status = 'published';
      }
      await persist(saved);
      return saved;
    }
    if (saved?.status === 'editing' && !restart && saved.files.length > 0)
      return {
        ...saved,
        stale:
          saved.headSha !== state.headSha ||
          saved.baseSha !== state.baseSha ||
          saved.baseBranch !== state.baseBranch ||
          saved.headBranch !== state.headBranch ||
          saved.headRepo !== state.headRepo ||
          saved.baseRepo !== state.repository,
      };
    await fs.mkdir(await directory(ctx.account, id), { recursive: true, mode: 0o700 });
    await git(ctx, id, ['init', '--bare', '.'], signal);
    for (const branch of [state.headBranch, state.baseBranch])
      await git(ctx, id, ['check-ref-format', `refs/heads/${branch}`], signal);
    report('Fetching the PR and base history into a private Git cache.');
    for (const [name, repo, sha] of [
      ['pr', state.headRepo, state.headSha],
      ['base', state.repository, state.baseSha],
    ]) {
      await git(ctx, id, ['config', `remote.${name}.url`, remote(repo)], signal);
      await git(ctx, id, ['config', `remote.${name}.promisor`, 'true'], signal);
      await git(ctx, id, ['config', `remote.${name}.partialclonefilter`, 'blob:none'], signal);
      await git(ctx, id, ['fetch', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', name, sha], signal);
    }
    report('Finding conflicts. Your checkout is not modified.');
    const merge = await git(
      ctx,
      id,
      [
        '-c',
        'merge.conflictStyle=diff3',
        'merge-tree',
        '--write-tree',
        '--messages',
        '-z',
        state.headSha,
        state.baseSha,
      ],
      signal,
      undefined,
      [0, 1]
    );
    const parts = merge.stdout.toString('utf8').split('\0');
    const tree = (parts.shift() ?? '').trim();
    if (!oid(tree)) throw new Error('Git 2.38 or newer is required to prepare conflicts.');
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
    const remembered = await memory.apply(
      memoryScope({ account: ctx.account, headRepo: state.headRepo }),
      files,
      signal
    );
    for (const file of files) {
      const contents = remembered.get(file.path);
      if (contents !== undefined) {
        file.result = contents;
        file.source = 'rerere';
        file.explanation =
          'Git reused a resolution you previously reviewed in this repository. Check it in this PR context before marking the file reviewed.';
      }
    }
    const containsBase = await git(
      ctx,
      id,
      ['merge-base', '--is-ancestor', state.baseSha, state.headSha],
      signal,
      undefined,
      [0, 1]
    );
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
      dependents: deps.dependents?.(url) ?? [],
      preparation: files.length ? 'conflicts' : containsBase.code === 0 ? 'up-to-date' : 'clean-merge',
    };
    signal.throwIfAborted();
    assertAccount(ctx);
    await persist(session);
    return session;
  }
  async function resultTree(ctx: Context, session: ConflictSession, signal: AbortSignal) {
    if (session.preparation === 'up-to-date')
      throw new Error('The PR already contains the base branch. No update is needed.');
    if (session.files.some((f) => !f.resolved || f.unsupported || hasConflictMarkers(f.result)))
      throw new Error('Resolve and mark every file reviewed before publishing.');
    await git(ctx, session.id, ['read-tree', session.tree], signal);
    for (const file of session.files) {
      const sha = (await git(ctx, session.id, ['hash-object', '-w', '--stdin'], signal, file.result)).stdout
        .toString()
        .trim();
      await git(ctx, session.id, ['update-index', '-z', '--index-info'], signal, `${file.mode} ${sha}\t${file.path}\0`);
    }
    return (await git(ctx, session.id, ['write-tree'], signal)).stdout.toString().trim();
  }
  return {
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
      if (busy.has(key)) throw new Error('A conflict operation is already running for this PR.');
      busy.add(key);
      try {
        if (request.kind === 'open')
          return { session: await open(ctx, request.url, !!request.restart, signal, report) };
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
        if (request.kind === 'discard') {
          deps.storage.write(key, null);
          await deps.storage.flush();
          await fs.rm(await directory(ctx.account, id), { recursive: true, force: true });
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
          const files = session.files.filter(
            (f) => !f.unsupported && (request.path ? f.path === request.path : !f.resolved)
          );
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
              const temp = await fs.mkdtemp(path.join(await directory(ctx.account, id), 'mergiraf-'));
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
                    '10000',
                    '--base-name',
                    'Common ancestor',
                    `--left-name=${session.headBranch}`,
                    `--right-name=${session.baseBranch}`,
                  ],
                  { cwd: temp, signal, timeout: 20_000 }
                );
                if (result.code > 1)
                  throw new Error('Mergiraf could not resolve this file. Use the manual editor or an agent.');
                file.result = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
                if (Buffer.byteLength(file.result) > CONFLICT_FILE_LIMIT)
                  throw new Error('The proposed result is too large.');
                file.explanation = hasConflictMarkers(file.result)
                  ? 'Mergiraf left conflicts that need your input.'
                  : 'Mergiraf proposed a result. Review it before marking the file reviewed.';
              } finally {
                await fs.rm(temp, { recursive: true, force: true });
              }
            }
            file.source = request.engine;
            file.resolved = false;
          }
        } else {
          await current(session, ctx);
          const tree = await resultTree(ctx, session, signal);
          const digest = hash(`${session.id}:${session.version}:${tree}:${session.headSha}:${session.baseSha}`);
          if (request.kind === 'preview') {
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
              preview: {
                patch,
                token: digest,
                validation: validation.stdout.toString('utf8'),
                files: parsePatchFiles(patch).flatMap((p) => p.files),
              },
            };
          }
          if (
            request.previewToken !== digest ||
            typeof request.message !== 'string' ||
            !request.message.trim() ||
            request.message.length > 2000
          )
            throw new Error('Review the complete resolution and enter a commit message before publishing.');
          report('Checking revisions before updating the PR branch.');
          await current(session, ctx);
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
          signal.throwIfAborted();
          assertAccount(ctx);
        }
        session.version++;
        await persist(session);
        return { session };
      } finally {
        busy.delete(key);
      }
    },
  };
}
