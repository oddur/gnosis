import { noiseLabel, noiseStat, type FileNoise } from './semantic-noise';

/** What a file header says about its quiet changes (#396), after its `+N −M`. */
export interface QuietHeader {
  /** "Reformatted", "Formatting only", or the hidden lines: "90 formatting · 12 comments". */
  text: string;
  title: string;
  /** The kind that leads, for the icon. */
  kind: 'whitespace' | 'formatting' | 'comments';
  /** When some changes show: the code's own `+N −M`, the file's less the hidden lines. */
  code?: { added: number; deleted: number };
}

/**
 * The file header's words for a file's quiet changes: a whole quiet file names its kind, or "Reformatted" when it
 * reads as a formatter run; a file with code too says how much of each, with the code's own counts first, so the
 * header's `+N −M` is not mistaken for code.
 */
export function quietHeader(noise: FileNoise, additions: number, deletions: number): QuietHeader {
  const label = noiseLabel(noise.kinds);
  const kind = label === 'Comments only' ? 'comments' : label.startsWith('Formatting') ? 'formatting' : 'whitespace';
  if (noise.all)
    return {
      text: noise.reformatted ? 'Reformatted' : label,
      kind,
      title: noise.reformatted
        ? 'Every change keeps the code’s tokens and syntax tree, across the file: it reads as a formatter run.'
        : `Every change in this file is ${label.replace(/ only$/, '').toLowerCase()}: the code’s syntax is the same on both sides.`,
    };
  const added = Math.max(0, additions - noise.added),
    deleted = Math.max(0, deletions - noise.deleted);
  const words = noiseStat(noise) ?? '';
  return {
    text: words,
    kind,
    code: { added, deleted },
    title: `${(noise.added + noise.deleted).toLocaleString()} changed lines are quiet (${words}); the code changes are +${added} −${deleted}.`,
  };
}
