import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseConflicts } from '../lib/conflict-blocks';
import type { ConflictSession, ConflictTypeCheck } from '../lib/conflict-resolution';
import { typeCheckKey } from '../lib/conflict-verify';

/**
 * The opt-in type check of a prepared merge (#445 item 24). Running a repository's type checker runs the repository's
 * code, so it is narrow on purpose:
 *
 * - Only the TypeScript compiler that is already installed in your linked clone (`node_modules/typescript/lib/tsc.js`)
 *   runs, with `--noEmit`. Never `npm install`, never a package script, never a shell.
 * - The compiler runs in a private worktree of the session repository at the merge result, with the clone's
 *   `node_modules` linked in. Your clone is only read.
 * - The PR head is checked the same way, and only errors the head does not have count.
 */
export const TYPE_CHECK_TIMEOUT = 120_000;
/** Up to this many new errors are kept for the summary, and three per file for a Check note. */
const ERRORS_SHOWN = 20;
const ERRORS_PER_NOTE = 3;
const OUTPUT_LIMIT = 16 * 1024 * 1024;

export const NO_DEPENDENCIES = 'dependencies aren’t installed in your clone';
export const NO_TYPESCRIPT = 'TypeScript isn’t installed in your clone';
export const NOT_SUPPORTED = 'not supported yet: only TypeScript projects with a tsconfig.json at the root';
export const FROM_FORK = 'this PR comes from a fork, so its code isn’t run';
export const TIMED_OUT = `took longer than ${TYPE_CHECK_TIMEOUT / 60_000} minutes`;

export interface TypeDiagnostic {
  /** Relative to the worktree, with forward slashes. Undefined: an error about the project, not a file. */
  file?: string;
  line?: number;
  code: string;
  message: string;
}
/** Runs a Node script, such as the compiler, and returns its exit code and output. Rejects on timeout or abort. */
export type RunScript = (
  script: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number; maxBytes: number }
) => Promise<{ code: number; stdout: string; stderr: string }>;
type Git = (args: string[], signal: AbortSignal, cwd?: string) => Promise<{ code: number; stdout: Buffer }>;

/** The compiler in the linked clone, or why the check is skipped. The compiler must be a file inside the clone. */
export async function findCompiler(clone: string): Promise<{ tsc: string; modules: string } | { skipped: string }> {
  const modules = path.join(clone, 'node_modules');
  if (!(await fs.stat(modules).catch(() => undefined))?.isDirectory()) return { skipped: NO_DEPENDENCIES };
  const root = await fs.realpath(clone).catch(() => undefined);
  const tsc = await fs.realpath(path.join(modules, 'typescript', 'lib', 'tsc.js')).catch(() => undefined);
  if (!root || !tsc || !tsc.startsWith(root + path.sep) || !(await fs.stat(tsc)).isFile())
    return { skipped: NO_TYPESCRIPT };
  return { tsc, modules };
}

/** `tsc --pretty false` output: `file(line,col): error TS1234: message`, continuation lines indented. */
export function parseDiagnostics(output: string): TypeDiagnostic[] {
  const diagnostics: TypeDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const located = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line);
    const global = located ? undefined : /^error (TS\d+): (.*)$/.exec(line);
    if (located)
      diagnostics.push({
        file: located[1].replaceAll('\\', '/').replace(/^\.\//, ''),
        line: Number(located[2]),
        code: located[3],
        message: located[4],
      });
    else if (global) diagnostics.push({ code: global[1], message: global[2] });
    else if (/^\s+\S/.test(line) && diagnostics.length) diagnostics[diagnostics.length - 1].message += ` ${line.trim()}`;
  }
  return diagnostics;
}

/** The merge's errors that the PR head does not have. Lines move in a merge, so an error is its file, code and text. */
export function newErrors(merge: readonly TypeDiagnostic[], head: readonly TypeDiagnostic[]) {
  const identity = (d: TypeDiagnostic) => `${d.file ?? ''}\0${d.code}\0${d.message}`;
  const known = new Map<string, number>();
  for (const d of head) known.set(identity(d), (known.get(identity(d)) ?? 0) + 1);
  return merge.filter((d) => {
    const left = known.get(identity(d)) ?? 0;
    if (left) known.set(identity(d), left - 1);
    return !left;
  });
}

