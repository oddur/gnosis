import { useSyncExternalStore } from 'react';
const openMenus = new Set<symbol>();
const listeners = new Set<() => void>();
export function setEntryMenuOpen(id: symbol, open: boolean) {
  const wasOpen = openMenus.size > 0;
  if (open) openMenus.add(id); else openMenus.delete(id);
  if (wasOpen !== (openMenus.size > 0)) listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => openMenus.size > 0;
export const useEntryMenusOpen = () => useSyncExternalStore(subscribe, snapshot, () => false);
