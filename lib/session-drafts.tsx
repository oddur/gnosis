import {
  useCallback,
  useEffect,
  createContext,
  useContext,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from 'react';
// Session-only draft storage survives route changes without writing private text to disk.
const values = new Map<string, unknown>();
/** Editors showing a draft, so a draft written by id after a remount reaches the one now on screen. */
const watchers = new Map<string, Set<(value: unknown) => void>>();
export const ReviewDraftScope = createContext('');
const WorkspaceDraftScope = createContext('');
/** Closed-tab recovery is bounded; release drafts once a destination leaves that history. */
export function retainWorkspaceDrafts(account: string, ids: readonly string[]) {
  const prefix = `workspace:${account}:`;
  const keep = ids.map((id) => `${prefix}${id}:`);
  for (const key of values.keys())
    if (key.startsWith(prefix) && !keep.some((scope) => key.startsWith(scope))) values.delete(key);
}
export function WorkspaceDraftBoundary({ value, children }: { value: string; children: ReactNode }) {
  return (
    <WorkspaceDraftScope.Provider value={value}>
      <ReviewDraftScope.Provider value={value}>{children}</ReviewDraftScope.Provider>
    </WorkspaceDraftScope.Provider>
  );
}
/** Keep subject scopes shared across review surfaces, but isolated across tabs. */
export function ReviewDraftBoundary({ value, children }: { value: string; children: ReactNode }) {
  const workspace = useContext(WorkspaceDraftScope);
  return <ReviewDraftScope.Provider value={`${workspace}:${value}`}>{children}</ReviewDraftScope.Provider>;
}
export function useSessionDraft<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const scope = useContext(ReviewDraftScope),
    id = `${scope}:${key}`;
  const read = () => {
    if (!values.has(id)) values.set(id, typeof initial === 'function' ? (initial as () => T)() : initial);
    return values.get(id) as T;
  };
  const [state, setState] = useState(() => ({ id, value: read() }));
  if (state.id !== id) setState({ id, value: read() });
  useEffect(() => {
    const watch = (value: unknown) => setState({ id, value: value as T });
    let set = watchers.get(id);
    if (!set) watchers.set(id, (set = new Set()));
    set.add(watch);
    return () => {
      set.delete(watch);
      if (!set.size) watchers.delete(id);
    };
  }, [id]);
  const set: Dispatch<SetStateAction<T>> = (next) =>
    setState((previous) => {
      const old = previous.id === id ? previous.value : read();
      const value = typeof next === 'function' ? (next as (old: T) => T)(old) : next;
      values.set(id, value);
      return { id, value };
    });
  return [state.id === id ? state.value : read(), set];
}

/** The stored id of a draft in this scope, so its text can be written back after its editor closed. */
export function useSessionDraftId(key: string): string {
  return `${useContext(ReviewDraftScope)}:${key}`;
}
/** Reads a draft by its stored id, without an editor. */
export const readSessionDraft = (id: string): unknown => values.get(id);
/** Writes a draft by its stored id. An editor that mounts later shows it. */
export function writeSessionDraft(id: string, value: unknown) {
  values.set(id, value);
  watchers.get(id)?.forEach((watch) => watch(value));
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
