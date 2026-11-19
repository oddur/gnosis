import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { syntaxLanguage } from './syntax-scope';
import { noiseKey, noiseRevision, onNoise, peekFileNoise, peekNoise, readNoise } from './syntax-scope-client';
import { blockKey, type NoiseBlock, type NoiseKind } from './semantic-noise';
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

/** Re-renders when any comparison lands: for views that list files, such as the file tree and the PR's stats. */
export function useNoiseRevision(): number {
  return useSyncExternalStore(onNoise, noiseRevision);
}
export { peekFileNoise };
