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

async function compile(run: RunScript, tsc: string, cwd: string, signal: AbortSignal, timeout: number) {
  // No emit and no build info: nothing is written, also not through the linked node_modules.
  const result = await run(
    tsc,
    ['--noEmit', '--pretty', 'false', '--incremental', 'false', '--composite', 'false', '-p', 'tsconfig.json'],
    { cwd, env: compilerEnvironment(), signal, timeout, maxBytes: OUTPUT_LIMIT }
  );
  const diagnostics = parseDiagnostics(result.stdout);
  // 0: no errors. 1 and 2: errors, with or without output. Anything else, or errors without a single one parsed, is a
  // compiler that didn't run as expected.
  if (result.code !== 0 && (!diagnostics.length || result.code > 2))
    throw new Error(
      (result.stderr || result.stdout).trim().split('\n')[0]?.slice(0, 200) || `The compiler exited with ${result.code}.`
    );
  const project = diagnostics.find((d) => !d.file);
  if (project) throw new Error(`TypeScript couldn’t read the project: ${project.code} ${project.message}`.slice(0, 240));
  return diagnostics;
}

/**
 * Checks the session's draft. `git` runs in the session repository, which has the merge and the PR head. Each worktree
 * is removed afterwards, whatever happened.
 */
export async function typeCheckMerge(options: {
  session: Pick<ConflictSession, 'tree' | 'headSha' | 'files'>;
  clone: string;
  directory: string;
  git: Git;
  run: RunScript;
  signal: AbortSignal;
  timeout?: number;
}): Promise<ConflictTypeCheck> {
  const { session, git, signal } = options;
  const timeout = options.timeout ?? TYPE_CHECK_TIMEOUT;
  const listed = await git(['ls-tree', '--name-only', session.tree, '--', 'tsconfig.json'], signal);
  if (listed.stdout.toString().trim() !== 'tsconfig.json') return { state: 'skipped', reason: NOT_SUPPORTED };
  const compiler = await findCompiler(options.clone);
  if ('skipped' in compiler) return { state: 'skipped', reason: compiler.skipped };
  const parent = path.join(options.directory, 'type-check');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const worktrees: string[] = [];
  const started = Date.now();
  const left = () => {
    const remaining = timeout - (Date.now() - started);
    if (remaining <= 0) throw new Error(TIMED_OUT);
    return remaining;
  };
  const checkout = async (commit: string) => {
    const worktree = path.join(parent, crypto.randomBytes(6).toString('hex'));
    worktrees.push(worktree);
    await git(['worktree', 'add', '--detach', worktree, commit], signal);
    // A linked node_modules, unless the tree has its own. A junction on Windows needs no privileges.
    const modules = path.join(worktree, 'node_modules');
    if (!(await fs.lstat(modules).catch(() => undefined)))
      await fs.symlink(compiler.modules, modules, process.platform === 'win32' ? 'junction' : 'dir');
    return worktree;
  };
  try {
    const commit = (
      await git(
        ['-c', 'user.name=Gnosis', '-c', 'user.email=gnosis@localhost', 'commit-tree', session.tree, '-m', 'Type check'],
        signal
      )
    ).stdout
      .toString()
      .trim();
    const merge = await checkout(commit);
    const real = await fs.realpath(merge);
    for (const file of session.files) {
      if (file.unsupported) continue;
      // Only a regular file inside the worktree: a path through a link the tree holds is never written.
      const target = path.resolve(merge, file.path);
      const folder = await fs.realpath(path.dirname(target)).catch(() => undefined);
      const stat = await fs.lstat(target).catch(() => undefined);
      if (!folder || (folder !== real && !folder.startsWith(real + path.sep)) || (stat && !stat.isFile())) continue;
      await fs.writeFile(target, checkedText(file.result));
    }
    const merged = await compile(options.run, compiler.tsc, merge, signal, left());
    if (!merged.length) return { state: 'passed', preExisting: 0 };
    const head = await compile(options.run, compiler.tsc, await checkout(session.headSha), signal, left());
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
  } finally {
    const cleanup = AbortSignal.timeout(30_000);
    for (const worktree of worktrees) {
      // The link goes first, so nothing that removes the worktree can reach into your clone's node_modules.
      const modules = path.join(worktree, 'node_modules');
      if ((await fs.lstat(modules).catch(() => undefined))?.isSymbolicLink())
        await fs.unlink(modules).catch(() => fs.rmdir(modules).catch(() => undefined));
      await git(['worktree', 'remove', '--force', worktree], cleanup).catch(() => undefined);
    }
    await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
    await git(['worktree', 'prune'], cleanup).catch(() => undefined);
  }
}
