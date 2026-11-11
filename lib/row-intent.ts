/**
 * Fires once the pointer or keyboard focus rests on a row. Moving on restarts the delay, so a quick
 * pass over the queue or a held arrow key sends nothing until the selection rests.
 */
export function createRowIntent({
  delayMs = 150,
  fire,
  clear,
}: {
  delayMs?: number;
  fire: (id: string) => void;
  clear: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired: string | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    enter(id: string) {
      cancel();
      if (id === fired) return;
      timer = setTimeout(() => {
        timer = undefined;
        fired = id;
        fire(id);
      }, delayMs);
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
