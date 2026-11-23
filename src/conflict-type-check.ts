import crypto from 'node:crypto';
import { realpath } from 'node:fs';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { inferChoices, parseConflicts, pickText } from '../lib/conflict-blocks';
import type { ConflictFile, ConflictSession, ConflictTypeCheck } from '../lib/conflict-resolution';
import { typeCheckKey } from '../lib/conflict-verify';

/**
 * The opt-in type check of a prepared merge (#445 item 24). Running a repository's type checker runs the repository's
 * code, so it is narrow on purpose:
 *
 * - Only the TypeScript compiler that is already installed in your linked clone (`node_modules/typescript/lib/tsc.js`)
 *   runs, with `--noEmit`. Never `npm install`, never a package script, never a shell.
 * - The compiler runs in a private worktree of the session repository at the merge result, with the clone's
 *   `node_modules` linked in. Your clone is only read.
 * - The PR head and the base are checked the same way, and only errors neither has count.
 */
export const TYPE_CHECK_TIMEOUT = 120_000;
/** A changed draft is checked again this long after its last change, so autosave doesn't start a run each time. */
export const TYPE_CHECK_DELAY = 2_000;
/** Up to this many new errors are kept for the summary. */
const ERRORS_SHOWN = 20;
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

/**
 * A type in a message with its union members in one order: the same union can print in another order in another
 * program, such as `'"a" | "b"'` and `'"b" | "a"'`. Only the outermost union of each quoted type.
 */
export function sortedUnions(message: string) {
  return message.replace(/'([^'\n]*)'/g, (_, type: string) => {
    const members: string[] = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < type.length; i++) {
      const char = type[i];
      if (char === '"') quoted = !quoted;
      else if (quoted) continue;
      else if ('([{<'.includes(char)) depth++;
      else if (')]}'.includes(char) || (char === '>' && type[i - 1] !== '=')) depth--;
      else if (depth === 0 && type.startsWith(' | ', i)) {
        members.push(type.slice(start, i));
        start = i + 3;
        i += 2;
      }
    }
    members.push(type.slice(start));
    return `'${members.sort().join(' | ')}'`;
  });
}
/**
 * The merge's errors that neither baseline has: the PR head, or the base. Lines move in a merge, so an error is its file,
 * code and text, with unions in one order. An error that occurs more often than in either baseline counts its extra
 * occurrences.
 */
