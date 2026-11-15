/**
 * Fires once the pointer or keyboard focus rests on a row. Moving on restarts the delay, so a quick
 * pass over the queue or a held arrow key sends nothing until the selection rests. While the list scrolls, rows
 * pass under a still pointer: `scrolled` ignores them until the list has been still for `settleMs`.
 */
export function createRowIntent({
  delayMs = 150,
  settleMs = 250,
  now = () => performance.now(),
  fire,
  clear,
}: {
  delayMs?: number;
  settleMs?: number;
  now?: () => number;
  fire: (id: string) => void;
  clear: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired: string | null = null;
  let scrolledAt = -Infinity;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    enter(id: string) {
      cancel();
      if (id === fired || now() - scrolledAt < settleMs) return;
      timer = setTimeout(() => {
        timer = undefined;
        fired = id;
        fire(id);
      }, delayMs);
    },
    /** The list scrolled: a row waiting to fire is dropped, and rows entered while it settles are ignored. */
    scrolled() {
      scrolledAt = now();
      cancel();
    },
    leave() {
      cancel();
      if (fired === null) return;
      fired = null;
      clear();
    },
  };
}
export type RowIntent = ReturnType<typeof createRowIntent>;
