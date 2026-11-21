import { prepareReviewHunk } from './review-diff';
import type { DiffHunk } from './types';

/**
 * Diffs in chat messages. A closed ```diff or ```patch fence whose hunks Gnosis can read becomes a Words island
 * (`island-diff`), which ChatMarkdown mounts as a diff rendered the way Changes renders one (ReviewDiff). A fence still
 * streaming, or one without readable hunks, stays a code block, highlighted as a diff.
 */

/** The island's name: Words reads ```island-diff fences. */
export const CHAT_DIFF_ISLAND = 'diff';
const LANGUAGES = new Set(['diff', 'patch']);

export interface ChatDiffFile {
  /** The file's path, or '' when the patch names none. */
  path: string;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const stripPrefix = (path: string) => path.replace(/^[ab]\//, '');

/** The files and hunks of a fenced patch, or undefined when it has a line no hunk can hold, or no hunk at all. */
export function parseChatDiff(patch: string): ChatDiffFile[] | undefined {
  const files: ChatDiffFile[] = [];
  let file: ChatDiffFile | undefined;
  let hunk: { header: string; lines: string[] } | undefined;
  const closeHunk = () => {
    if (!hunk) return;
    const content = hunk.lines.join('\n');
    file ??= { path: '', hunks: [] };
    if (!files.includes(file)) files.push(file);
    file.hunks.push({ filePath: file.path, hunkHeader: hunk.header, content, language: '', renderedHtml: '' });
    hunk = undefined;
  };
  const startFile = (path: string) => {
    closeHunk();
    file = { path, hunks: [] };
  };
  const lines = patch.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      startFile(git[2]);
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const after = lines[i + 1].slice(4).trim();
      const before = line.slice(4).trim();
      const path = stripPrefix(after === '/dev/null' ? before : after);
      if (!file || file.hunks.length || hunk) startFile(path);
      else file.path = path;
      i++;
      continue;
    }
    const header = HUNK.exec(line);
    if (header) {
      closeHunk();
      hunk = { header: header[0], lines: [] };
      continue;
    }
    if (!hunk) {
      // Git's file metadata between `diff --git` and the first hunk.
      if (
        file &&
        /^(index |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) |Binary files )/.test(
          line
        )
      )
        continue;
      return undefined;
    }
    // A model often drops the space of an empty context line.
    if (line === '') hunk.lines.push(' ');
    else if (/^[ +\-\\]/.test(line)) hunk.lines.push(line);
    else return undefined;
  }
  closeHunk();
  for (const each of files) for (const h of each.hunks) h.filePath = each.path;
  if (!files.length || files.some((each) => each.hunks.some((h) => !prepareReviewHunk(h)))) return undefined;
  return files;
}

/**
 * Rewrites each closed, readable ```diff or ```patch fence of `markdown` as an `island-diff` fence for Words, numbered
 * in order so an island keeps its id, and its state, while the rest of the message streams in.
 */
export function withDiffIslands(markdown: string): string {
  if (!/(```|~~~)\s*(diff|patch)\b/i.test(markdown)) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    const [, marker, info] = open;
    const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    // Unclosed: it is still streaming, or the message ends inside it. Words shows it as code.
    if (end >= lines.length) {
      out.push(...lines.slice(i));
      break;
    }
    const body = lines.slice(i + 1, end).join('\n');
    const files = LANGUAGES.has(info.toLowerCase()) ? parseChatDiff(body) : undefined;
    if (files) out.push('```island-' + CHAT_DIFF_ISLAND, JSON.stringify({ id: `diff-${count++}`, patch: body }), '```');
    else {
      if (LANGUAGES.has(info.toLowerCase())) count++;
      out.push(...lines.slice(i, end + 1));
    }
    i = end;
  }
  return out.join('\n');
}