export function newErrors(merge: readonly TypeDiagnostic[], ...baselines: (readonly TypeDiagnostic[])[]) {
  const identity = (d: TypeDiagnostic) => `${d.file ?? ''}\0${d.code}\0${sortedUnions(d.message)}`;
  const known = new Map<string, number>();
  for (const baseline of baselines) {
    const counts = new Map<string, number>();
    for (const d of baseline) counts.set(identity(d), (counts.get(identity(d)) ?? 0) + 1);
    for (const [id, count] of counts) known.set(id, Math.max(known.get(id) ?? 0, count));
  }
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

/**
 * Each conflict's lines (first and last, 1-based) in the checked text of the draft, by block index; undefined for a
 * conflict that holds no text. Undefined when the draft can't be split into its conflicts, such as after an edit by
 * hand: then no error can be traced to a conflict.
 */
export function conflictLines(file: Pick<ConflictFile, 'original' | 'proposals' | 'result'>) {
  const segments = parseConflicts(file.original);
  const choices = inferChoices(segments, file.result, file.proposals);
  if (!choices) return undefined;
  const spans: ([number, number] | undefined)[] = [];
  let text = '';
  let line = 1;
  for (const segment of segments) {
    // An open conflict is checked with the PR's side, as `checkedText` writes it.
    const piece =
      segment.kind === 'text'
        ? segment.text
        : choices[segment.index]
          ? pickText(segment, choices[segment.index], file.proposals)
          : segment.block.ours;
    const breaks = piece.split('\n').length - 1;
    if (segment.kind === 'conflict')
      spans[segment.index] = piece ? [line, line + breaks - (piece.endsWith('\n') ? 1 : 0)] : undefined;
    text += piece;
    line += breaks;
  }
  return text === checkedText(file.result) ? spans : undefined;
}

/** Only what the compiler needs: no tokens, no Git variables, no NODE_OPTIONS. */
function compilerEnvironment(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG'];
  return Object.fromEntries(keep.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

/**
 * A path as one comparable string: absolute, forward slashes, and on Windows (`api` is `path.win32`) lower case, since
 * its file system ignores case and drive letters come in either.
 */
export function comparablePath(value: string, api: typeof path = path) {
  const absolute = api.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return api.sep === '\\' ? absolute.toLowerCase() : absolute;
}
/**
 * Where a file the compiler names is, given its worktree (`cwd`): relative to the worktree with forward slashes, under a
 * labelled root (`<clone>/…`), or undefined when it is in none of the roots. The compiler may name a file relative to
 * a real path the worktree's own path doesn't spell, such as a long Windows name for a short one (`RUNNER~1`) or
 * another drive: the file is resolved and compared as an absolute path, never as a relative string.
 */
export function placeFile(file: string, cwd: string, roots: readonly [string, string][], api: typeof path = path) {
  const absolute = api.resolve(cwd, file).replaceAll('\\', '/');
  const key = comparablePath(absolute, api);
  const ordered = roots
    .filter(([root]) => root)
    .map(([root, label]) => [comparablePath(root, api), label] as const)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [root, label] of ordered) {
    if (key === root) return label;
    if (!key.startsWith(`${root}/`)) continue;
    const rest = absolute.slice(root.length + 1);
    return label ? `${label}/${rest}` : rest;
  }
  return undefined;
}
/** The file system's own name for a path, such as a Windows long name for a short one. */
const nativeRealpath = promisify(realpath.native);
/** A file a diagnostic names outside the worktree and your clone: it can't be compared, so the run doesn't check. */
export const outsideTree = (file: string) => `an error is in a file outside this tree (${file})`;

/**
 * Diagnostics without the folder they were checked in: the merge and the PR head are checked in different worktrees,
 * and a message that names an absolute path must read the same in both. `roots` are replaced by `''` (the worktree) or
 * their label.
 */
export function withoutRoots(diagnostics: readonly TypeDiagnostic[], roots: readonly [string, string][]) {
  const strip = rootStripper(roots);
  return diagnostics.map((d) => ({ ...d, ...(d.file ? { file: strip(d.file) } : {}), message: strip(d.message) }));
}
/** `withoutRoots` for one text, with the roots ordered once: `--listFiles` can print many thousands of lines. */
export function rootStripper(roots: readonly [string, string][]) {
  // Longest first, with both separators, so a worktree inside another root is stripped whole.
  const ordered = roots
    .flatMap(([root, label]) => [root, root.replaceAll('\\', '/')].map((value) => [value, label] as const))
    .filter(([root]) => root)
    .sort((a, b) => b[0].length - a[0].length);
  return (text: string) => {
    for (const [root, label] of ordered) {
      if (!text.includes(root)) continue;
      text = text.replaceAll(root + '/', label ? `${label}/` : '').replaceAll(root + '\\', label ? `${label}/` : '');
      text = text.replaceAll(root, label);
    }
    return text;
  };
}

/** The compiler's output did not arrive whole, or contradicts its exit code. Never compared: the check is skipped. */
export const INCOMPLETE = 'the type checker’s output was incomplete';
/** The root tsconfig checks no file of its own, such as a solution file with project references. */
export const REFERENCES = 'not supported yet (project references)';
/** The compiler process died, such as out of memory. */
export const CRASHED = 'the type checker crashed';

/** Thrown with a reason the status line shows as "skipped (reason)". */
export class TypeCheckSkipped extends Error {}
/**
 * The compiler ran but did not check types: an options or project error, an error in a tsconfig file, or a syntax error.
 * Shown as "couldn't check (reason)": never passed, and nothing is demoted.
 */
export class TypeCheckUnchecked extends Error {}
/** A diagnostic after which the compiler may have skipped semantic checking. */
export const blocksChecking = (d: TypeDiagnostic) =>
  !d.file ||
  /(^|\/)tsconfig[^/]*\.json$/i.test(d.file) ||
  (/^TS[156]\d{3}$/.test(d.code) && !UNUSED.has(d.code));
/** 6xxx codes that are ordinary type errors in a file (noUnusedLocals and noUnusedParameters), not options errors. */
const UNUSED = new Set(['TS6133', 'TS6138', 'TS6192', 'TS6196', 'TS6198', 'TS6199', 'TS6205']);

async function compile(
  run: RunScript,
  tsc: string,
  cwd: string,
  clone: string,
  signal: AbortSignal,
  timeout: number,
  /** The workspace packages linked to this worktree's own copies (`linkModules`). */
  linked: ReadonlyMap<string, string> = new Map()
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
  // Each root as given, as Node resolves it, and as the file system names it (a Windows short name expanded).
  const spellings = async (root: string) => [
    root,
    await fs.realpath(root).catch(() => root),
    await nativeRealpath(root).catch(() => root),
  ];
  const roots: [string, string][] = [
    ...(await spellings(cwd)).map((root): [string, string] => [root, '']),
    ...(await spellings(clone)).map((root): [string, string] => [root, '<clone>']),
  ];
  const strip = rootStripper(roots);
  const diagnostics = parseDiagnostics(result.stdout).map((d) => {
    if (!d.file) return { ...d, message: strip(d.message) };
    const file = placeFile(d.file, cwd, roots);
    // Never excused, never compared: a location this run can't name.
    if (file === undefined) throw new TypeCheckUnchecked(outsideTree(d.file).slice(0, 200));
    return { ...d, file, message: strip(d.message) };
  });
  // 0: no errors, and none written. 1 and 2: errors, each written. Anything else, or a code that doesn't match the
  // output, is a compiler that didn't run as expected.
  if (result.code > 2) throw new TypeCheckSkipped(`couldn’t run: the type checker exited with ${result.code}`);
  if ((result.code === 0) !== (diagnostics.length === 0)) throw new TypeCheckSkipped(INCOMPLETE);
  const unresolved = unresolvedWorkspace(diagnostics, linked);
  if (unresolved) throw new TypeCheckUnchecked(workspaceUnresolved(unresolved));
  const blocking = diagnostics.find(blocksChecking);
  if (blocking)
    throw new TypeCheckUnchecked(
      `${blocking.code}${blocking.file ? ` in ${blocking.file}` : ''}: ${blocking.message}`.slice(0, 200)
    );
  // The files the project checked: absolute paths in the worktree, outside node_modules.
  const own = result.stdout.split(/\r?\n/).filter((line) => {
    if (!path.isAbsolute(line)) return false;
    const relative = placeFile(line, cwd, roots);
    return relative !== undefined && !relative.startsWith('<clone>') && !/(^|\/)node_modules\//.test(relative);
  });
  if (!own.length) throw new TypeCheckSkipped(REFERENCES);
  return diagnostics;
}

/**
 * A worktree's administrative folder in the session repository, from its `.git` file, with what its `gitdir` file says:
 * the entry belongs to this worktree only while that stays the same.
 */
async function adminFolder(worktree: string) {
  const match = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(path.join(worktree, '.git'), 'utf8').catch(() => ''));
  if (!match) return undefined;
  const admin = path.resolve(worktree, match[1].trim());
  const owner = await fs.readFile(path.join(admin, 'gitdir'), 'utf8').catch(() => undefined);
  return owner === undefined ? undefined : { admin, owner };
}
/**
 * Whether two `gitdir` files name the same worktree: trimmed (a line break, CRLF), and compared as paths, so `C:/…` and
 * `C:\\…` or another case of a Windows path are the same.
 */
export function sameGitdir(a: string, b: string, api: typeof path = path) {
  return comparablePath(a.trim(), api) === comparablePath(b.trim(), api);
}
/**
 * Removes a worktree's entry in the session repository by hand, only while it is still this worktree's. Git names the
 * entry after the folder (`worktrees/merge`), so after Start over a new run's worktree can have the same entry: its
 * `gitdir` names another folder, and it stays.
 */
async function removeOwnAdmin({ admin, owner }: { admin: string; owner: string }) {
  if (path.basename(path.dirname(admin)) !== 'worktrees') return;
  const now = await fs.readFile(path.join(admin, 'gitdir'), 'utf8').catch(() => undefined);
  if (now === undefined || !sameGitdir(now, owner)) return;
  await fs.rm(admin, { recursive: true, force: true }).catch(() => undefined);
}
/**
 * Removes a worktree's links to your clone's node_modules: first, so nothing that removes the worktree reaches in. The
 * link is either node_modules itself, or, with workspace packages, each entry of a node_modules folder (`linkModules`).
 */
async function unlinkModules(worktree: string) {
  const modules = path.join(worktree, 'node_modules');
  const stat = await fs.lstat(modules).catch(() => undefined);
  if (stat?.isSymbolicLink()) return fs.unlink(modules).catch(() => fs.rmdir(modules).catch(() => undefined));
  if (!stat?.isDirectory()) return;
  const unlink = (link: string) => fs.unlink(link).catch(() => fs.rmdir(link).catch(() => undefined));
  for (const name of await fs.readdir(modules).catch(() => [] as string[])) {
    const entry = path.join(modules, name);
    const kind = await fs.lstat(entry).catch(() => undefined);
    if (kind?.isSymbolicLink()) await unlink(entry);
    else if (kind?.isDirectory() && name.startsWith('@'))
      for (const scoped of await fs.readdir(entry).catch(() => [] as string[]))
        if ((await fs.lstat(path.join(entry, scoped)).catch(() => undefined))?.isSymbolicLink())
          await unlink(path.join(entry, scoped));
  }
}

/** Why a workspace package your clone links can't be checked against this tree. */
export const workspaceNotFolder = (name: string) => `the workspace package ${name} isn’t a folder in this tree`;
export const workspaceOutside = (name: string) => `the workspace package ${name} leads out of this tree`;
export const workspaceRoot = (name: string) => `the workspace package ${name} is the repository’s root`;
export const workspaceNoTypes = (name: string) => `workspace package ${name} has no built types in this tree`;
export const workspaceUnresolved = (name: string) => `workspace package ${name} couldn’t be resolved in this tree`;

/** Each entry of a node_modules folder, and of each `@scope` folder in it, by package name (`@scope/name`). */
async function moduleEntries(modules: string, signal?: AbortSignal) {
  const found: { name: string; link: boolean; folder: boolean }[] = [];
  const read = (dir: string) => fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of await read(modules)) {
    signal?.throwIfAborted();
    if (entry.isDirectory() && entry.name.startsWith('@'))
      for (const scoped of await read(path.join(modules, entry.name)))
        found.push({ name: `${entry.name}/${scoped.name}`, link: scoped.isSymbolicLink(), folder: scoped.isDirectory() });
    else found.push({ name: entry.name, link: entry.isSymbolicLink(), folder: entry.isDirectory() });
  }
  return found;
}
/**
 * Your clone's node_modules entries that are links into the clone itself, outside node_modules: a monorepo's workspace
 * packages (npm, Yarn and pnpm workspaces). By package name (`@scope/name`), with the folder relative to the clone.
 */
