import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  createOpenInGnosis,
  HOST_ATTRIBUTE,
  RELEASES_URL,
  startOpenInGnosis,
  type HintStore,
  type OpenInGnosisOptions,
} from '../extensions/browser/src/inject';

const PR = 'https://github.com/oddur/gnosis/pull/160';

// Trimmed from GitHub's markup: the React page header (pull requests, commits) and the classic header.
const REACT_HEADER = `<div data-component="PageHeader"><h1>Title</h1><div data-component="PH_Actions"><button>Edit</button></div></div>`;
const CLASSIC_HEADER = `<div class="gh-header"><div class="gh-header-actions"><button>Edit</button></div></div>`;

type Win = OpenInGnosisOptions['win'];

function setup(url: string, body: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url, pretendToBeVisual: true });
  const win = dom.window as unknown as Win;
  const opened: string[] = [];
  let dismissed = false;
  const dismissals: boolean[] = [];
  const store: HintStore = {
    isDismissed: () => Promise.resolve(dismissed),
    dismiss: () => {
      dismissed = true;
      dismissals.push(true);
      return Promise.resolve();
    },
  };
  const support: boolean[] = [];
  const options: OpenInGnosisOptions = {
    win,
    scheme: 'gnosis',
    store,
    openLink: (link) => opened.push(link),
    hintDelayMs: 20,
    isVisible: (element) => !element.closest('[hidden]'),
    onSupportChange: (supported) => support.push(supported),
  };
  return { dom, win, opened, options, support, dismissals, setDismissed: (value: boolean) => (dismissed = value) };
}

function hosts(win: Win): HTMLElement[] {
  return Array.from(win.document.querySelectorAll<HTMLElement>(`[${HOST_ATTRIBUTE}]`));
}

function button(win: Win): HTMLButtonElement {
  const found = hosts(win)[0]?.shadowRoot?.querySelector<HTMLButtonElement>('button.open');
  assert.ok(found, 'button is present');
  return found;
}

