import { useEffect, useRef } from 'react';

// Generic keyboard-shortcut hook used by HomePage and ReviewPage to
// register a global keydown listener. Supports:
//
//   - Single keys with optional modifiers ("k", "cmd+k", "ctrl+k", "G")
//   - Two-key sequences ("g g") with a 700ms window
//   - Modifier convention: meta → "cmd", ctrl → "ctrl", alt → "alt".
//     Shift is encoded by the key case ("G" not "shift+g") so the
//     map stays readable.
//   - Automatic suppression when the user is typing in an input,
//     textarea, select, or contenteditable element.
//
// The map is stored in a ref so the hook stays stable across renders
// — callers can pass a fresh object every render without churning
// the listener.

export type ShortcutHandler = (e: KeyboardEvent) => void;

export interface ShortcutMap {
  [key: string]: ShortcutHandler;
}

interface Options {
  enabled?: boolean;
}

const SEQUENCE_TIMEOUT_MS = 700;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function buildSignature(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push('cmd');
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  parts.push(e.key);
  return parts.join('+');
}

export function useKeyboardShortcuts(map: ShortcutMap, options: Options = {}) {
  const { enabled = true } = options;
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;

    let lastKey: string | null = null;
    let lastKeyTime = 0;

    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;

      const signature = buildSignature(e);
      const now = Date.now();

      // Try sequence first ("g g") so two-key combinations beat single-key ones
      if (lastKey && now - lastKeyTime < SEQUENCE_TIMEOUT_MS) {
        const sequence = `${lastKey} ${e.key}`;
        if (sequence in mapRef.current) {
          e.preventDefault();
          mapRef.current[sequence](e);
          lastKey = null;
          return;
        }
      }

      // Direct shortcut
      if (signature in mapRef.current) {
        e.preventDefault();
        mapRef.current[signature](e);
        lastKey = null;
        return;
      }

      // Treat this key as a sequence prefix only if some entry in the
      // map starts with "<this key> " — otherwise discard so a stray
      // letter doesn't poison the next keystroke.
      const isPrefix =
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        Object.keys(mapRef.current).some((k) => k.startsWith(`${e.key} `));

      if (isPrefix) {
        lastKey = e.key;
        lastKeyTime = now;
      } else {
        lastKey = null;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}