export async function workspacePackages(clone: string, modules: string, signal?: AbortSignal) {
  const root = await fs.realpath(clone);
  const realModules = await fs.realpath(modules);
  const inside = (target: string, folder: string) => target === folder || target.startsWith(folder + path.sep);
  const packages = new Map<string, string>();
  for (const { name, link } of await moduleEntries(modules, signal)) {
    if (!link) continue;
    const target = await fs.realpath(path.join(modules, name)).catch(() => undefined);
    if (target && inside(target, root) && !inside(target, realModules)) packages.set(name, path.relative(root, target));
  }
  return packages;
}
/** The file a package's types come from, as the compiler looks for it, relative to the package's folder. */
async function typesEntry(folder: string) {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    // No manifest: the compiler looks for an index file.
  }
  const fromExports = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const entry = value as Record<string, unknown>;
    if (typeof entry.types === 'string') return entry.types;
    for (const key of ['.', 'import', 'require', 'default']) {
      const found = fromExports(entry[key]);
      if (found) return found;
    }
    return undefined;
  };
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const main = text(manifest.main);
  return (
    text(manifest.types) ??
    text(manifest.typings) ??
    fromExports(manifest.exports) ??
    (main ? main.replace(/\.[cm]?js$/, '.d.ts') : undefined)
  );
}
/** Whether the package's types are there: its declared types file, or else an index file. */
async function hasTypes(folder: string) {
  const declared = await typesEntry(folder);
  const candidates = declared ? [declared] : ['index.d.ts', 'index.ts', 'index.tsx'];
  for (const candidate of candidates)
    if ((await fs.stat(path.join(folder, candidate)).catch(() => undefined))?.isFile()) return true;
  return false;
}
/**
 * Links your clone's node_modules into a worktree, and returns the workspace packages it linked to the worktree's own
 * copies (by name, with the folder relative to the worktree). Without workspace packages it is one link to the folder.
 * With them, node_modules is a folder of links to each of the clone's entries, and each workspace package the tree has
 * links to the tree's own copy, never your clone's working copy. A package the tree doesn't have is not linked at all:
 * resolving it fails in this tree, and the error is compared as any other. Fails closed, the run doesn't check:
 * - a package that is a file, leads out of the tree, or is the repository's root;
 * - a package whose types aren't in the tree, such as untracked build output (`dist/*.d.ts`): the compiler would read
 *   its values as `any` and miss errors.
 */