function hint(win: Win): HTMLElement {
  const found = hosts(win)[0]?.shadowRoot?.querySelector<HTMLElement>('.hint');
  assert.ok(found, 'hint element is present');
  return found;
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

void test('injects one accessible button into the React page header actions', () => {
  const { win, options, support } = setup(PR, REACT_HEADER);
  const controller = createOpenInGnosis(options);
  controller.sync();
  const [host] = hosts(win);
  assert.equal(hosts(win).length, 1);
  assert.equal(host.parentElement?.getAttribute('data-component'), 'PH_Actions');
  assert.equal(host.parentElement.firstElementChild, host);
  assert.equal(host.getAttribute('data-placement'), 'inline');
  const open = button(win);
  assert.equal(open.type, 'button');
  assert.equal(open.textContent.trim(), 'Open in Gnosis');
  assert.equal(open.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(support, [true]);
});

void test('uses the classic header, and floats on pages without a header (compare)', () => {
  const classic = setup(`${PR}/files`, CLASSIC_HEADER);
  createOpenInGnosis(classic.options).sync();
  assert.ok(hosts(classic.win)[0].parentElement?.classList.contains('gh-header-actions'));

  const compare = setup('https://github.com/oddur/gnosis/compare/main...feat/x', '<main>diff</main>');
  createOpenInGnosis(compare.options).sync();
  const [host] = hosts(compare.win);
  assert.equal(host.parentElement, compare.win.document.body);
  assert.equal(host.getAttribute('data-placement'), 'floating');
});

void test('skips a hidden header container', () => {
  const { win, options } = setup(PR, `<div hidden>${REACT_HEADER}</div>${CLASSIC_HEADER}`);
  createOpenInGnosis(options).sync();
  assert.ok(hosts(win)[0].parentElement?.classList.contains('gh-header-actions'));
});

void test('sync is idempotent and removes duplicates', () => {
  const { win, options } = setup(PR, REACT_HEADER);
  const controller = createOpenInGnosis(options);
  for (let i = 0; i < 5; i++) controller.sync();
  assert.equal(hosts(win).length, 1);
  const first = hosts(win)[0];

  const stray = win.document.createElement('span');
  stray.setAttribute(HOST_ATTRIBUTE, '');
  win.document.body.append(stray);
  controller.sync();
  assert.deepEqual(hosts(win), [first]);
});

void test('does nothing on unsupported pages', () => {
  const { win, options, support } = setup('https://github.com/oddur/gnosis/issues/310', REACT_HEADER);
  createOpenInGnosis(options).sync();
  assert.equal(hosts(win).length, 0);
  assert.deepEqual(support, [false]);
});

void test('a click opens gnosis://open with the URL as it is at click time', () => {
  const { win, options, opened } = setup(PR, REACT_HEADER);
  const controller = createOpenInGnosis(options);
  controller.sync();
  // GitHub changes the path and hash without a page load.
  win.history.pushState({}, '', '/oddur/gnosis/pull/160/files#diff-abcR42');
  button(win).click();
  assert.deepEqual(opened, [
    `gnosis://open?url=${encodeURIComponent('https://github.com/oddur/gnosis/pull/160/files#diff-abcR42')}`,
  ]);
  // Nothing opens without a click.
  controller.sync();
  assert.equal(opened.length, 1);
});

void test('follows client-side navigation: Turbo, history and DOM replacement', async () => {
  const { win, options, opened, support } = setup('https://github.com/oddur/gnosis/pulls', '<main>list</main>');
  const running = startOpenInGnosis(options);
  assert.equal(hosts(win).length, 0);

  // Turbo navigation into a pull request: new body, new URL, turbo:load.
  win.history.pushState({}, '', '/oddur/gnosis/pull/160');
  win.document.body.innerHTML = REACT_HEADER;
  win.document.dispatchEvent(new win.Event('turbo:load'));
  await tick();
  assert.equal(hosts(win).length, 1);
  assert.equal(hosts(win)[0].parentElement?.getAttribute('data-component'), 'PH_Actions');

  // React re-renders the header and drops the button: the observer puts it back, once.
  win.document.body.innerHTML = `<section>${REACT_HEADER}</section>`;
  await tick();
  await tick();
  assert.equal(hosts(win).length, 1);
  assert.ok(hosts(win)[0].isConnected);

  // The header renders late: the floating button moves into it.
  win.history.pushState({}, '', '/oddur/gnosis/commit/e49f59e');
  win.document.body.innerHTML = '<main>loading</main>';
  win.dispatchEvent(new win.PopStateEvent('popstate'));
  await tick();
  assert.equal(hosts(win)[0].getAttribute('data-placement'), 'floating');
  win.document.querySelector('main')?.insertAdjacentHTML('beforeend', REACT_HEADER);
  await tick();
  await tick();
  assert.equal(hosts(win).length, 1);
  assert.equal(hosts(win)[0].getAttribute('data-placement'), 'inline');

  // Leaving for an unsupported page removes it.
  win.history.pushState({}, '', '/oddur/gnosis/issues/310');
  win.document.dispatchEvent(new win.Event('turbo:load'));
  await tick();
  assert.equal(hosts(win).length, 0);
  assert.deepEqual(support, [false, true, false]);

  running.disconnect();
  win.history.pushState({}, '', '/oddur/gnosis/pull/161');
  win.document.dispatchEvent(new win.Event('turbo:load'));
  await tick();
  assert.equal(hosts(win).length, 0);
  assert.deepEqual(opened, []);
});

void test('shows a dismissible hint when the page keeps focus after a click', async () => {
  const { win, options, dismissals } = setup(PR, REACT_HEADER);
  const controller = createOpenInGnosis(options);
  controller.sync();
  const open = button(win);
  open.focus();
  open.click();
  assert.ok(hint(win).hasAttribute('hidden'));
  await tick(40);
  const shown = hint(win);
  assert.ok(!shown.hasAttribute('hidden'));
  assert.equal(shown.getAttribute('role'), 'status');
  assert.match(shown.textContent, /Gnosis didn't open\./);
  const link = shown.querySelector('a');
  assert.equal(link?.getAttribute('href'), RELEASES_URL);
  assert.equal(link.textContent, 'Get Gnosis →');

  const dismiss = shown.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
  assert.ok(dismiss);
  dismiss.click();
  assert.ok(hint(win).hasAttribute('hidden'));
  assert.deepEqual(dismissals, [true]);

  // Remembered: the next failed click shows nothing.
  open.focus();
  open.click();
  await tick(40);
  assert.ok(hint(win).hasAttribute('hidden'));
});

void test('no hint when the app takes focus or the user navigates away', async () => {
  const blurred = setup(PR, REACT_HEADER);
  const controller = createOpenInGnosis(blurred.options);
  controller.sync();
  button(blurred.win).focus();
  button(blurred.win).click();
  blurred.win.dispatchEvent(new blurred.win.Event('blur'));
  await tick(40);
  assert.ok(hint(blurred.win).hasAttribute('hidden'));

  const moved = setup(PR, REACT_HEADER);
  const other = createOpenInGnosis(moved.options);
  other.sync();
  button(moved.win).focus();
  button(moved.win).click();
  moved.win.history.pushState({}, '', '/oddur/gnosis/pull/160/files');
  other.sync();
  await tick(40);
  assert.ok(hint(moved.win).hasAttribute('hidden'));
});
