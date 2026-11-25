import type { DiffHunk } from './types';
import { inferLanguage } from './highlight';

// ── Types ────────────────────────────────────────────────────────

export interface ParsedHunk {
  id: string;
  filePath: string;
  fileStatus: 'added' | 'deleted' | 'modified' | 'renamed';
  hunkHeader: string;
  content: string;
  additions: number;
  deletions: number;
  scopeName: string | null;
}

export interface IndexedHunk extends ParsedHunk {
  language: string;
  expandedHunkHeader: string;
  expandedContent: string;
}

// ── Hunk header parsing ─────────────────────────────────────────

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;

export function parseHunkHeader(header: string) {
  const m = header.match(HUNK_HEADER_RE);
  if (!m) return null;
  return {
    baseStart: parseInt(m[1], 10),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- regex optional group can be undefined at runtime
    baseCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
    headStart: parseInt(m[3], 10),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- regex optional group can be undefined at runtime
    headCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- regex optional group
    suffix: m[5] ?? '',
  };
}

function buildHunkHeader(
  baseStart: number,
  baseCount: number,
  headStart: number,
  headCount: number,
  suffix: string
): string {
  return `@@ -${baseStart},${baseCount} +${headStart},${headCount} @@${suffix}`;
}

// ── Parse unified diff into per-hunk objects ─────────────────────

export function parseUnifiedDiff(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const lines = diff.split('\n');
  let i = 0;
  let hunkCounter = 0;

  let currentFilePath: string | null = null;
  let currentFileStatus: 'added' | 'deleted' | 'modified' | 'renamed' = 'modified';
  let isRename = false;
  let renameFrom: string | null = null;

  while (i < lines.length) {
    const line = lines[i];

    // diff header
    if (line.startsWith('diff --git')) {
      isRename = false;
      renameFrom = null;
      // Each file starts modified: a status from the file before (an added one) must not carry over.
      currentFileStatus = 'modified';
      i++;
      continue;
    }

    // Detect rename markers
    if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length);
      isRename = true;
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      isRename = true;
      i++;
      continue;
    }

    // similarity / dissimilarity index, old mode, new mode, etc.
    if (
      line.startsWith('index ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('dissimilarity index') ||
      line.startsWith('copy from') ||
      line.startsWith('copy to') ||
      line.startsWith('Binary files')
    ) {
      if (line.startsWith('new file mode')) currentFileStatus = 'added';
      if (line.startsWith('deleted file mode')) currentFileStatus = 'deleted';
      i++;
      continue;
    }

    // --- a/path or --- /dev/null
    if (line.startsWith('--- ')) {
      if (line === '--- /dev/null') {
        currentFileStatus = 'added';
      } else {
        // A deleted file has no +++ path (+++ /dev/null): its path is the old one.
        currentFilePath = line.slice('--- a/'.length);
      }
      i++;
      continue;
    }

    // +++ b/path or +++ /dev/null
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') {
        currentFileStatus = 'deleted';
      } else {
        currentFilePath = line.slice('+++ b/'.length);
        if (isRename && renameFrom) {
          currentFileStatus = 'renamed';
        } else if (currentFileStatus !== 'added' && currentFileStatus !== 'deleted') {
          currentFileStatus = 'modified';
        }
      }
      i++;
      continue;
    }

    // Hunk header
    if (line.startsWith('@@ ') && currentFilePath) {
      const match = line.match(HUNK_HEADER_RE);
      if (!match) {
        i++;
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- regex optional group
      const suffix = match[5] ?? '';
      const scopeName = suffix.trim() || null;

      // Collect hunk body lines
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.startsWith('@@ ') || bodyLine.startsWith('diff --git')) {
          break;
        }
        // Skip "\ No newline at end of file"
        if (bodyLine.startsWith('\\')) {
          i++;
          continue;
        }
        body.push(bodyLine);
        i++;
      }

      // Remove trailing empty lines from split artifact
      while (body.length > 0 && body[body.length - 1] === '') body.pop();

      const content = body.join('\n');

      let additions = 0;
      let deletions = 0;
      for (const bl of body) {
        if (bl.startsWith('+')) additions++;
        else if (bl.startsWith('-')) deletions++;
      }

      hunks.push({
        id: `hunk-${hunkCounter++}`,
        filePath: currentFilePath,
        fileStatus: currentFileStatus,
        hunkHeader: line,
        content,
        additions,
        deletions,
        scopeName,
      });

      continue;
    }

    i++;
  }

  return hunks;
}

