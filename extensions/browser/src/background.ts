// Toolbar action: on a supported GitHub page, clicking the extension icon opens the same link as the
// button. `activeTab` gives the clicked tab's URL; no `tabs` permission is needed.
import { extensionApi, SCHEME, type ExtensionTab } from './extension-api.ts';
import { buildGnosisLink, isSupportedPage } from './link.ts';

const api = extensionApi();

// Off by default; the content script enables it on supported pages, per tab.
void api.action.disable().catch(() => undefined);

api.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  const page = message as { type?: unknown; supported?: unknown } | null;
  if (tabId === undefined || page?.type !== 'gnosis-page') return;
  const change = page.supported === true ? api.action.enable(tabId) : api.action.disable(tabId);
  void change.catch(() => undefined);
});

api.action.onClicked.addListener((tab: ExtensionTab) => {
  const { id, url } = tab;
  if (id === undefined || url === undefined || !isSupportedPage(url)) return;
  void api.tabs.update(id, { url: buildGnosisLink(url, SCHEME) }).catch(() => undefined);
  void api.tabs.sendMessage(id, { type: 'gnosis-opened' }).catch(() => undefined);
});
