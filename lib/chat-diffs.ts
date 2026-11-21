import { prepareReviewHunk } from './review-diff';
import type { DiffHunk } from './types';

/**
 * Diffs and diagrams in chat messages. A closed ```diff or ```patch fence whose hunks Gnosis can read becomes a Words
 * island (`island-diff`), which ChatMarkdown mounts as a diff rendered the way Changes renders one (ReviewDiff). Closed
 * ```mermaid and ```d2 fences become islands that mount the app's own diagram components, as Explanation and PR
 * descriptions show them. A fence still streaming, or a diff without readable hunks, stays a code block.
 */

/** The island's name: Words reads ```island-diff fences. */
export const CHAT_DIFF_ISLAND = 'diff';
const LANGUAGES = new Set(['diff', 'patch']);

export interface ChatDiffFile {
  /** The file's path, or '' when the patch names none. */
  path: string;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
/** A path from a `---` or `+++` line, without its `a/` or `b/` prefix or a `diff -u` timestamp after a tab. */
const headerPath = (value: string) =>
  value
    .split('\t')[0]
    .trim()
    .replace(/^[ab]\//, '');

const parsed = new Map<string, ChatDiffFile[] | undefined>();
/** The files and hunks of a fenced patch, or undefined when it has a line no hunk can hold, or no hunk at all. */
export function parseChatDiff(patch: string): ChatDiffFile[] | undefined {
  // Each render of a message, and each island, asks again: parse a patch once.
  if (parsed.has(patch)) return parsed.get(patch);
  // Models often get a header's counts wrong: when the counts do not hold, read the hunks up to their boundaries.
  const files = parse(patch, true) ?? parse(patch, false);
  const oldest = parsed.size >= 200 ? parsed.keys().next() : undefined;
  if (oldest && !oldest.done) parsed.delete(oldest.value);
  parsed.set(patch, files);
  return files;
}

/**
 * Strict, a hunk ends where its header's counts end. Lenient, it ends at the next hunk or file header, or the end of
 * the fence, and drops the blank lines that separate it from what follows.
 */
function parse(patch: string, strict: boolean): ChatDiffFile[] | undefined {
  const files: ChatDiffFile[] = [];
  let file: ChatDiffFile | undefined;
  // A hunk takes lines until the counts in its header are used up.
  let hunk: { header: string; lines: string[]; old: number; new: number } | undefined;
  const closeHunk = () => {
    if (!hunk) return;
    // Lenient hunks keep blank lines as '': trailing ones separate, the others are context lines missing their space.
    while (hunk.lines.at(-1) === '') hunk.lines.pop();
    const content = hunk.lines.map((line) => line || ' ').join('\n');
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
    if (hunk) {
      if (line.startsWith('\\')) {
        hunk.lines.push(line);
        continue;
      }
      if (!strict) {
        const boundary =
          HUNK.test(line) ||
          line.startsWith('diff --git ') ||
          (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ '));
        if (!boundary) {
          if (line !== '' && !/^[ +-]/.test(line)) return undefined;
          hunk.lines.push(line);
          continue;
        }
      } else if (hunk.old > 0 || hunk.new > 0) {
        // A model often drops the space of an empty context line.
        const kind = line === '' ? ' ' : line[0];
        if (kind === ' ' && hunk.old > 0 && hunk.new > 0) {
          hunk.old--;
          hunk.new--;
          hunk.lines.push(line === '' ? ' ' : line);
        } else if (kind === '-' && hunk.old > 0) {
          hunk.old--;
          hunk.lines.push(line);
        } else if (kind === '+' && hunk.new > 0) {
          hunk.new--;
          hunk.lines.push(line);
        } else return undefined;
        continue;
      }
      closeHunk();
    }
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      startFile(git[2]);
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const after = lines[i + 1].slice(4);
      const path = headerPath(after.split('\t')[0].trim() === '/dev/null' ? line.slice(4) : after);
      if (!file || file.hunks.length) startFile(path);
      else file.path = path;
      i++;
      continue;
    }
    const header = HUNK.exec(line);
    if (header) {
      // A count left out of the header is 1 (`@@ -3 +3 @@`).
      hunk = { header: header[0], lines: [], old: Number(header[1] || 1), new: Number(header[2] || 1) };
      continue;
    }
    // A blank line between files and hunks separates them.
    if (line.trim() === '') continue;
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
  closeHunk();
  for (const each of files) for (const h of each.hunks) h.filePath = each.path;
  if (!files.length || files.some((each) => each.hunks.some((h) => !prepareReviewHunk(h)))) return undefined;
  return files;
}

/** Diagram islands: Words reads ```island-mermaid and ```island-d2 fences, with the diagram's source. */
export const CHAT_MERMAID_ISLAND = 'mermaid';
export const CHAT_D2_ISLAND = 'd2';

/**
 * Rewrites each closed fence of `markdown` that chat shows as more than code into a Words island fence: a readable
 * ```diff or ```patch becomes `island-diff`, a ```mermaid diagram `island-mermaid` and a ```d2 diagram `island-d2`.
 * Each kind is numbered in order, so an island keeps its id, and its state, while the rest of the message streams in.
 * A fence still open stays code until it closes, so a diagram does not render again on every chunk.
 */
export function withChatIslands(markdown: string): string {
  if (!/(```|~~~)\s*(diff|patch|mermaid|d2)\b/i.test(markdown)) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  const counts = { diff: 0, mermaid: 0, d2: 0 };
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    // A fence in a list item is indented: its island keeps the indentation, so the list goes on around it.
    const [, indent, marker, info] = open;
    const outdent = (line: string) => line.replace(new RegExp(`^ {0,${indent.length}}`), '');
    const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    // Unclosed: it is still streaming, or the message ends inside it. Words shows it as code.
    if (end >= lines.length) {
      out.push(...lines.slice(i));
      break;
    }
    const body = lines
      .slice(i + 1, end)
      .map(outdent)
      .join('\n');
    const language = info.toLowerCase();
    const kind = LANGUAGES.has(language) ? 'diff' : language === 'mermaid' || language === 'd2' ? language : undefined;
    // Every fence of a kind has its place in the count, so one shown as code never shifts the ids after it.
    const id = kind ? `${kind}-${counts[kind]++}` : '';
    const data =
      kind === 'diff'
        ? parseChatDiff(body) && { id, patch: body }
        : kind && body.trim()
          ? { id, source: body.trimEnd() }
          : undefined;
    if (kind && data) out.push(`${indent}\`\`\`island-${kind}`, indent + JSON.stringify(data), `${indent}\`\`\``);
    else out.push(...lines.slice(i, end + 1));
    i = end;
  }
  return out.join('\n');
}
