// Shared by the conflict lab harness (conflict-lab.mjs), the matrix generator and the scratch-repo seeder.
// A case is a directory under tests/fixtures/conflicts/ (see the README there) or a generated case object.
import process from 'node:process';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtures = path.join(root, 'tests/fixtures/conflicts');
/** Tree names a case directory can hold. Anything else in it is ignored. */
const TREES = /^(base|ours|theirs|theirs2|resolved|resolved2|pr\d+)$/;

/** Every file under `dir`, by POSIX path relative to it. */
async function readTree(dir) {
  const files = new Map();
  async function walk(sub) {
    for (const entry of await fs.readdir(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) files.set(rel, await fs.readFile(path.join(dir, rel)));
    }
  }
  await walk('');
  return files;
}

/**
 * Deterministic filler, so a large-file case does not commit thousands of lines. A line `@@PAD <n>@@` in any tree
 * is replaced by n lines of small functions in the file's language (the same text on every side).
 */
export function padding(file, lines, seed = 1) {
  const ext = path.extname(file).slice(1);
  const out = [];
  for (let i = 0; out.length < lines; i++) {
    const n = `${seed}_${i}`;
    if (ext === 'py') out.push(`def filler_${n}(value):`, `    return value + ${i}`, '');
    else if (ext === 'go') out.push(`func filler${n}(value int) int {`, `\treturn value + ${i}`, '}', '');
    else if (ext === 'rs') out.push(`fn filler_${n}(value: i32) -> i32 {`, `    value + ${i}`, '}', '');
    else if (ext === 'cs' || ext === 'java')
      out.push(`    static int Filler${n}(int value) {`, `        return value + ${i};`, '    }', '');
    else out.push(`export function filler${n}(value: number) {`, `  return value + ${i};`, '}', '');
  }
  return out.slice(0, lines).join('\n') + '\n';
}
function expand(tree) {
  for (const [file, data] of tree) {
    const text = data.toString('utf8');
    if (!text.includes('@@PAD ')) continue;
    tree.set(
      file,
      Buffer.from(
        text.replace(/^[^\n]*@@PAD (\d+)(?: (\d+))?@@[^\n]*\n/gm, (_, n, seed) => padding(file, +n, +(seed ?? 1)))
      )
    );
  }
  return tree;
}

/** A fixture directory as a case object: its metadata and trees. */
export async function loadCase(dir) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'case.json'), 'utf8'));
  const trees = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory() && TREES.test(entry.name))
      trees[entry.name] = expand(await readTree(path.join(dir, entry.name)));
  // A resolved/ tree with pr1/, pr2/ subdirectories holds one resolution per stack step.
  if (meta.stack && trees.resolved) {
    const steps = {};
    for (const [file, data] of trees.resolved) {
      const [step, ...rest] = file.split('/');
      (steps[step] ??= new Map()).set(rest.join('/'), data);
    }
    trees.resolvedSteps = steps;
    delete trees.resolved;
  }
  for (const name of ['base', 'ours', 'theirs']) if (!meta.stack || name !== 'ours') trees[name] ??= new Map();
  return { name: path.basename(dir), dir, meta, trees };
}

export async function loadCases(filter) {
  const names = (await fs.readdir(fixtures, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const cases = [];
  for (const name of names) {
    if (filter && !filter(name)) continue;
    try {
      await fs.access(path.join(fixtures, name, 'case.json'));
    } catch {
      continue;
    }
    cases.push(await loadCase(path.join(fixtures, name)));
  }
  return cases;
}

/** Git with no user or system configuration, fixed identities and dates, so commits are reproducible. */
export function gitRunner(cwd, extraEnv = {}) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    // User config is ignored for reproducible commits, so pushes to GitHub authenticate through the gh CLI.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '!gh auth git-credential',
    GIT_AUTHOR_NAME: 'Conflict Lab',
    GIT_AUTHOR_EMAIL: 'conflict-lab@example.com',
    GIT_COMMITTER_NAME: 'Conflict Lab',
    GIT_COMMITTER_EMAIL: 'conflict-lab@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    ...extraEnv,
  };
  return (args, { input, allowed = [0], encoding = 'utf8' } = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        { cwd, env, maxBuffer: 256 * 1024 * 1024, encoding: encoding === 'buffer' ? 'buffer' : 'utf8' },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          if (!allowed.includes(code)) reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`));
          else resolve({ code, stdout: encoding === 'buffer' ? stdout : stdout.trimEnd(), stderr });
        }
      );
      if (input !== undefined) child.stdin.end(input);
    });
}

/**
 * A commit whose tree is `parent`'s tree with `files` applied (null deletes) under `prefix`. With `replace`, the
 * files under `prefix` are exactly `files`. Works in a bare repository: nothing is checked out.
 */
export async function commitFiles(git, { parent, files, message, prefix = '', replace = false, index }) {
  const run = gitRunner(git.cwd, { GIT_INDEX_FILE: index });
  const under = (p) => !prefix || p === prefix || p.startsWith(`${prefix}/`);
  // The parent's entries, less the ones `replace` drops; `--index-info` then rebuilds the index from empty.
  const entries = new Map();
  if (parent)
    for (const line of (await run(['ls-tree', '-r', '-z', parent])).stdout.split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t');
      const [mode, , sha] = line.slice(0, tab).split(' ');
      const p = line.slice(tab + 1);
      if (!(replace && under(p))) entries.set(p, `${mode} ${sha}`);
    }
  for (const [file, data] of files) {
    const target = prefix ? `${prefix}/${file}` : file;
    if (data === null) entries.delete(target);
    else entries.set(target, `100644 ${(await run(['hash-object', '-w', '--stdin'], { input: data })).stdout}`);
  }
  await run(['read-tree', '--empty']);
  if (entries.size)
    await run(['update-index', '--add', '--index-info'], {
      input: [...entries].map(([p, v]) => `${v}\t${p}\n`).join(''),
    });
  const { stdout: tree } = await run(['write-tree']);
  const { stdout: sha } = await run(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
  return sha;
}
export function bareGit(dir, extraEnv) {
  const run = gitRunner(dir, extraEnv);
  run.cwd = dir;
  return run;
}

/** The PR branches of a case, each with the tree it holds and the branch it targets. */
export function casePlan(c) {
  if (c.meta.stack) {
    const prs = c.meta.stack;
    return prs.map((pr, i) => ({ step: pr, head: pr, base: i ? prs[i - 1] : 'main', tree: c.trees[pr] }));
  }
  return [{ step: 'pr', head: 'ours', base: 'main', tree: c.trees.ours }];
}

/** Normalised for comparison: whitespace runs collapse and line endings do not matter. */
/** Whitespace runs collapse, and whitespace next to punctuation goes: `f( a ,b )` and `f(a, b)` compare equal. */
export const squash = (text) =>
  text
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([^\w\s$]) ?/g, '$1')
    .trim();
/** Also without semicolons: only layout and empty statements differ. */
export const bare = (text) => squash(text).replace(/[;\s]/g, '');
export const sortedLines = (text) =>
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .sort()
    .join('\n');
