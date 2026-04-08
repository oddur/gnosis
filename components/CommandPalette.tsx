import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  keywords?: string;
  perform: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  placeholder?: string;
}

// Quiet editorial command palette. No fills, no fancy chrome — just
// a centered card with a bottom-bordered input and a list of options.
// Each command can declare a `group` so the list reads like a table
// of contents (Reading / Reviewing / Anywhere). Up/Down navigate,
// Enter executes, Esc dismisses, click-outside dismisses.

function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function CommandPalette({ open, onClose, commands, placeholder = 'Run a command…' }: Props) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Reset state every time the palette opens, and remember/restore
  // focus on the element that opened it.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      // Focus the input after the next paint so the keystroke that
      // opened the palette doesn't bleed into the input.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => {
        cancelAnimationFrame(id);
        previouslyFocused.current?.focus();
      };
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!query) return commands;
    return commands.filter((c) => fuzzyMatch(query, `${c.label} ${c.keywords ?? ''}`));
  }, [commands, query]);

  // Group filtered commands by their group label, preserving original order.
  const grouped = useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const cmd of filtered) {
      const key = cmd.group ?? '';
      const list = map.get(key) ?? [];
      list.push(cmd);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [filtered]);

  // Build a flat ordered list matching the visual order so up/down
  // navigation works across groups.
  const flatOrder = useMemo(() => grouped.flatMap(([, list]) => list), [grouped]);

  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(0, i), Math.max(0, flatOrder.length - 1)));
  }, [flatOrder.length]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(flatOrder.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = flatOrder[activeIndex] as Command | undefined;
      if (cmd) {
        onClose();
        cmd.perform();
      }
      return;
    }
  }

  // Scroll the active item into view when navigating with arrow keys.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const active = listRef.current.querySelector('[data-active="true"]');
    if (active && 'scrollIntoView' in active) {
      (active as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Command palette"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center px-8 pt-[18vh] pb-12 bg-background/85 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-background border border-border flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="bg-transparent border-0 border-b border-border px-5 py-4 text-base placeholder:text-muted-foreground/60 focus:outline-none focus:border-[var(--ring)] transition-colors"
        />

        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto py-2">
          {grouped.length === 0 && (
            <li className="px-5 py-4 slide-meta">No matching commands.</li>
          )}
          {grouped.map(([group, list]) => (
            <li key={group || 'ungrouped'}>
              {group && (
                <p className="slide-meta px-5 pt-3 pb-1 uppercase tracking-wide opacity-60">{group}</p>
              )}
              <ul>
                {list.map((cmd) => {
                  const flatIdx = flatOrder.indexOf(cmd);
                  const isActive = flatIdx === activeIndex;
                  return (
                    <li key={cmd.id}>
                      <button
                        type="button"
                        data-active={isActive}
                        onMouseEnter={() => setActiveIndex(flatIdx)}
                        onClick={() => {
                          onClose();
                          cmd.perform();
                        }}
                        className={`w-full flex items-center justify-between gap-4 px-5 py-2 text-left text-sm transition-colors ${
                          isActive
                            ? 'bg-muted/50 text-foreground'
                            : 'text-foreground/85 hover:bg-muted/30'
                        }`}
                      >
                        <span>{cmd.label}</span>
                        {cmd.hint && <span className="slide-meta">{cmd.hint}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