// ── Expand context for a single hunk ─────────────────────────────
//
// A context row claims the same text at an old and a new line number. So
// each extra row is taken from both files at once: walking outward from the
// hunk's edges, where the two sides are aligned, while the base line and the
// head line still match, and never into a neighbouring hunk's changed lines.
// Added and deleted files, or a missing side, keep the hunk as it is.

/** Limits on context taken around a hunk, as 0-based line indices: min inclusive, max exclusive. */
interface ContextBounds {
  minBase: number;
  minHead: number;
  maxBase: number;
  maxHead: number;
}

/** File text as lines, without the empty element after a final newline. */
function sourceLines(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The 0-based line range a hunk header covers on each side (a 0 count names the line before). */
function hunkRange(parsed: NonNullable<ReturnType<typeof parseHunkHeader>>) {
  const base0 = parsed.baseCount === 0 ? parsed.baseStart : parsed.baseStart - 1;
  const head0 = parsed.headCount === 0 ? parsed.headStart : parsed.headStart - 1;
  return { base0, baseEnd: base0 + parsed.baseCount, head0, headEnd: head0 + parsed.headCount };
}

/** Bounds that stop context at the changed lines of the other hunks in the same file. */
function boundsFromNeighbours(header: string, neighbours: readonly string[]): ContextBounds {
  const bounds: ContextBounds = { minBase: 0, minHead: 0, maxBase: Infinity, maxHead: Infinity };
  const own = parseHunkHeader(header);
  if (!own) return bounds;
  const self = hunkRange(own);
  for (const other of neighbours) {
    if (other === header) continue;
    const parsed = parseHunkHeader(other);
    if (!parsed) continue;
    const r = hunkRange(parsed);
    if (r.baseEnd <= self.base0 && r.headEnd <= self.head0) {
      bounds.minBase = Math.max(bounds.minBase, r.baseEnd);
      bounds.minHead = Math.max(bounds.minHead, r.headEnd);
    } else if (r.base0 >= self.baseEnd && r.head0 >= self.headEnd) {
      bounds.maxBase = Math.min(bounds.maxBase, r.base0);
      bounds.maxHead = Math.min(bounds.maxHead, r.head0);
    }
  }
  return bounds;
}

function expandHunkBody(
  header: string,
  body: string[],
  baseLines: string[] | undefined,
  headLines: string[] | undefined,
  targetContext: number,
  bounds: ContextBounds
): { expandedHunkHeader: string; expandedContent: string } | null {
  const parsed = parseHunkHeader(header);
  if (!parsed || !baseLines || !headLines || body.length === 0) return null;

  let leadCtx = 0;
  for (const line of body) {
    if (line.startsWith(' ')) leadCtx++;
    else break;
  }
  let trailCtx = 0;
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j].startsWith(' ')) trailCtx++;
    else if (body[j].startsWith('\\')) continue;
    else break;
  }

  const { base0, head0 } = hunkRange(parsed);
  let baseEnd = base0;
  let headEnd = head0;
  for (const line of body) {
    if (line.startsWith(' ')) {
      baseEnd++;
      headEnd++;
    } else if (line.startsWith('-')) baseEnd++;
    else if (line.startsWith('+')) headEnd++;
  }

  const prepend: string[] = [];
  for (let k = 1; k <= Math.max(0, targetContext - leadCtx); k++) {
    const b = base0 - k;
    const h = head0 - k;
    if (b < bounds.minBase || h < bounds.minHead || b >= baseLines.length || h >= headLines.length) break;
    if (baseLines[b] !== headLines[h]) break;
    prepend.unshift(' ' + baseLines[b]);
  }

  const append: string[] = [];
  for (let k = 0; k < Math.max(0, targetContext - trailCtx); k++) {
    const b = baseEnd + k;
    const h = headEnd + k;
    if (b >= bounds.maxBase || h >= bounds.maxHead || b >= baseLines.length || h >= headLines.length) break;
    if (baseLines[b] !== headLines[h]) break;
    append.push(' ' + baseLines[b]);
  }

  if (prepend.length === 0 && append.length === 0) return null;

  const extra = prepend.length + append.length;
  const baseCount = baseEnd - base0 + extra;
  const headCount = headEnd - head0 + extra;
  const expandedHunkHeader = buildHunkHeader(
    base0 - prepend.length + 1,
    baseCount,
    head0 - prepend.length + 1,
    headCount,
    parsed.suffix
  );
  return { expandedHunkHeader, expandedContent: [...prepend, ...body, ...append].join('\n') };
}

/**
 * Add up to `targetContext` lines of unchanged context around a hunk. Pass the
 * headers of the file's other hunks as `neighbours` so context stops at them.
 */
