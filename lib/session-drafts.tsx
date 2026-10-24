import { useCallback, createContext, useContext, useState, type Dispatch, type SetStateAction } from 'react';
// Session-only draft storage survives route changes without writing private text to disk.
const values = new Map<string, unknown>();
export const ReviewDraftScope = createContext('');
export function useSessionDraft<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const scope = useContext(ReviewDraftScope),
    id = `${scope}:${key}`;
  const read = () => {
    if (!values.has(id)) values.set(id, typeof initial === 'function' ? (initial as () => T)() : initial);
    return values.get(id) as T;
  };
  const [state, setState] = useState(() => ({ id, value: read() }));
  if (state.id !== id) setState({ id, value: read() });
  const set: Dispatch<SetStateAction<T>> = (next) =>
    setState((previous) => {
      const old = previous.id === id ? previous.value : read();
      const value = typeof next === 'function' ? (next as (old: T) => T)(old) : next;
      values.set(id, value);
      return { id, value };
    });
  return [state.id === id ? state.value : read(), set];
}

/** Persist scroll without rerendering a virtualized list on every wheel event. */
export function useSessionScroll(key: string) {
  const [position] = useSessionDraft(`scroll:${key}`, () => ({ top: 0, left: 0 }));
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) {
        node.scrollTop = position.top;
        node.scrollLeft = position.left;
      }
    },
    [position]
  );
  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      position.top = event.currentTarget.scrollTop;
      position.left = event.currentTarget.scrollLeft;
    },
    [position]
  );
  return { ref, onScroll };
}