export const formatDiagnostic = (d: TypeDiagnostic) =>
  `${d.file ? `${d.file}${d.line ? `:${d.line}` : ''} ` : ''}${d.code} ${d.message}`;

/** The draft as the compiler sees it: a conflict still open takes the PR's side, which the PR head's check also has. */
export function checkedText(result: string) {
  return parseConflicts(result)
    .map((segment) => (segment.kind === 'text' ? segment.text : segment.block.ours))
    .join('');
}

/** Only what the compiler needs: no tokens, no Git variables, no NODE_OPTIONS. */
function compilerEnvironment(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG'];
  return Object.fromEntries(keep.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

/**
 * Diagnostics without the folder they were checked in: the merge and the PR head are checked in different worktrees,
 * and a message that names an absolute path must read the same in both. `roots` are replaced by `''` (the worktree) or
 * their label.
 */
export function withoutRoots(diagnostics: readonly TypeDiagnostic[], roots: readonly [string, string][]) {
  // Longest first, with both separators, so a worktree inside another root is stripped whole.
  const ordered = roots
    .flatMap(([root, label]) => [root, root.replaceAll('\\', '/')].map((value) => [value, label] as const))
    .filter(([root]) => root)
    .sort((a, b) => b[0].length - a[0].length);
  const strip = (text: string) => {
    for (const [root, label] of ordered) {
      text = text.replaceAll(root + '/', label ? `${label}/` : '').replaceAll(root + '\\', label ? `${label}/` : '');
      text = text.replaceAll(root, label);
    }
    return text;
  };
  return diagnostics.map((d) => ({ ...d, ...(d.file ? { file: strip(d.file) } : {}), message: strip(d.message) }));
}

/** The compiler's output did not arrive whole, or contradicts its exit code. Never compared: the check is skipped. */
export const INCOMPLETE = 'the type checker’s output was incomplete';
/** The root tsconfig checks no file of its own, such as a solution file with project references. */
export const REFERENCES = 'not supported yet (project references)';
/** The compiler process died, such as out of memory. */
export const CRASHED = 'the type checker crashed';

/** Thrown with a reason the status line shows as "skipped (reason)". */
export class TypeCheckSkipped extends Error {}

async function compile(
  run: RunScript,
  tsc: string,
  cwd: string,
  clone: string,
  signal: AbortSignal,
  timeout: number
) {
  // No emit and no build info: nothing is written, also not through the linked node_modules. `--listFiles` says which
  // files were checked, so a project that checks none never reads as passed.
  const result = await run(
    tsc,
    ['--noEmit', '--pretty', 'false', '--incremental', 'false', '--composite', 'false', '--listFiles', '-p', 'tsconfig.json'],
    { cwd, env: compilerEnvironment(), signal, timeout, maxBytes: OUTPUT_LIMIT }
  );
  // tsc ends every line it writes; output that stops mid-line was cut off.
  if (result.stdout && !result.stdout.endsWith('\n')) throw new TypeCheckSkipped(INCOMPLETE);
  const roots: [string, string][] = [
    [cwd, ''],
    [await fs.realpath(cwd).catch(() => cwd), ''],
    [clone, '<clone>'],
    [await fs.realpath(clone).catch(() => clone), '<clone>'],
  ];
  const diagnostics = withoutRoots(parseDiagnostics(result.stdout), roots);
  // 0: no errors, and none written. 1 and 2: errors, each written. Anything else, or a code that doesn't match the
  // output, is a compiler that didn't run as expected.
  if (result.code > 2) throw new TypeCheckSkipped(`couldn’t run: the type checker exited with ${result.code}`);
  if ((result.code === 0) !== (diagnostics.length === 0)) throw new TypeCheckSkipped(INCOMPLETE);
  const project = diagnostics.find((d) => !d.file);
  if (project) throw new TypeCheckSkipped(`couldn’t read the project: ${project.code} ${project.message}`.slice(0, 240));
  // The files the project checked: absolute paths in the worktree, outside node_modules.
  const own = result.stdout.split(/\r?\n/).filter((line) => {
    if (!path.isAbsolute(line)) return false;
    const relative = withoutRoots([{ code: '', message: line }], roots)[0].message;
    return relative !== line && !relative.startsWith('<clone>') && !/(^|\/)node_modules\//.test(relative);
  });
  if (!own.length) throw new TypeCheckSkipped(REFERENCES);
  return diagnostics;
}

/** A worktree's administrative folder in the session repository, from its `.git` file. */
async function adminFolder(worktree: string) {
  const match = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(path.join(worktree, '.git'), 'utf8').catch(() => ''));
  return match ? path.resolve(worktree, match[1].trim()) : undefined;
}
/** Removes a worktree's link to your clone's node_modules: first, so nothing that removes the worktree reaches in. */
async function unlinkModules(worktree: string) {
  const modules = path.join(worktree, 'node_modules');
  if ((await fs.lstat(modules).catch(() => undefined))?.isSymbolicLink())
    await fs.unlink(modules).catch(() => fs.rmdir(modules).catch(() => undefined));
}

/** Where every run keeps its own folder, in the session directory. Startup cleanup removes what a crash left. */
export const TYPE_CHECK_FOLDER = 'type-check';

/**
 * Removes what earlier runs left in a session directory: their links to the clone first, then the folders. Only while
 * nothing runs, at startup. The session repository's worktree entries for them are pruned after.
 */
export async function removeLeftovers(directory: string, git: (args: string[]) => Promise<unknown>) {
  const parent = path.join(directory, TYPE_CHECK_FOLDER);
  const runs = await fs.readdir(parent).catch(() => [] as string[]);
  if (!runs.length && !(await fs.stat(parent).catch(() => undefined))) return false;
  for (const run of runs) {
    // This build's layout (<run>/merge, <run>/head) and the first one's (<worktree>).
    await unlinkModules(path.join(parent, run));
    for (const name of await fs.readdir(path.join(parent, run)).catch(() => [] as string[]))
      await unlinkModules(path.join(parent, run, name));
  }
  await fs.rm(parent, { recursive: true, force: true });
  await git(['worktree', 'prune']).catch(() => undefined);
  return true;
}

/**
 * Checks the session's draft. `git` runs in the session repository, which has the merge and the PR head; it may fetch
 * file contents. `local` runs Git there without the network or the account, for cleanup. The run has its own folder,
 * and its worktrees are removed afterwards, whatever happened. `timeout` covers the whole run.
 */
export async function typeCheckMerge(options: {
  session: Pick<ConflictSession, 'tree' | 'headSha' | 'files'>;
  clone: string;
  directory: string;
  git: Git;
  local: Git;
  run: RunScript;
  signal: AbortSignal;
  timeout?: number;
}): Promise<ConflictTypeCheck> {
  const { session, git } = options;
  const timeout = options.timeout ?? TYPE_CHECK_TIMEOUT;
  const deadline = AbortSignal.timeout(timeout);
  const signal = AbortSignal.any([options.signal, deadline]);
  const started = Date.now();
  const left = () => Math.max(1, timeout - (Date.now() - started));
  const folder = path.join(options.directory, TYPE_CHECK_FOLDER, crypto.randomBytes(8).toString('hex'));
  const worktrees: { path: string; admin?: string }[] = [];
  try {
    const listed = await git(['ls-tree', '--name-only', session.tree, '--', 'tsconfig.json'], signal);
    if (listed.stdout.toString().trim() !== 'tsconfig.json') return { state: 'skipped', reason: NOT_SUPPORTED };
    const compiler = await findCompiler(options.clone);
    if ('skipped' in compiler) return { state: 'skipped', reason: compiler.skipped };
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const checkout = async (name: string, commit: string) => {
      const worktree = path.join(folder, name);
      const entry: { path: string; admin?: string } = { path: worktree };
      worktrees.push(entry);
      await git(['worktree', 'add', '--detach', worktree, commit], signal);
      // Its entry in the session repository, known while the folder is there: cleanup removes exactly this one.
      entry.admin = await adminFolder(worktree);
      // A linked node_modules, unless the tree has its own. A junction on Windows needs no privileges.
      const modules = path.join(worktree, 'node_modules');
      if (!(await fs.lstat(modules).catch(() => undefined)))
        await fs.symlink(compiler.modules, modules, process.platform === 'win32' ? 'junction' : 'dir');
      return worktree;
    };
    const commit = (
      await git(
        ['-c', 'user.name=Gnosis', '-c', 'user.email=gnosis@localhost', 'commit-tree', session.tree, '-m', 'Type check'],
        signal
      )
    ).stdout
      .toString()
      .trim();
    const merge = await checkout('merge', commit);
    const real = await fs.realpath(merge);
    for (const file of session.files) {
      if (file.unsupported) continue;
      // Only a regular file inside the worktree: a path through a link the tree holds is never written.
      const target = path.resolve(merge, file.path);
      const parent = await fs.realpath(path.dirname(target)).catch(() => undefined);
      const stat = await fs.lstat(target).catch(() => undefined);
      if (!parent || (parent !== real && !parent.startsWith(real + path.sep)) || (stat && !stat.isFile())) continue;
      await fs.writeFile(target, checkedText(file.result));
    }
    const merged = await compile(options.run, compiler.tsc, merge, options.clone, signal, left());
    let head: TypeDiagnostic[] = [];
    if (merged.length)
      head = await compile(options.run, compiler.tsc, await checkout('head', session.headSha), options.clone, signal, left());
    // A run whose folder went meanwhile, such as for a new preparation, has nothing to say about this draft.
    if (!(await fs.stat(folder).catch(() => undefined))) throw new Error('The type check’s folder was removed.');
    const fresh = newErrors(merged, head);
    const preExisting = merged.length - fresh.length;
    if (!fresh.length) return { state: 'passed', preExisting };
    const files = session.files.flatMap((file) => {
      const own = fresh.filter((d) => d.file === file.path);
      if (!own.length || file.unsupported) return [];
      const shown = own.slice(0, ERRORS_PER_NOTE).map(formatDiagnostic).join(' · ');
      const more = own.length > ERRORS_PER_NOTE ? ` · ${own.length - ERRORS_PER_NOTE} more` : '';
      return [
        {
          path: file.path,
          key: typeCheckKey(file),
          note: `The type check found ${own.length === 1 ? 'a new error' : `${own.length} new errors`} in this file: ${shown}${more}`,
        },
      ];
    });
    return {
      state: 'errors',
      count: fresh.length,
      preExisting,
      errors: fresh.slice(0, ERRORS_SHOWN).map(formatDiagnostic),
      files,
    };
  } catch (error) {
    // The deadline, not you, stopped it: say so, whatever the step that stopped reported.
    if (deadline.aborted && !options.signal.aborted) throw new TypeCheckSkipped(TIMED_OUT);
    throw error;
  } finally {
    // Only this run's worktrees and folder. Git without the network or the account, so an account change can't stop it.
    const cleanup = AbortSignal.timeout(30_000);
    for (const { path: worktree, admin } of worktrees) {
      await unlinkModules(worktree);
      const removed = await options.local(['worktree', 'remove', '--force', worktree], cleanup).then(
        () => true,
        () => false
      );
      // Git couldn't remove it, such as when the folder is already gone: its own entry goes by hand, no other run's.
      if (!removed && admin && path.basename(path.dirname(admin)) === 'worktrees')
        await fs.rm(admin, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    await fs.rmdir(path.dirname(folder)).catch(() => undefined);
  }
}
