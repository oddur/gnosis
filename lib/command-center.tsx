import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SearchDestination } from './command-search';
import { GlobalCommandPalette } from '../components/GlobalCommandPalette';

export interface AppCommand {
  id: string;
  label: string;
  keywords?: string;
  group?: string;
  hint?: string;
  perform: () => void | Promise<void>;
}
interface Center {
  open: () => void;
  register: (scope: string, read: () => AppCommand[]) => () => void;
}
const Context = createContext<Center | null>(null);
export function useCommandCenter() {
  return useContext(Context);
}
export function useCommandScope(scope: string, commands: AppCommand[]) {
  const center = useCommandCenter(),
    latest = useRef(commands);
  latest.current = commands;
  useEffect(() => center?.register(scope, () => latest.current), [center, scope]);
}
export function CommandCenter({
  children,
  navigate,
  commands,
}: {
  children: ReactNode;
  navigate: (destination: SearchDestination) => Promise<void>;
  commands: AppCommand[];
}) {
  const [open, setOpen] = useState(false),
    [available, setAvailable] = useState<AppCommand[]>([]);
  const scopes = useRef(new Map<string, () => AppCommand[]>()),
    defaults = useRef(commands);
  defaults.current = commands;
  const center = useMemo<Center>(
    () => ({
      open: () => {
        setAvailable([...[...scopes.current.values()].flatMap((read) => read()), ...defaults.current]);
        setOpen(true);
      },
      register: (scope, read) => {
        scopes.current.set(scope, read);
        return () => {
          if (scopes.current.get(scope) === read) scopes.current.delete(scope);
        };
      },
    }),
    []
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'k'
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      center.open();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [center]);
  return (
    <Context.Provider value={center}>
      {children}
      <GlobalCommandPalette open={open} onClose={() => setOpen(false)} commands={available} navigate={navigate} />
    </Context.Provider>
  );
}
