import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';

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

  const listId = useId();
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
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
    if (e.nativeEvent.isComposing) return;
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

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        className="command-palette sm:max-w-xl gap-0 p-0 overflow-hidden flex flex-col"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          previouslyFocused.current = document.activeElement as HTMLElement | null;
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!document.querySelector('[role="dialog"][data-state="open"]')) previouslyFocused.current?.focus();
        }}
      >
        <DialogHeader className="px-5 pt-5 pb-3 text-left">
          <DialogTitle>Commands</DialogTitle>
          <DialogDescription>Find a topic or an action for this review.</DialogDescription>
        </DialogHeader>
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search commands"
          aria-expanded={true}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={flatOrder[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="command-search"
        />
        <ul id={listId} role="listbox" aria-label="Commands" ref={listRef} className="command-results">
          {grouped.map(([group, list], groupIndex) => (
            <li key={group || 'ungrouped'} role="presentation">
              {group && (
                <p id={`${listId}-group-${groupIndex}`} className="command-group">
                  {group}
                </p>
              )}
              <ul
                role="group"
                aria-labelledby={group ? `${listId}-group-${groupIndex}` : undefined}
                aria-label={group ? undefined : 'Actions'}
              >
                {list.map((cmd) => {
                  const flatIdx = flatOrder.indexOf(cmd);
                  const isActive = flatIdx === activeIndex;
                  return (
                    <li
                      key={cmd.id}
                      id={`${listId}-${flatIdx}`}
                      role="option"
                      aria-selected={isActive}
                      data-active={isActive}
                      className="command-option"
                      onMouseEnter={() => setActiveIndex(flatIdx)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        onClose();
                        cmd.perform();
                      }}
                    >
                      <span>{cmd.label}</span>
                      {cmd.hint && <kbd className="kbd">{cmd.hint}</kbd>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        {grouped.length === 0 && (
          <p role="status" className="px-5 py-6 text-sm text-muted-foreground">
            No matching commands. Try a topic name or action.
          </p>
        )}
        <p className="command-guidance">
          <span>↑ ↓ to choose</span>
          <span>Enter to run</span>
          <span>Esc to close</span>
        </p>
      </DialogContent>
    </Dialog>
  );
}
