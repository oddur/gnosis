/**
 * Tracks the last tray menu that was built. A menu is identified by its template without functions,
 * plus the review and PR each entry opens, because click handlers are closures over them.
 */
export function createTrayMenuSignature() {
  let last: string | undefined;
  return {
    /** Whether this menu differs from the last one built. Records it when it does. */
    changed(template: unknown, targets: readonly (readonly [id: string, prUrl: string])[]) {
      const next = JSON.stringify([template, targets]);
      if (next === last) return false;
      last = next;
      return true;
    },
    /** A new tray has no menu yet. */
    reset() {
      last = undefined;
    },
  };
}

/** Skips pushing a value equal to the last one pushed, such as the menu bar panel's state. */
export function createStateSignature() {
  let last: string | undefined;
  return {
    changed(value: unknown) {
      const next = JSON.stringify(value);
      if (next === last) return false;
      last = next;
      return true;
    },
    reset() {
      last = undefined;
    },
  };
}
