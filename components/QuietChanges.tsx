import { useId } from 'react';
import { Popover } from 'radix-ui';
import { Brush, Import, Pilcrow, SquareSlash, type LucideIcon } from 'lucide-react';
import { Button } from './ui/button';
import type { QuietToggles } from '../lib/review-diff';
import { noiseFilterOn, type NoiseFilter } from '../lib/semantic-noise';
import type { QuietSummary } from '../lib/use-semantic-noise';
import { QUIET_CHANGES_KEY } from '../lib/quiet-changes';

/** Each kind of quiet change: its icon and words, the same in bars, labels, the tree and this summary. */
export const QUIET_KINDS: { key: 'whitespace' | 'formatting' | 'comments' | 'imports'; Icon: LucideIcon; label: string; detail: string }[] = [
  { key: 'whitespace', Icon: Pilcrow, label: 'Whitespace', detail: 'Indentation, line breaks, spaces and blank lines.' },
  {
    key: 'formatting',
    Icon: Brush,
    label: 'Formatting',
    detail: 'What a formatter writes: quote style, trailing commas, optional semicolons, parentheses and braces, number spelling.',
  },
  { key: 'comments', Icon: SquareSlash, label: 'Comments', detail: 'Comments and doc comments added, removed or edited.' },
  {
    key: 'imports',
    Icon: Import,
    label: 'Imports',
    detail: 'Imports that only add names from modules the file already imports. A new module or package always shows.',
  },
];
const lines = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'line' : 'lines'}`;

/**
 * The toggles, in Diff appearance and in the quiet changes summary. Hiding formatting hides whitespace too, so
 * while it is on, the whitespace toggle shows checked and says so.
 */
export function QuietChangesOptions({ filter, onChange }: { filter: NoiseFilter; onChange: (next: QuietToggles) => void }) {
  const headingId = useId();
  const descriptionId = useId();
  const current: QuietToggles = { hideWhitespace: filter.whitespace, hideFormatting: filter.formatting, hideComments: filter.comments, hideImports: filter.imports };
  const rows = [
    { key: 'hideWhitespace' as const, label: 'Hide whitespace-only changes', checked: filter.whitespace || filter.formatting, disabled: filter.formatting, hint: filter.formatting ? 'Included in formatting' : undefined },
    { key: 'hideFormatting' as const, label: 'Hide formatting-only changes', checked: filter.formatting, disabled: false, hint: undefined },
    { key: 'hideComments' as const, label: 'Hide comment-only changes', checked: filter.comments, disabled: false, hint: undefined },
    { key: 'hideImports' as const, label: 'Hide import-only changes', checked: filter.imports, disabled: false, hint: 'Names from modules already imported' },
  ];
  return (
    <div className="diff-noise-options" role="group" aria-labelledby={headingId} aria-describedby={descriptionId}>
      <h4 id={headingId} className="text-xs font-semibold text-muted-foreground mb-2">
        Quiet changes
      </h4>
      {rows.map(({ key, label, checked, disabled, hint }) => (
        <label key={key} className="flex items-center justify-between gap-3 cursor-pointer mb-2 data-[disabled]:cursor-default" data-disabled={disabled || undefined}>
          <span className="flex flex-col">
            {label}
            {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
          </span>
          <input
            type="checkbox"
            data-noise-toggle={key}
            className="size-4 accent-[var(--ring)]"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange({ ...current, [key]: e.target.checked })}
          />
        </label>
      ))}
      <p id={descriptionId} className="text-xs text-muted-foreground leading-relaxed">
        Compares the code’s syntax on both sides. Quiet changes collapse to a bar you can open; anything in doubt stays
        shown. Press <kbd className="kbd">{QUIET_CHANGES_KEY}</kbd> to show or hide them all.
      </p>
    </div>
  );
}

/**
 * How much the filter quiets in this view, beside the toolbar's other controls: "Quiet · 312 lines". It opens the
 * breakdown by kind, how many files are only quiet changes, how far the comparison has got, and the toggles. Off, it
 * says so, and opens the same toggles.
 */
export function QuietChangesChip({
  summary,
  files,
  filter,
  onChange,
}: {
  summary: QuietSummary;
  /** Files in the view, so the summary can say how many are compared yet. */
  files: number;
  filter: NoiseFilter;
  onChange: (next: QuietToggles) => void;
}) {
  const on = noiseFilterOn(filter);
  const hidden = summary.lines.whitespace + summary.lines.formatting + summary.lines.comments + summary.lines.imports;
  const title = on
    ? hidden
      ? `${lines(hidden)} of quiet changes hidden, in ${summary.touched.toLocaleString()} ${summary.touched === 1 ? 'file' : 'files'}`
      : 'No quiet changes hidden so far'
    : 'Quiet changes are shown';
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="quiet-chip data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
          data-quiet-chip={on ? 'on' : 'off'}
          title={title}
          aria-label={`Quiet changes: ${title}`}
        >
          <Pilcrow className="size-3.5" aria-hidden="true" />
          <span className="toolbar-label">Quiet</span>
          <span className="quiet-chip-count toolbar-label is-secondary">{on ? (hidden ? lines(hidden) : '0') : 'off'}</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          aria-label="Quiet changes"
          className="quiet-popover z-50 w-80 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-md"
        >
          <h3 className="font-semibold text-sm mb-1">Quiet changes</h3>
          <p className="text-xs text-muted-foreground mb-3" data-quiet-summary="">
            {on
              ? hidden
                ? `${lines(hidden)} hidden in ${summary.touched.toLocaleString()} of ${files.toLocaleString()} files; ${lines(summary.shown)} of changes show.`
                : 'Nothing hidden so far.'
              : 'Every change shows. Turn on a toggle to collapse changes that keep the code’s meaning.'}
            {summary.compared < files && ` Compared ${summary.compared.toLocaleString()} of ${files.toLocaleString()} files so far.`}
          </p>
          {on && hidden > 0 && (
            <ul className="quiet-breakdown mb-3" aria-label="Hidden, by kind">
              {QUIET_KINDS.filter(({ key }) => summary.lines[key] > 0).map(({ key, Icon, label, detail }) => (
                <li key={key} className="quiet-breakdown-row" data-quiet-kind={key} title={detail}>
                  <Icon size={13} aria-hidden="true" />
                  <span>{label}</span>
                  <span className="quiet-breakdown-count">{lines(summary.lines[key])}</span>
                </li>
              ))}
              {summary.quiet > 0 && (
                <li className="quiet-breakdown-row quiet-breakdown-files" data-quiet-files-only="">
                  <span>
                    {summary.quiet.toLocaleString()} {summary.quiet === 1 ? 'file is' : 'files are'} only quiet changes
                  </span>
                </li>
              )}
            </ul>
          )}
          <QuietChangesOptions filter={filter} onChange={onChange} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
