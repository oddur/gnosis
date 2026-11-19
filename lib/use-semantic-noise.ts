import { useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from 'react';
import { syntaxLanguage } from './syntax-scope';
import { noiseKey, onNoise, peekFileNoise, peekNoise, readNoise } from './syntax-scope-client';
import { blockKey, fileNoise, noiseLabel, type NoiseBlock, type NoiseFilter, type NoiseKind } from './semantic-noise';
import type { SyntaxPriority } from './syntax-parse-queue';
import type { GapHunk } from './diff-gaps';

const NO_KINDS: ReadonlyMap<string, NoiseKind> = new Map();

/**
 * A file's formatting-only and comment-only changes (#396), compared in the worker from text the view already has: the
 * new side and its hunks. Only asked for while the reader hides some noise. The result keeps each change block's kind
 * by where it starts (`blockKey`); until it lands, and for a file it cannot compare, every block shows.
 */
export function useSemanticNoise({
  fileKey,
  url,
  path,
  after,
  hunks,
  enabled,
  priority,
  whole,
}: {
  fileKey: string;
  url: string;
  path: string;
  after?: string;
  hunks?: GapHunk[];
  enabled: boolean;
  /** Where the file is, as the view last saw it (lib/syntax-parse-queue.ts); a move raises a waiting comparison. */
  priority: RefObject<SyntaxPriority>;
  /** The hunks are the file's whole diff, not an Explanation topic's few. */
  whole: boolean;
}): { blocks?: readonly NoiseBlock[]; kinds: ReadonlyMap<string, NoiseKind>; key?: string; pending: boolean } {
  const language = enabled && after !== undefined && hunks?.length ? syntaxLanguage(path) : undefined;
  const key = language && hunks ? noiseKey(fileKey, hunks) : undefined;
  const [state, setState] = useState<{ key: string; blocks?: NoiseBlock[] }>();
  useEffect(() => {
    if (!key || !language || after === undefined || !hunks) return;
    let cancelled = false;
    void readNoise({ fileKey, url, language, text: after, hunks, priority: priority.current ?? 'view', whole })
      .catch(() => undefined)
      .then((blocks) => {
        if (!cancelled) setState({ key, blocks });
      });
    return () => {
      cancelled = true;
    };
  }, [key, after]);
  const settled = !!key && state?.key === key;
  const blocks = !key ? undefined : settled ? state.blocks : peekNoise(key);
  const kinds = useMemo(() => (blocks ? new Map(blocks.map((block) => [blockKey(block), block.kind])) : NO_KINDS), [blocks]);
  return { blocks, kinds, key, pending: !!key && !settled && !blocks };
}


/** One file of a list as the filter sees it, once compared. */
export interface QuietFile {
  /** Every change is hidden: the file's label, such as "Formatting only", or "Reformatted". */
  label?: string;
  /** Hidden lines, and lines that show. */
  hidden: number;
  shown: number;
  lines: { whitespace: number; formatting: number; comments: number };
}
/** A list of files as the filter sees it: each compared file, and the totals over them. */
export interface QuietSummary {
  files: ReadonlyMap<string, QuietFile>;
  /** Files compared so far. */
  compared: number;
  /** Files whose every change is hidden. */
  quiet: number;
  /** Files with some hidden lines. */
  touched: number;
  lines: { whitespace: number; formatting: number; comments: number };
  /** Lines that show, in compared files. */
  shown: number;
}
const EMPTY: QuietSummary = { files: new Map(), compared: 0, quiet: 0, touched: 0, lines: { whitespace: 0, formatting: 0, comments: 0 }, shown: 0 };
const SEP = '\u0000';

/**
 * A list of files as the filter sees it, for views that list files: the file tree, the progress, the quiet changes
 * summary. The store's snapshot is a string of the compared files, so a comparison of another view's file renders
 * nothing here, and a new comparison of one of these files renders once.
 */
export function useQuietSummary(
  /** Each file's key in the list, and its revision key (`changeFileKey`), which comparisons are kept under. */
  files: readonly { key: string; fileKey: string }[],
  filter: NoiseFilter
): QuietSummary {
  const snapshot = () => {
    const rows: string[] = [];
    for (const entry of files) {
      const blocks = peekFileNoise(entry.fileKey);
      if (!blocks) continue;
      const noise = fileNoise(blocks, filter);
      const label = noise.all ? (noise.reformatted ? 'Reformatted' : noiseLabel(noise.kinds)) : '';
      rows.push([entry.key, label, noise.lines.whitespace, noise.lines.formatting, noise.lines.comments, noise.shown].join(SEP));
    }
    return rows.join('\n');
  };
  const rowsText = useSyncExternalStore(onNoise, snapshot);
  return useMemo(() => {
    if (!rowsText) return EMPTY;
    const map = new Map<string, QuietFile>();
    const summary = { compared: 0, quiet: 0, touched: 0, lines: { whitespace: 0, formatting: 0, comments: 0 }, shown: 0 };
    for (const row of rowsText.split('\n')) {
      const [key, label, whitespace, formatting, comments, shown] = row.split(SEP);
      const lines = { whitespace: Number(whitespace), formatting: Number(formatting), comments: Number(comments) };
      const hiddenLines = lines.whitespace + lines.formatting + lines.comments;
      map.set(key, { label: label || undefined, hidden: hiddenLines, shown: Number(shown), lines });
      summary.compared++;
      if (label) summary.quiet++;
      if (hiddenLines) summary.touched++;
      summary.lines.whitespace += lines.whitespace;
      summary.lines.formatting += lines.formatting;
      summary.lines.comments += lines.comments;
      summary.shown += Number(shown);
    }
    return { files: map, ...summary };
  }, [rowsText]);
}