async function linkModules(worktree: string, modules: string, packages: ReadonlyMap<string, string>, signal: AbortSignal) {
  const link = (target: string, at: string) =>
    fs.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  const own = path.join(worktree, 'node_modules');
  const linked = new Map<string, string>();
  if (!packages.size) {
    await link(modules, own);
    return linked;
  }
  const real = await fs.realpath(worktree);
  const copies = new Map<string, string>();
  for (const [name, folder] of packages) {
    signal.throwIfAborted();
    const at = path.join(worktree, folder);
    if (!(await fs.lstat(at).catch(() => undefined))) continue;
    if (!folder) throw new TypeCheckSkipped(workspaceRoot(name));
    const copy = await fs.realpath(at).catch(() => undefined);
    if (!copy || !copy.startsWith(real + path.sep)) throw new TypeCheckSkipped(workspaceOutside(name));
    if (!(await fs.stat(copy)).isDirectory()) throw new TypeCheckSkipped(workspaceNotFolder(name));
    if (!(await hasTypes(copy))) throw new TypeCheckUnchecked(workspaceNoTypes(name));
    copies.set(name, copy);
    linked.set(name, path.relative(real, copy).replaceAll('\\', '/'));
  }
  await fs.mkdir(own);
  // Only folders: a Windows junction can't link a file, and the compiler reads no file at the top of node_modules.
  // A package the tree doesn't have gets no entry.
  for (const { name, folder, link: isLink } of await moduleEntries(modules, signal)) {
    signal.throwIfAborted();
    const copy = copies.get(name);
    if (packages.has(name) && !copy) continue;
    if (name.includes('/')) await fs.mkdir(path.join(own, path.dirname(name)), { recursive: true });
    if (copy) await link(copy, path.join(own, name));
    else if (folder || (isLink && (await fs.stat(path.join(modules, name)).catch(() => undefined))?.isDirectory()))
      await link(path.join(modules, name), path.join(own, name));
  }
  return linked;
}
/**
 * A workspace package the compiler couldn't resolve, in a file of the package or by its name: its values would read as
 * `any` on both sides, and the comparison would excuse what it hides. Never excused: the run doesn't check.
 */
