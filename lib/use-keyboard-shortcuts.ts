import { useEffect, useRef, type RefObject } from 'react';

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
//   - A handler that returns false leaves the key alone, for keys
//     that only apply when something is on screen.
//
// The map is stored in a ref so the hook stays stable across renders
// — callers can pass a fresh object every render without churning
// the listener.

/** Return `false` when the key does not apply here, so it keeps its default action. */
export type ShortcutHandler = (e: KeyboardEvent) => unknown;

export interface ShortcutMap {
  [key: string]: ShortcutHandler;
}

interface Options {
  enabled?: boolean;
  capture?: boolean;
  scope?: RefObject<HTMLElement | null>;
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

type ShortcutEvent = Pick<KeyboardEvent, 'defaultPrevented' | 'isComposing' | 'composedPath'>;

/** Typing, IME composition and keys handled elsewhere never trigger shortcuts. Neither do keys pressed inside a
 * dialog, menu or combobox, which own their keys. Events from diff editors are retargeted at their shadow host,
 * so the whole composed path is checked. */
export function isShortcutSuppressed(e: ShortcutEvent): boolean {
  return (
    e.defaultPrevented ||
    e.isComposing ||
    e
      .composedPath()
      .some(
        (target) =>
          isTypingTarget(target) ||
          (typeof (target as Element).closest === 'function' &&
            !!(target as Element).closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="combobox"]'))
      )
  );
}

function buildSignature(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push('cmd');
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  parts.push(e.key);
  return parts.join('+');
}

/** The keydown listener behind useKeyboardShortcuts. It reads the current map on every key and remembers the
 * first key of a two-key sequence. */
export function createShortcutListener(
  read: () => ShortcutMap,
  scope?: RefObject<HTMLElement | null>
): (e: KeyboardEvent) => void {
  let lastKey: string | null = null;
  let lastKeyTime = 0;

  return function handleKeyDown(e: KeyboardEvent) {
    // Dialogs and popovers own their keys. Review shortcuts must not move the
    // underlying topic while a user operates a modal, select, or resize handle.
    if (scope && !scope.current?.checkVisibility()) return;
    if (isShortcutSuppressed(e)) {
      lastKey = null;
      return;
    }

    const map = read();
    const signature = buildSignature(e);
    const now = Date.now();

    // Try sequence first ("g g") so two-key combinations beat single-key ones
    if (lastKey && now - lastKeyTime < SEQUENCE_TIMEOUT_MS) {
      const sequence = `${lastKey} ${e.key}`;
      if (sequence in map) {
        if (map[sequence](e) !== false) e.preventDefault();
        lastKey = null;
        return;
      }
    }

    // Direct shortcut
    if (signature in map) {
      if (map[signature](e) !== false) e.preventDefault();
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
      Object.keys(map).some((k) => k.startsWith(`${e.key} `));

    if (isPrefix) {
      lastKey = e.key;
      lastKeyTime = now;
    } else {
      lastKey = null;
    }
  };
}

export function useKeyboardShortcuts(map: ShortcutMap, options: Options = {}) {
  const { enabled = true, capture = false, scope } = options;
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = createShortcutListener(() => mapRef.current, scope);
    window.addEventListener('keydown', handleKeyDown, capture);
    return () => window.removeEventListener('keydown', handleKeyDown, capture);
  }, [enabled, capture, scope]);
}
