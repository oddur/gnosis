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

export function expandHunkContext(
  hunk: ParsedHunk,
  filesBefore: Record<string, string>,
  filesAfter: Record<string, string>,
  targetContext = 15
): { expandedHunkHeader: string; expandedContent: string } {
  const parsed = parseHunkHeader(hunk.hunkHeader);
  if (!parsed) {
    return { expandedHunkHeader: hunk.hunkHeader, expandedContent: hunk.content };
  }

  // Choose source file for context padding
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
  const baseLines = filesBefore[hunk.filePath]?.split('\n');
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
  const headLines = filesAfter[hunk.filePath]?.split('\n');

  // For added files, context comes from head; for others, from base
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
  const ctxSource = hunk.fileStatus === 'added' ? headLines : (baseLines ?? headLines);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
  if (!ctxSource) {
    return { expandedHunkHeader: hunk.hunkHeader, expandedContent: hunk.content };
  }

  // Parse body lines
  const rawLines = hunk.content.split('\n');
  const bodyLines: { marker: string; text: string }[] = [];
  for (const raw of rawLines) {
    if (raw === '') continue;
    const marker = raw[0];
    bodyLines.push({ marker, text: raw.slice(1) });
  }

  if (bodyLines.length === 0) {
    return { expandedHunkHeader: hunk.hunkHeader, expandedContent: hunk.content };
  }

  // Count existing leading/trailing context
  let leadCtx = 0;
  for (const bl of bodyLines) {
    if (bl.marker === ' ') leadCtx++;
    else break;
  }
  let trailCtx = 0;
  for (let j = bodyLines.length - 1; j >= 0; j--) {
    if (bodyLines[j].marker === ' ') trailCtx++;
    else break;
  }

  // For added files (all + lines), use headStart for positioning
  const hunkStart0 = hunk.fileStatus === 'added' ? parsed.headStart - 1 : parsed.baseStart - 1;

  // Prepend leading context
  const extraLead = Math.max(0, targetContext - leadCtx);
  const prependFrom = Math.max(0, hunkStart0 - extraLead);
  const prepend = ctxSource.slice(prependFrom, hunkStart0).map((l) => ' ' + l);

  // Calculate where the hunk body ends in the source file
  // Walk through body lines to find where base pointer ends
  let basePos = parsed.baseStart - 1;
  let headPos = parsed.headStart - 1;
  for (const bl of bodyLines) {
    if (bl.marker === ' ') {
      basePos++;
      headPos++;
    } else if (bl.marker === '-') {
      basePos++;
    } else if (bl.marker === '+') {
      headPos++;
    }
  }
  const hunkEnd0 = hunk.fileStatus === 'added' ? headPos : basePos;

  // Append trailing context
  const extraTrail = Math.max(0, targetContext - trailCtx);
  const appendTo = Math.min(ctxSource.length, hunkEnd0 + extraTrail);
  const append = ctxSource.slice(hunkEnd0, appendTo).map((l) => ' ' + l);

  // Rebuild hunk header with new counts
  const allContent = [...prepend, ...rawLines.filter((l) => l !== ''), ...append];

  let newBaseCount = 0;
  let newHeadCount = 0;
  for (const l of allContent) {
    const m = l[0];
    if (m === ' ') {
      newBaseCount++;
      newHeadCount++;
    } else if (m === '-') {
      newBaseCount++;
    } else if (m === '+') {
      newHeadCount++;
    }
  }

  const newBaseStart = Math.max(1, parsed.baseStart - prepend.length);
  const newHeadStart = Math.max(1, parsed.headStart - prepend.length);

  const expandedHunkHeader = buildHunkHeader(newBaseStart, newBaseCount, newHeadStart, newHeadCount, parsed.suffix);
  const expandedContent = allContent.join('\n');

  return { expandedHunkHeader, expandedContent };
}

// ── Full pipeline: parse → expand → index ────────────────────────

