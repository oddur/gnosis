/**
 * A store subscription whose listener hears of changes once the view is still (`when`, lib/use-syntax-contents.ts
 * `whenSettled`): changes that land while the reader scrolls are told once, after the scroll. `when` may run its
 * callback at once (a hidden window has no scroll to wait out): the next change is then told too, never swallowed by a
 * cancel kept for a wait that is already over.
 */
export function settledSubscription(
  subscribe: (listener: () => void) => () => void,
  when: (run: () => void) => () => void
): (listener: () => void) => () => void {
  return (listener) => {
    /** The wait in flight, by number; 0 when none. */
    let pending = 0;
    let next = 0;
    let cancel: (() => void) | undefined;
    const stop = subscribe(() => {
      if (pending) return;
      const id = ++next;
      pending = id;
      const stopWait = when(() => {
        if (pending === id) {
          pending = 0;
          cancel = undefined;
        }
        listener();
      });
      // A wait that already ran keeps no cancel: the next change starts a new one.
      if (pending === id) cancel = stopWait;
    });
    return () => {
      stop();
      cancel?.();
      cancel = undefined;
      pending = 0;
    };
  };
}
