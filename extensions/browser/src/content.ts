// Content script: runs on github.com pages and shows the button only on supported pages. It matches all of
// github.com because GitHub navigates between pages without a page load (for example from the pull request
// list into a pull request), and a script that only matched `/pull/*` would not be there.
import { extensionApi, SCHEME } from './extension-api.ts';
import { HINT_DISMISSED_KEY, startOpenInGnosis, type HintStore } from './inject.ts';

const api = extensionApi();

const store: HintStore = {
  async isDismissed() {
    const items = await api.storage.local.get(HINT_DISMISSED_KEY);
    return items[HINT_DISMISSED_KEY] === true;
  },
  async dismiss() {
    await api.storage.local.set({ [HINT_DISMISSED_KEY]: true });
  },
};

const controller = startOpenInGnosis({
  win: window,
  scheme: SCHEME,
  store,
  onSupportChange(supported) {
    // Lets the toolbar action enable itself on this tab. Fails quietly if the background is unavailable.
    void api.runtime.sendMessage({ type: 'gnosis-page', supported }).catch(() => undefined);
  },
});

api.runtime.onMessage.addListener((message) => {
  // The toolbar action opened the link; watch for the "not installed" case as after a button click.
  if ((message as { type?: unknown } | null)?.type === 'gnosis-opened') controller.watchForMissingApp();
});
