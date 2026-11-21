/**
 * Citations in chat answers.
 *
 * The chat prompts ask the model to cite code as `[path:start-end]` or `[path:line]` (CHAT_CITATION_INSTRUCTION),
 * with the repository-relative path and new-file line numbers, and web pages as `[https://…]`. Before Words renders
 * an answer, withChatCitations turns each such bracket, outside code, into an inline island,
 * `:cite[queue.ts:40–52]{path="src/queue.ts" start="40" end="52" raw="…"}`, which ChatMarkdown mounts as an
 * InlineCitation.
 *
 * Parsing is not trust. A citation shows as a citation only when resolveChatCitation finds its file among the files
 * of the PR (or the URL is http or https); anything else renders as the plain text the model wrote. An island the
 * model wrote itself goes through the same check. No React imports.
 */

export const CHAT_CITATION_ISLAND = 'cite';

export const CHAT_CITATION_INSTRUCTION =
  'When a statement rests on specific code in this PR, cite it right after the statement as [path:start-end], or [path:line] for one line, using the repository-relative path and the line numbers of the new version of the file (the old version for removed code), for example [src/queue.ts:40-52]. Cite only files that appear in the supplied diff or file, and only lines you were given. Cite a web page as [https://example.com/page]. Never put a citation inside a code block.';

export type ChatCitation =
  | { kind: 'file'; path: string; startLine?: number; endLine?: number; raw: string }
  | { kind: 'url'; url: string; raw: string };

export type ResolvedCitation =
  | { kind: 'file'; path: string; startLine?: number; endLine?: number; raw: string; label: string }
  | { kind: 'url'; url: string; host: string; raw: string; label: string };

/** The widest range a citation may claim: a whole long file is a file citation, not a line citation. */
const MAX_RANGE = 2000;
const PATH = String.raw`[A-Za-z0-9_@~+\-][A-Za-z0-9_@~+.\-/]*`;
const FILE_CITATION = new RegExp(String.raw`^(?:\.\/)?(${PATH})(?::L?(\d+)(?:\s*[-–—]\s*L?(\d+))?)?$`);

const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

/** One citation's text, without its brackets: `src/queue.ts:40-52`, `queue.ts:7`, `https://…`. */
export function parseChatCitation(text: string): ChatCitation | undefined {
  const raw = text.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return url.protocol === 'http:' || url.protocol === 'https:' ? { kind: 'url', url: url.href, raw } : undefined;
    } catch {
      return undefined;
    }
  }
  const match = FILE_CITATION.exec(raw);
  if (!match) return undefined;
  const path = match[1];
  // A path needs a directory or an extension: `[note]` and `[x]` are prose, not files.
  if (!path.includes('/') && !/\.[A-Za-z0-9]+$/.test(path)) return undefined;
  if (path.endsWith('/') || path.includes('//') || path.split('/').some((part) => part === '..')) return undefined;
  if (!match[2]) return { kind: 'file', path, raw };
  const a = Number(match[2]);
  const b = match[3] ? Number(match[3]) : a;
  return { kind: 'file', path, startLine: a, endLine: b, raw };
}

