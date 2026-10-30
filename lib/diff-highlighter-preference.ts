export type DiffHighlighter = 'shiki-js' | 'highlights';

/** A saved choice takes precedence over the developer trial flag. */
export function resolveDiffHighlighter(saved: unknown, fallback: unknown = 'shiki-js'): DiffHighlighter {
  if (saved === 'shiki-js' || saved === 'highlights') return saved;
  return fallback === 'highlights' ? 'highlights' : 'shiki-js';
}
