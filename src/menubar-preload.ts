/**
 * The menu bar panel's preload (#308): `window.menubar` and nothing else. None of the main window's API.
 * The panel sends row ids, never URLs or targets; main resolves them against the state it last pushed.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { MenubarApi, MenubarState } from '../lib/menubar-state';

const api: MenubarApi = {
  get: (): Promise<MenubarState | null> => ipcRenderer.invoke('menubar:get') as Promise<MenubarState | null>,
  onState: (callback: (state: MenubarState) => void) => {
    const listener = (_event: IpcRendererEvent, state: MenubarState) => callback(state);
    ipcRenderer.on('menubar:state', listener);
    return () => {
      ipcRenderer.removeListener('menubar:state', listener);
    };
  },
  /** Called when the panel is shown, so the list can take focus with the first row current. */
  onShown: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menubar:shown', listener);
    return () => {
      ipcRenderer.removeListener('menubar:shown', listener);
    };
  },
  open: (id: string) => ipcRenderer.send('menubar:open', id),
  openApp: () => ipcRenderer.send('menubar:open-app'),
  openSettings: () => ipcRenderer.send('menubar:open-settings'),
  close: () => ipcRenderer.send('menubar:close'),
  refresh: (): Promise<void> => ipcRenderer.invoke('menubar:refresh') as Promise<void>,
  resize: (height: number) => ipcRenderer.send('menubar:resize', height),
};
contextBridge.exposeInMainWorld('menubar', api);