function unresolvedWorkspace(diagnostics: readonly TypeDiagnostic[], linked: ReadonlyMap<string, string>) {
  for (const d of diagnostics) {
    if (d.code !== 'TS2307' && d.code !== 'TS7016') continue;
    // Case and separators as the file system compares them: `d.file` and `folder` are both relative to the worktree.
    const file = d.file?.replaceAll('\\', '/');
    const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
    for (const [name, folder] of linked)
      if (
        (file !== undefined && fold(file).startsWith(`${fold(folder)}/`)) ||
        d.message.includes(`'${name}'`) ||
        d.message.includes(`'${name}/`)
      )
        return name;
  }
  return undefined;
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
  session: Pick<ConflictSession, 'tree' | 'headSha' | 'baseSha' | 'files'>;
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
  const worktrees: { path: string; admin?: { admin: string; owner: string } }[] = [];
  try {
    const listed = await git(['ls-tree', '--name-only', session.tree, '--', 'tsconfig.json'], signal);
    if (listed.stdout.toString().trim() !== 'tsconfig.json') return { state: 'skipped', reason: NOT_SUPPORTED };
    const compiler = await findCompiler(options.clone);
    if ('skipped' in compiler) return { state: 'skipped', reason: compiler.skipped };
    // A monorepo's workspace packages resolve to each worktree's own copy, never to your clone's working copy.
    const packages = await workspacePackages(options.clone, compiler.modules, signal);
    const linked = new Map<string, ReadonlyMap<string, string>>();
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const checkout = async (name: string, commit: string) => {
      const worktree = path.join(folder, name);
      const entry: (typeof worktrees)[number] = { path: worktree };
      worktrees.push(entry);
      await git(['worktree', 'add', '--detach', worktree, commit], signal);
      // Its entry in the session repository, known while the folder is there: cleanup removes exactly this one.
      entry.admin = await adminFolder(worktree);
      // A linked node_modules, unless the tree has its own. A junction on Windows needs no privileges.
      if (!(await fs.lstat(path.join(worktree, 'node_modules')).catch(() => undefined)))
        linked.set(worktree, await linkModules(worktree, compiler.modules, packages, signal));
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
    const build = (worktree: string) =>
      compile(options.run, compiler.tsc, worktree, options.clone, signal, left(), linked.get(worktree));
    const merged = await build(merge);
    let head: TypeDiagnostic[] = [];
    if (merged.length)
      head = await build(await checkout('head', session.headSha));
    const afterHead = newErrors(merged, head);
    // Each conflicted file's conflict lines, by path. A draft that can't be split into its conflicts has none.
    const lines = new Map(session.files.filter((f) => !f.unsupported).map((f) => [f.path, conflictLines(f)] as const));
    const inConflict = (d: TypeDiagnostic) => {
      if (!d.file || !lines.has(d.file)) return false;
      const spans = lines.get(d.file);
      return !spans || spans.some((span) => !!span && d.line !== undefined && d.line >= span[0] && d.line <= span[1]);
    };
    // Errors the base already has are not new either, such as a generated import that isn't built: only outside the
    // conflicts, so a conflict's error never hides behind the same text in the base. A base that can't be checked, for
    // any reason but your Stop, is no baseline: the errors the head comparison found stand.
    const outside = afterHead.filter((d) => !inConflict(d));
    let excused = new Set<TypeDiagnostic>();
    if (outside.length) {
      const base = await (async () => {
        try {
          return await build(await checkout('base', session.baseSha));
        } catch (error) {
          if (options.signal.aborted) throw error;
          return undefined;
        }
      })();
      if (base) {
        const still = new Set(newErrors(outside, base));
        excused = new Set(outside.filter((d) => !still.has(d)));
      }
    }
    // A run whose folder went meanwhile, such as for a new preparation, has nothing to say about this draft.
    if (!(await fs.stat(folder).catch(() => undefined))) throw new Error('The type check’s folder was removed.');
    const fresh = afterHead.filter((d) => !excused.has(d));
    const preExisting = merged.length - fresh.length;
    // Every file's draft this run checked: a result counts for a file only while its draft is the same.
    const checked = Object.fromEntries(session.files.map((f) => [f.path, typeCheckKey(f)]));
    if (!fresh.length) return { state: 'passed', preExisting, checked };
    // The compiler checks the whole program, so an error anywhere may come from any Merged proposal: every conflicted
    // file's Merged proposals are Check, with the first error as the note.
    const [first] = fresh;
    const where = `${first.file ?? 'the project'}${first.line ? `:${first.line}` : ''} (${first.code})`;
    const note =
      fresh.length === 1
        ? `The type check found a new error in ${where}.`
        : `The type check found ${fresh.length} new errors, the first in ${where}.`;
    const files = session.files.flatMap((file) =>
      file.unsupported ? [] : [{ path: file.path, key: typeCheckKey(file), note }]
    );
    return {
      state: 'errors',
      checked,
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
      if (!removed && admin) await removeOwnAdmin(admin);
    }
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    await fs.rmdir(path.dirname(folder)).catch(() => undefined);
  }
}
