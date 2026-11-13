import type { ChangedFile } from './types';

// Approach from quarterdeck crates/github/src/unified_diff.rs (used with permission). Unlike quarterdeck, quoted paths
// are decoded, including the octal escapes git writes for non-ASCII bytes, and `---`/`+++` paths lose git's trailing tab.

/** The line that starts each file's section of a `git diff`. */
const FILE_HEADER = 'diff --git ';
/** The path git writes for the missing side of an added or deleted file. */
const NO_FILE = '/dev/null';
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * A path as git writes it. A quoted path (`"…"`) has C escapes; `\ooo` octal escapes are bytes, so a run of them
 * spells one UTF-8 character. Returns the decoded path and the text after it.
 */
function readPath(text: string): { path: string; rest: string } | undefined {
  if (!text.startsWith('"')) return { path: text, rest: '' };
  const bytes: number[] = [];
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (char === '"') return { path: Buffer.from(bytes).toString('utf8'), rest: text.slice(i + 1) };
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = text[++i] ?? '';
    const octal = /^[0-7]{3}/.exec(text.slice(i, i + 3));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else if (next in ESCAPES) bytes.push(ESCAPES[next]);
    else return;
  }
}
/** A whole `rename from`, `---` or similar value: quoted or not, without git's trailing tab. */
function unquote(text: string): string {
  const value = text.endsWith('\t') ? text.slice(0, -1) : text;
  return (value.startsWith('"') ? readPath(value)?.path : undefined) ?? value;
}
/** The path of a `---`/`+++` line without its `a/`/`b/` prefix; undefined for `/dev/null`. */
function sidePath(text: string, prefix: string): string | undefined {
  const path = unquote(text);
  if (path === NO_FILE) return;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
/**
 * The two paths of `diff --git a/OLD b/NEW`. Unquoted paths with spaces are ambiguous, so when the halves differ the
 * split that gives two equal paths wins (the common unchanged-path case), else the first ` b/`.
 */
function headerPaths(line: string): [string, string] | undefined {
  const paths = line.slice(FILE_HEADER.length);
  if (paths.startsWith('"')) {
    const old = readPath(paths);
    if (!old?.path.startsWith('a/')) return;
    const rest = old.rest.trimStart();
    const next = unquote(rest);
    return next.startsWith('b/') ? [old.path.slice(2), next.slice(2)] : undefined;
  }
  if (!paths.startsWith('a/')) return;
  const quoted = paths.indexOf(' "b/');
  if (quoted > 0) {
    const next = readPath(paths.slice(quoted + 1));
    return next ? [paths.slice(2, quoted), next.path.slice(2)] : undefined;
  }
  const rest = paths.slice(2);
  const half = Math.floor((rest.length - 3) / 2);
  if (half > 0 && rest.slice(half, half + 3) === ' b/' && rest.slice(0, half) === rest.slice(half + 3))
    return [rest.slice(0, half), rest.slice(half + 3)];
  const split = rest.indexOf(' b/');
  return split < 0 ? undefined : [rest.slice(0, split), rest.slice(split + 3)];
}
/** The blob after the change in `index OLD..NEW [mode]`; undefined when it is all zeros (the file was deleted). */
function newBlob(value: string): string | undefined {
  const blob = value.split(/\s/)[0].split('..')[1] ?? '';
  return /^[a-f\d]+$/i.test(blob) && !/^0+$/.test(blob) ? blob.toLowerCase() : undefined;
}

type Kind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';
/** The file one section describes; undefined when no path can be read. */
function fileOf(section: string[]): ChangedFile | undefined {
  let firstHunk = section.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) firstHunk = section.length;
  let kind: Kind = 'modified',
    oldPath: string | undefined,
    newPath: string | undefined,
    blob: string | undefined;
  // Extended headers say how the file changed; lines not read here (modes, similarity, `Binary files …`) change nothing.
  for (const line of section.slice(1, firstHunk)) {
    if (line.startsWith('new file mode')) kind = 'added';
    else if (line.startsWith('deleted file mode')) kind = 'deleted';
    else if (line.startsWith('rename from ')) [kind, oldPath] = ['renamed', unquote(line.slice(12))];
    else if (line.startsWith('rename to ')) [kind, newPath] = ['renamed', unquote(line.slice(10))];
    else if (line.startsWith('copy from ')) [kind, oldPath] = ['copied', unquote(line.slice(10))];
    else if (line.startsWith('copy to ')) [kind, newPath] = ['copied', unquote(line.slice(8))];
    else if (line.startsWith('--- ')) oldPath ??= sidePath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) newPath ??= sidePath(line.slice(4), 'b/');
    else if (line.startsWith('index ')) blob = newBlob(line.slice(6));
  }
  const header = headerPaths(section[0]);
  if (!header) return;
  const before = oldPath ?? header[0],
    after = newPath ?? header[1];
  const hunks = section.slice(firstHunk);
  let additions = 0,
    deletions = 0;
  for (const line of hunks) {
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return {
    filename: kind === 'deleted' ? before : after,
    // A copy's source still exists, so the copy reads as a new file.
    status: kind === 'copied' ? 'added' : kind,
    ...(kind === 'renamed' ? { previous_filename: before } : {}),
    additions,
    deletions,
    ...(hunks.length ? { patch: hunks.join('\n') } : {}),
    ...(blob && kind !== 'deleted' ? { sha: blob } : {}),
  };
}

/**
 * Splits a whole `git diff` (GitHub's `application/vnd.github.diff` answer) into changed files shaped like the PR files
 * list: the patch starts at the first hunk header and is absent for binary files, mode changes and pure renames.
 * Additions and deletions are counted from the `+` and `-` lines. Blob SHAs are git's abbreviations.
 */
export function filesOfUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let section: string[] | undefined;
  const finish = () => {
    const file = section && fileOf(section);
    if (file) files.push(file);
  };
  // Only `\n` ends a line: a CR belongs to the content of CRLF files.
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith(FILE_HEADER)) {
      finish();
      section = [line];
    } else section?.push(line);
  }
  finish();
  return files;
}
