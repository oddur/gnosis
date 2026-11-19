import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { syntaxLanguage } from './syntax-scope';
import { noiseKey, onNoise, peekFileNoise, peekNoise, readNoise } from './syntax-scope-client';
import { blockKey, fileNoise, noiseFilterOn, noiseLabel, type NoiseBlock, type NoiseFilter, type NoiseKind } from './semantic-noise';
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
  priority: SyntaxPriority;
  /** The hunks are the file's whole diff, not an Explanation topic's few. */
  whole: boolean;
}): { blocks?: readonly NoiseBlock[]; kinds: ReadonlyMap<string, NoiseKind> } {
  const language = enabled && after !== undefined && hunks?.length ? syntaxLanguage(path) : undefined;
  const key = language && hunks ? noiseKey(fileKey, hunks) : undefined;
  const [state, setState] = useState<{ key: string; blocks?: NoiseBlock[] }>();
  useEffect(() => {
    if (!key || !language || after === undefined || !hunks) return;
    let cancelled = false;
    void readNoise({ fileKey, url, language, text: after, hunks, priority, whole })
      .catch(() => undefined)
      .then((blocks) => {
        if (!cancelled) setState({ key, blocks });
      });
    return () => {
      cancelled = true;
    };
  }, [key, after, priority]);
  const blocks = !key ? undefined : state?.key === key ? state.blocks : peekNoise(key);
  const kinds = useMemo(() => (blocks ? new Map(blocks.map((block) => [blockKey(block), block.kind])) : NO_KINDS), [blocks]);
  return { blocks, kinds };
}

/**
 * The files of a list whose every change the filter hides, as `key NUL label NUL lines` lines: for views that list
 * files, such as the file tree and the progress. It changes only when one of these files' comparisons does, so a
 * comparison of another view's file renders nothing here.
 */
export function useQuietSignature(
  /** Each file's key in the list, and its revision key (`changeFileKey`), which comparisons are kept under. */
  files: readonly { key: string; fileKey: string }[],
  filter: NoiseFilter
): string {
  const snapshot = () => {
    if (!noiseFilterOn(filter)) return '';
    const lines: string[] = [];
    for (const entry of files) {
      const blocks = peekFileNoise(entry.fileKey);
      if (!blocks) continue;
      const noise = fileNoise(blocks, filter);
      if (noise.all) lines.push(`${entry.key}\u0000${noiseLabel(noise.kinds)}\u0000${noise.added + noise.deleted}`);
    }
    return lines.join('\n');
  };
  return useSyncExternalStore(onNoise, snapshot);
}
