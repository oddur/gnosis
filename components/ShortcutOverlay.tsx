import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Keyboard shortcut cheatsheet — reachable from anywhere with `?`,
// dismissible with Esc. Built as an editorial reference card, not a
// modal: serif title, two-column type, no chrome. The actual key
// handlers live in App-level / hook code; this component just
// renders the documentation for them.
//
// Shortcuts marked "soon" are planned in the next task and listed
// here so the cheatsheet stays the single source of truth.

interface Shortcut {
  keys: string;
  label: string;
  soon?: boolean;
}

interface ShortcutGroup {
  heading: string;
  shortcuts: Shortcut[];
}

const groups: ShortcutGroup[] = [
  {
    heading: 'Reading',
    shortcuts: [
      { keys: '←  →', label: 'Previous / next slide' },
      { keys: 'j  k', label: 'Next / previous slide (vim)' },
      { keys: 'g g', label: 'Jump to overview' },
      { keys: 'G', label: 'Jump to last slide' },
      { keys: '1 – 9', label: 'Jump to slide by number' },
    ],
  },
  {
    heading: 'Reviewing',
    shortcuts: [
      { keys: 'r', label: 'Mark reviewed and advance' },
      { keys: 'n', label: 'Jump to next unreviewed' },
      { keys: 'c', label: 'Open chat for current slide' },
      { keys: 'f', label: 'Toggle focus / split view' },
      { keys: 'u', label: 'Switch to unified diff' },
      { keys: 's', label: 'Switch to split diff' },
      { keys: '[  ]', label: 'Resize narrative panel', soon: true },
    ],
  },
  {
    heading: 'Home',
    shortcuts: [
      { keys: 'n', label: 'Focus the new-review input' },
    ],
  },
  {
    heading: 'Anywhere',
    shortcuts: [
      { keys: '⌘ K', label: 'Open command palette' },
      { keys: '?', label: 'Show this cheatsheet' },
      { keys: 'Esc', label: 'Dismiss dialog or overlay' },
    ],
  },
];

export function ShortcutOverlay({ open, onClose }: Props) {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Remember whatever had focus before we opened, so we can
    // restore it on close (a11y requirement for any modal-ish UI).
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      // Restore focus to whatever element opened the overlay.
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center px-8 pt-[12vh] pb-12 bg-background/85 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl flex flex-col gap-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-3">
          <div className="slide-chapter">
            <span>Keyboard shortcuts</span>
          </div>
          <h2 className="slide-title">A reader's reference card.</h2>
          <p className="slide-prose">
            Every reading and reviewing action is reachable from the keyboard. Press <kbd className="kbd">Esc</kbd> to
            dismiss this card; press <kbd className="kbd">?</kbd> from anywhere to bring it back.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-8">
          {groups.map((group) => (
            <section key={group.heading} className="flex flex-col gap-3">
              <h3 className="slide-meta">{group.heading}</h3>
              <ul className="flex flex-col gap-2">
                {group.shortcuts.map((s) => (
                  <li key={s.keys + s.label} className="flex flex-col gap-0.5">
                    <kbd className="kbd self-start">{s.keys}</kbd>
                    <span className={`text-sm ${s.soon ? 'text-muted-foreground/60' : 'text-foreground/85'}`}>
                      {s.label}
                      {s.soon && <span className="slide-meta ml-1.5">soon</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
