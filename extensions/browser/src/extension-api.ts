// The small part of the WebExtension API this extension uses. Typed here instead of through a global
// `chrome` declaration so that the app's type space is not changed. Firefox exposes the same API as
// `browser` (with promises); Chrome and Edge expose it as `chrome`.

export interface ExtensionTab {
  id?: number;
  url?: string;
}

export interface ExtensionMessage {
  type: 'gnosis-page' | 'gnosis-opened';
  supported?: boolean;
}

interface ExtensionEvent<Listener> {
  addListener(listener: Listener): void;
}

export interface ExtensionApi {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  runtime: {
    sendMessage(message: ExtensionMessage): Promise<unknown>;
    onMessage: ExtensionEvent<(message: unknown, sender: { tab?: ExtensionTab }) => void>;
  };
  action: {
    enable(tabId?: number): Promise<void>;
    disable(tabId?: number): Promise<void>;
    onClicked: ExtensionEvent<(tab: ExtensionTab) => void>;
  };
  tabs: {
    update(tabId: number, properties: { url: string }): Promise<unknown>;
    sendMessage(tabId: number, message: ExtensionMessage): Promise<unknown>;
  };
}

export function extensionApi(): ExtensionApi {
  const scope = globalThis as { browser?: ExtensionApi; chrome?: ExtensionApi };
  const api = scope.browser ?? scope.chrome;
  if (!api) throw new Error('Open in Gnosis: the WebExtension API is not available.');
  return api;
}

declare const __GNOSIS_SCHEME__: string | undefined;

/** `gnosis`, or `gnosis-dev` in a developer build (`GNOSIS_SCHEME=gnosis-dev npm run build:extension`). */
export const SCHEME: string = typeof __GNOSIS_SCHEME__ === 'string' ? __GNOSIS_SCHEME__ : 'gnosis';