/** `queue.ts:40–52`, `queue.ts:7`, `queue.ts`; a page shows its host. */
export function citationLabel(citation: ChatCitation): string {
  if (citation.kind === 'url') return hostOf(citation.url);
  const name = baseName(citation.path);
  if (!citation.startLine) return name;
  return citation.endLine && citation.endLine !== citation.startLine
    ? `${name}:${citation.startLine}–${citation.endLine}`
    : `${name}:${citation.startLine}`;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const normalizePath = (path: string) => path.replace(/^\.\//, '').replace(/^[ab]\//, '');

/**
 * The citation as the PR knows it, or undefined. A file resolves when its path is a PR file, or ends one PR file's
 * path after a `/` and no other's (the model wrote `queue.ts` for `src/queue.ts`). Lines must be positive, in order,
 * and span at most 2,000 lines.
 */
export function resolveChatCitation(
  citation: ChatCitation | undefined,
  files: readonly string[]
): ResolvedCitation | undefined {
  if (!citation) return undefined;
  if (citation.kind === 'url') {
    const host = hostOf(citation.url);
    return { ...citation, host, label: host };
  }
  const { startLine, endLine } = citation;
  if (startLine !== undefined) {
    if (!Number.isSafeInteger(startLine) || startLine < 1) return undefined;
    if (endLine === undefined || !Number.isSafeInteger(endLine) || endLine < startLine) return undefined;
    if (endLine - startLine > MAX_RANGE) return undefined;
  }
  const wanted = normalizePath(citation.path);
  let path = files.find((file) => file === wanted || file === citation.path);
  if (!path) {
    const matches = files.filter((file) => file.endsWith(`/${wanted}`));
    if (matches.length !== 1) return undefined;
    path = matches[0];
  }
  const resolved = { ...citation, path };
  return { ...resolved, label: citationLabel(resolved) };
}

/** Values in a directive's attributes: quoted, with quotes and backslashes escaped. */
const attribute = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** A directive's label is plain text in brackets: escape what would end or nest it. */
const label = (value: string) => value.replace(/[\\[\]]/g, (c) => `\\${c}`);

function directive(citation: ChatCitation): string {
  const attrs =
    citation.kind === 'url'
      ? [`url=${attribute(citation.url)}`]
      : [
          `path=${attribute(citation.path)}`,
          ...(citation.startLine
            ? [`start="${citation.startLine}"`, `end="${citation.endLine ?? citation.startLine}"`]
            : []),
        ];
  return `:${CHAT_CITATION_ISLAND}[${label(citationLabel(citation))}]{${attrs.join(' ')} raw=${attribute(citation.raw)}}`;
}

/**
 * A bracket holding one or more citations, separated by commas or semicolons. A bracket that is a link (`[a](b)`,
 * `[a][b]`), an image, or holds anything that is not a citation stays as it is.
 */
const BRACKET = /(!?)\[([^[\]\n]{1,400})\](?![([:])/g;

function citeLine(line: string): string {
  // Inline code spans keep their text: split on backtick runs and only touch the parts outside code.
  const parts = line.split(/(`+[^`]*`+)/);
  return parts
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(BRACKET, (whole: string, bang: string, inner: string) => {
            if (bang) return whole;
            const pieces = inner.split(/\s*[,;]\s*/).filter(Boolean);
            const citations = pieces.map(parseChatCitation);
            if (!citations.length || citations.some((c) => !c)) return whole;
            return (citations as ChatCitation[]).map(directive).join(' ');
          })
    )
    .join('');
}

/** Turn citations outside code into citation islands. Fenced and indented code is left alone. */
export function withChatCitations(markdown: string): string {
  if (!markdown.includes('[')) return markdown;
  const lines = markdown.split('\n');
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim())
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    // Indented code: four spaces or a tab, outside a list's continuation (a guess Words also makes from context).
    if (/^( {4}|\t)/.test(line) && (i === 0 || !lines[i - 1].trim())) continue;
    if (line.includes('[')) lines[i] = citeLine(line);
  }
  return lines.join('\n');
}

/** Rebuild a citation from an island's attributes, as Words passes them (all strings). */
export function citationFromIsland(data: Readonly<Record<string, unknown>>): ChatCitation | undefined {
  const raw = typeof data.raw === 'string' ? data.raw : typeof data.label === 'string' ? data.label : '';
  if (typeof data.url === 'string') {
    const parsed = parseChatCitation(data.url);
    return parsed?.kind === 'url' ? { ...parsed, raw } : undefined;
  }
  if (typeof data.path !== 'string') return undefined;
  const start = typeof data.start === 'string' && /^\d+$/.test(data.start) ? Number(data.start) : undefined;
  const end = typeof data.end === 'string' && /^\d+$/.test(data.end) ? Number(data.end) : start;
  return { kind: 'file', path: data.path, ...(start ? { startLine: start, endLine: end } : {}), raw };
}

/** New-file lines a diff hunk shows, by line number, for a citation's preview. Removed lines are left out. */
export function hunkNewLines(hunkHeader: string, content: string): Map<number, string> {
  const lines = new Map<number, string>();
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunkHeader.trim());
  if (!match) return lines;
  let line = Number(match[1]);
  for (const row of content.split('\n')) {
    if (row.startsWith('-') || row.startsWith('\\')) continue;
    lines.set(line, row.startsWith('+') || row.startsWith(' ') ? row.slice(1) : row);
    line++;
  }
  return lines;
}
