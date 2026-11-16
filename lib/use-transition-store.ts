import { startTransition, useLayoutEffect, useState } from 'react';

/**
 * An external store's value, with updates rendered as a transition (#345). `useSyncExternalStore` renders every
 * update at once, in the task that published it: a queue snapshot re-rendered hundreds of rows, and a status-clock tick
 * every open summary, before a waiting click or key press could run. As a transition React renders in short slices and
 * lets input go first. Subscribing, as a component shown again by `<Activity>` does, applies the current value before
 * paint, so nothing shows an older value than the store holds. Use it for stores whose updates may wait a frame.
 *
 * `urgent` is asked during each notification. A change the user made, such as a rename or the result of a write,
 * renders at once, together with the local state the same input changed, such as a form that closes.
 */
export function useTransitionStore<T>(
  subscribe: ((listener: () => void) => () => void) | null,
  read: () => T,
  urgent?: () => boolean
): T {
  const [value, setValue] = useState(read);
  useLayoutEffect(() => {
    if (!subscribe) return;
    setValue(() => read());
    return subscribe(() => {
      if (urgent?.()) setValue(() => read());
      else startTransition(() => setValue(() => read()));
    });
  }, [subscribe, read, urgent]);
  return value;
}
