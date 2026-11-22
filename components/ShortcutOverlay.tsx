import { QUIET_CHANGES_KEY } from '../lib/quiet-changes';
import { useRef } from 'react';
import { DIFF_LAYOUT_KEYS } from '../lib/diff-layout';
import { CONFLICT_SHORTCUTS, hasGlyph, spokenKeys } from '../lib/conflict-shortcuts';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string;
  label: string;
}

interface ShortcutGroup {
  heading: string;
  shortcuts: Shortcut[];
}

const groups: ShortcutGroup[] = [
  {
    heading: 'Reading',
    shortcuts: [
      { keys: '←  →', label: 'Previous / next section' },
      { keys: 'j  k', label: 'Next / previous section (vim)' },
      { keys: 'g g', label: 'Jump to change overview' },
      { keys: 'G', label: 'Jump to last section' },
      { keys: '1 – 9', label: 'Jump to section by number' },
    ],
  },
  {
    heading: 'Reviewing',
    shortcuts: [
      { keys: 'c', label: 'Open or focus chat for current section or file' },
      { keys: DIFF_LAYOUT_KEYS.toggle, label: 'Switch between split and unified diff' },
      { keys: DIFF_LAYOUT_KEYS.unified, label: 'Switch to unified diff' },
      { keys: DIFF_LAYOUT_KEYS.split, label: 'Switch to split diff' },
      { keys: QUIET_CHANGES_KEY, label: 'Show or hide quiet changes (whitespace, formatting, comments)' },
    ],
  },
  { heading: 'Resolving conflicts', shortcuts: CONFLICT_SHORTCUTS },
  {
    heading: 'Review controls',
    shortcuts: [
      { keys: window.electronAPI.platform === 'darwin' ? '⌘ K' : 'Ctrl K', label: 'Open command palette' },
      { keys: window.electronAPI.platform === 'darwin' ? '⌘ ,' : 'Ctrl ,', label: 'Open Settings' },
      { keys: '?', label: 'Show this cheatsheet' },
      { keys: 'Esc', label: 'Dismiss dialog or overlay' },
    ],
  },
];

export function ShortcutOverlay({ open, onClose }: Props) {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        className="shortcut-dialog sm:max-w-2xl"
        onOpenAutoFocus={() => {
          previouslyFocused.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          previouslyFocused.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Use these while reviewing. Reading and reviewing shortcuts pause when you type or open a dialog.
          </DialogDescription>
        </DialogHeader>
        <div className="shortcut-groups">
          {groups.map((group) => (
            <section key={group.heading}>
              <h3>{group.heading}</h3>
              <dl>
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.keys + shortcut.label}>
                    <dt>{shortcut.label}</dt>
                    <dd>
                      {!hasGlyph(shortcut.keys) ? (
                        <kbd className="kbd">{shortcut.keys}</kbd>
                      ) : (
                        <>
                          <kbd className="kbd" aria-hidden="true">
                            {shortcut.keys}
                          </kbd>
                          <span className="sr-only">{spokenKeys(shortcut.keys)}</span>
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
