import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { SelectionOption } from '../components/SearchableSelect';

export interface ReviewCrumb {
  id: string;
  label: string;
  title?: string;
  navigate?: () => void;
  pickerLabel?: string;
  value?: string;
  options?: SelectionOption[];
  select?: (value: string) => void;
}
function createTrails() {
  const entries = new Map<string, { owner: object; crumbs: ReviewCrumb[] }>();
  const listeners = new Set<() => void>();
  const empty: ReviewCrumb[] = [];
  return {
    read: (scope: string) => entries.get(scope)?.crumbs ?? empty,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(scope: string, owner: object, crumbs: ReviewCrumb[]) {
      entries.set(scope, { owner, crumbs });
      listeners.forEach((listener) => listener());
    },
    remove(scope: string, owner: object) {
      if (entries.get(scope)?.owner !== owner) return;
      entries.delete(scope);
      listeners.forEach((listener) => listener());
    },
  };
}
const BreadcrumbContext = createContext<ReturnType<typeof createTrails> | null>(null);
export function ReviewBreadcrumbProvider({ children }: { children: ReactNode }) {
  const [trails] = useState(createTrails);
  return <BreadcrumbContext.Provider value={trails}>{children}</BreadcrumbContext.Provider>;
}
/** Each workspace owns its location. Hidden explanation tabs cannot overwrite another tab's trail. */
export function useReviewBreadcrumbs(scope: string, crumbs: ReviewCrumb[]) {
  const trails = useContext(BreadcrumbContext);
  const current = useRef(crumbs);
  current.current = crumbs;
  const signature = JSON.stringify(
    crumbs.map(({ navigate, select, ...crumb }) => ({ ...crumb, navigable: !!navigate, selectable: !!select }))
  );
  useLayoutEffect(() => {
    if (!trails) return;
    const owner = {};
    trails.set(
      scope,
      owner,
      current.current.map((crumb, index) => ({
        ...crumb,
        navigate: crumb.navigate ? () => current.current[index]?.navigate?.() : undefined,
        select: crumb.select ? (value) => current.current[index]?.select?.(value) : undefined,
      }))
    );
    return () => trails.remove(scope, owner);
  }, [trails, scope, signature]);
}
const empty: ReviewCrumb[] = [];
export function useReviewTrail(scope: string) {
  const trails = useContext(BreadcrumbContext);
  return useSyncExternalStore(trails?.subscribe ?? (() => () => {}), () => trails?.read(scope) ?? empty);
}