export function buildIndexedHunks(
  diff: string,
  filesBefore: Record<string, string>,
  filesAfter: Record<string, string>,
  targetContext = 15
): IndexedHunk[] {
  const parsed = parseUnifiedDiff(diff);

  return parsed.map((hunk) => {
    const { expandedHunkHeader, expandedContent } = expandHunkContext(hunk, filesBefore, filesAfter, targetContext);
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
// Replaces expandDiffContext from context-builder.ts but also
// handles added files by using head file contents.

export function expandFullDiff(
  diff: string,
  filesBefore: Record<string, string>,
  filesAfter: Record<string, string>,
  targetContext = 15
): string {
  const result: string[] = [];
  let currentBasePath: string | null = null;
  let currentFileStatus: 'added' | 'deleted' | 'modified' = 'modified';
  const lines = diff.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('--- /dev/null')) {
      currentBasePath = null;
      currentFileStatus = 'added';
      result.push(line);
      i++;
      continue;
    }

    if (line.startsWith('--- a/')) {
      currentBasePath = line.slice('--- a/'.length);
      currentFileStatus = 'modified';
      result.push(line);
      i++;
      continue;
    }

    if (line.startsWith('+++ /dev/null')) {
      currentFileStatus = 'deleted';
      result.push(line);
      i++;
      continue;
    }

    if (line.startsWith('+++ b/')) {
      const headPath = line.slice('+++ b/'.length);
      if (currentFileStatus === 'added') {
        currentBasePath = headPath; // use headPath for context lookup
      }
      result.push(line);
      i++;
      continue;
    }

    if (!line.startsWith('@@ ')) {
      result.push(line);
      i++;
      continue;
    }

    // Hunk header
    const match = line.match(HUNK_HEADER_RE);

    // Choose file lines for context expansion
    // For added files, use head file; for others, use base file
    let fileLines: string[] | undefined;
    if (currentFileStatus === 'added' && currentBasePath) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
      fileLines = filesAfter[currentBasePath]?.split('\n');
    } else if (currentBasePath) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
      fileLines = filesBefore[currentBasePath]?.split('\n');
    }

    if (!match || !fileLines) {
      result.push(line);
      i++;
      continue;
    }

    const baseStart = parseInt(match[1]);
    const baseCount = parseInt(match[2]) || 1;
    const headStart = parseInt(match[3]);
    const headCount = parseInt(match[4]) || 1;
    const suffix = match[5];

    // Collect hunk body
    i++;
    const body: string[] = [];
    while (i < lines.length && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff ')) {
      body.push(lines[i]);
      i++;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();

    // Count existing leading/trailing context
    let leadCtx = 0;
    for (const bl of body) {
      if (bl.startsWith(' ')) leadCtx++;
      else break;
    }
    let trailCtx = 0;
    for (let j = body.length - 1; j >= 0; j--) {
      if (body[j].startsWith(' ')) trailCtx++;
      else break;
    }

    // For added files, use headStart for positioning
    const hunkStart0 = currentFileStatus === 'added' ? headStart - 1 : baseStart - 1;

    // Prepend extra leading context
    const extraLead = Math.max(0, targetContext - leadCtx);
    const prependFrom = Math.max(0, hunkStart0 - extraLead);
    const prepend = fileLines.slice(prependFrom, hunkStart0).map((l) => ' ' + l);

    // Append extra trailing context
    const extraTrail = Math.max(0, targetContext - trailCtx);
    const hunkEnd0 = currentFileStatus === 'added' ? hunkStart0 + headCount : hunkStart0 + baseCount;
    const appendTo = Math.min(fileLines.length, hunkEnd0 + extraTrail);
    const append = fileLines.slice(hunkEnd0, appendTo).map((l) => ' ' + l);

    // Rebuild hunk header
    const newBaseStart = currentFileStatus === 'added' ? baseStart : Math.max(1, prependFrom + 1);
    const newBaseCount = currentFileStatus === 'added' ? baseCount : prepend.length + baseCount + append.length;
    const newHeadStart =
      currentFileStatus === 'added' ? Math.max(1, headStart - prepend.length) : Math.max(1, headStart - prepend.length);
    const newHeadCount = prepend.length + headCount + append.length;

    result.push(`@@ -${newBaseStart},${newBaseCount} +${newHeadStart},${newHeadCount} @@${suffix}`);
    result.push(...prepend, ...body, ...append);
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
