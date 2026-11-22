import { Brush, Import, Pilcrow, SquareSlash, type LucideIcon } from 'lucide-react';
import { noiseLabel, noiseStat, quietKind, quietParts, type FileNoise, type QuietPart } from './semantic-noise';

/**
 * Each kind of quiet change: its icon and words, the same in bars, labels, headers, the tree and the summary. `detail`
 * says why it is quiet; it is the one place that does.
 */
export const QUIET_KINDS: { key: QuietPart; Icon: LucideIcon; label: string; detail: string }[] = [
  { key: 'whitespace', Icon: Pilcrow, label: 'Whitespace', detail: 'Indentation, line breaks, spaces and blank lines: the code’s syntax is the same.' },
  {
    key: 'formatting',
    Icon: Brush,
    label: 'Formatting',
    detail: 'What a formatter writes (quote style, trailing commas, optional semicolons, parentheses and braces, number spelling): the code’s syntax is the same.',
  },
  { key: 'comments', Icon: SquareSlash, label: 'Comments', detail: 'Comments and doc comments added, removed or edited: the code is the same.' },
  {
    key: 'imports',
    Icon: Import,
    label: 'Imports',
    detail: 'Names added from modules the file already imports. A new module or package always shows.',
  },
];
export const quietKindInfo = (key: QuietPart) => QUIET_KINDS.find((kind) => kind.key === key) ?? QUIET_KINDS[0];

/** What a file header says about its quiet changes (#396), after its `+N −M`. */
export interface QuietHeader {
  /** "Reformatted", "Formatting only", or the hidden lines: "90 formatting · 12 comments". */
  text: string;
  title: string;
  /** The kind that leads, for the icon. */
  kind: QuietPart;
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
  const kind = quietKind(noise.kinds);
  if (noise.all)
    return {
      text: noise.reformatted ? 'Reformatted' : label,
      kind,
      title: noise.reformatted
        ? 'Every change keeps the code’s tokens and syntax tree, across the file: it reads as a formatter run.'
        : `Every change in this file is quiet. ${quietParts(noise.kinds)
            .map((part) => `${quietKindInfo(part).label}: ${quietKindInfo(part).detail}`)
            .join(' ')}`,
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