export function expandHunkContext(
  hunk: ParsedHunk,
  filesBefore: Record<string, string>,
  filesAfter: Record<string, string>,
  targetContext = 15,
  neighbours: readonly string[] = []
): { expandedHunkHeader: string; expandedContent: string } {
  const unchanged = { expandedHunkHeader: hunk.hunkHeader, expandedContent: hunk.content };
  if (hunk.fileStatus === 'added' || hunk.fileStatus === 'deleted') return unchanged;
  const baseLines = sourceLines(filesBefore[hunk.filePath]);
  const headLines = sourceLines(filesAfter[hunk.filePath]);
  const body = hunk.content.split('\n').filter((line) => line !== '');
  return (
    expandHunkBody(
      hunk.hunkHeader,
      body,
      baseLines,
      headLines,
      targetContext,
      boundsFromNeighbours(hunk.hunkHeader, neighbours)
    ) ?? unchanged
  );
}

// ── Full pipeline: parse → expand → index ────────────────────────

export function buildIndexedHunks(
  diff: string,
  filesBefore: Record<string, string>,
  filesAfter: Record<string, string>,
  targetContext = 15
): IndexedHunk[] {
  const parsed = parseUnifiedDiff(diff);
  const headersByFile = new Map<string, string[]>();
  for (const hunk of parsed) {
    const headers = headersByFile.get(hunk.filePath) ?? [];
    headers.push(hunk.hunkHeader);
    headersByFile.set(hunk.filePath, headers);
  }

  return parsed.map((hunk) => {
    const { expandedHunkHeader, expandedContent } = expandHunkContext(
      hunk,
      filesBefore,
      filesAfter,
      targetContext,
      headersByFile.get(hunk.filePath)
    );
    const language = inferLanguage(hunk.filePath);

    return {
      ...hunk,
      language,
      expandedHunkHeader,
      expandedContent,
    };
  });
}

// ── Expand full diff as a single string ──────────────────────────
// The same context rows as expandHunkContext, for the whole diff.

export function expandFullDiff(
  diff: string,
  filesBefore: Record<string, string>,
  filesAfter: Record<string, string>,
  targetContext = 15
): string {
  const result: string[] = [];
  let basePath: string | null = null;
  let headPath: string | null = null;
  let fileHeaders: string[] = [];
  const lines = diff.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff ')) {
      basePath = null;
      headPath = null;
      fileHeaders = [];
    } else if (line.startsWith('--- ')) {
      basePath = line.startsWith('--- a/') ? line.slice('--- a/'.length) : null;
    } else if (line.startsWith('+++ ')) {
      headPath = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : null;
      // The file's hunk headers, so context stops at a neighbouring hunk.
      fileHeaders = [];
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('diff '); j++)
        if (lines[j].startsWith('@@ ')) fileHeaders.push(lines[j]);
    }

    if (!line.startsWith('@@ ')) {
      result.push(line);
      i++;
      continue;
    }

    i++;
    const body: string[] = [];
    while (i < lines.length && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff ')) {
      body.push(lines[i]);
      i++;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();

    // Added and deleted files (one path is /dev/null) are already whole. Both
    // content maps are keyed by the file's head path, as for a renamed file.
    const expanded =
      basePath && headPath
        ? expandHunkBody(
            line,
            body,
            sourceLines(filesBefore[headPath]),
            sourceLines(filesAfter[headPath]),
            targetContext,
            boundsFromNeighbours(line, fileHeaders)
          )
        : null;
    if (expanded) result.push(expanded.expandedHunkHeader, expanded.expandedContent);
    else result.push(line, ...body);
  }

  return result.join('\n');
}

// ── Format hunk index as XML for the AI prompt ───────────────────

export function formatHunkIndexForPrompt(hunks: IndexedHunk[]): string {
  const entries = hunks.map((h) => {
    const escapedFile = h.filePath.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const escapedHeader = h.hunkHeader
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `  <hunk id="${h.id}" file="${escapedFile}" header="${escapedHeader}" additions="${h.additions}" deletions="${h.deletions}" />`;
  });

  return `<hunk_index>\n${entries.join('\n')}\n</hunk_index>`;
}

// ── Sort diff hunks by file path then base start line ────────────

export function sortDiffHunks(hunks: DiffHunk[]): DiffHunk[] {
  return [...hunks].sort((a, b) => {
    const pathCmp = a.filePath.localeCompare(b.filePath);
    if (pathCmp !== 0) return pathCmp;

    const aStart = parseHunkHeader(a.hunkHeader)?.baseStart ?? 0;
    const bStart = parseHunkHeader(b.hunkHeader)?.baseStart ?? 0;
    return aStart - bStart;
  });
}
