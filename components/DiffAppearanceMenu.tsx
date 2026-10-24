import type { Preferences } from '../lib/types';
import { useId } from 'react';
import { Popover } from 'radix-ui';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { DEFAULT_DIFF_APPEARANCE, type DiffAppearance } from '@/lib/review-diff';

const inlineDescriptions: Record<DiffAppearance['inline'], string> = {
  'word-alt': 'Highlights whole words using enhanced matching.',
  word: 'Highlights changed words within each line.',
  'word-line': 'Highlights one region from the first change to the last on each line.',
  char: 'Highlights individual characters that changed.',
  none: 'Shows changed lines without highlights inside them.',
};

export function DiffAppearanceMenu({
  value,
  onChange,
  layout,
  onLayoutChange,
}: {
  layout: Preferences['diffLayout'];
  onLayoutChange: (layout: Preferences['diffLayout']) => void;
  value: DiffAppearance;
  onChange: (value: DiffAppearance) => void;
}) {
  const descriptionId = useId();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
        >
          <SlidersHorizontal className="size-3.5" />
          Diff appearance
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          aria-label="Diff appearance"
          className="z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-md"
        >
          <h3 className="font-semibold text-sm mb-1">Diff appearance</h3>
          <p className="text-xs text-muted-foreground mb-4">Applies to all diffs. Saved automatically.</p>
          <div className="space-y-3 text-sm">
            <label className="flex items-center justify-between gap-3">
              Layout
              <select
                aria-label="Diff layout"
                className="rounded border bg-background px-2 py-1"
                value={layout}
                onChange={(e) => onLayoutChange(e.target.value as Preferences['diffLayout'])}
              >
                <option value="unified">Unified</option>
                <option value="split">Split</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-3">
              Change indicators
              <select
                className="rounded border bg-background px-2 py-1"
                value={value.indicators}
                onChange={(e) => onChange({ ...value, indicators: e.target.value as DiffAppearance['indicators'] })}
              >
                <option value="classic">+ / − signs</option>
                <option value="bars">Bars</option>
                <option value="none">None</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-3">
              Inline changes
              <select
                className="rounded border bg-background px-2 py-1"
                value={value.inline}
                aria-describedby={descriptionId}
                onChange={(e) => onChange({ ...value, inline: e.target.value as DiffAppearance['inline'] })}
              >
                <option value="word-alt">Word-Alt</option>
                <option value="word">Word</option>
                <option value="word-line">Word-Line</option>
                <option value="char">Character</option>
                <option value="none">None</option>
              </select>
            </label>
            <p id={descriptionId} className="text-xs text-muted-foreground leading-relaxed">
              {inlineDescriptions[value.inline]}
            </p>
            {(
              [
                ['backgrounds', 'Line backgrounds'],
                ['wrap', 'Wrap long lines'],
                ['lineNumbers', 'Line numbers'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center justify-between gap-3 cursor-pointer">
                {label}
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--ring)]"
                  checked={value[key]}
                  onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
                />
              </label>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="mt-4" onClick={() => onChange({ ...DEFAULT_DIFF_APPEARANCE })}>
            Reset appearance
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
