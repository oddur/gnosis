/**
 * The menu bar panel (#308) with a fake `window.gnosisMenubar` and named states. `window.showMenubarState(name)`
 * switches state; `window.menubarCalls` records every API call; `window.fireMenubarShown()` acts like main
 * showing the panel. Like main, a dismissal or an opened row ends the tip; `window.resetMenubarHint()` brings it
 * back. The time is fixed so screenshots are stable.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MenubarView } from '../../components/MenubarView';
import { ATTENTION_LABEL } from '../../lib/attention';
import type { MenubarApi, MenubarRow, MenubarState } from '../../lib/menubar-state';
import { followSystemAppearance } from '../../src/menubar/appearance';
import '../../src/menubar/menubar.css';

const NOW = Date.parse('2026-11-14T14:03:00Z');
const row = (id: string, extra: Partial<MenubarRow> & Pick<MenubarRow, 'title' | 'kinds'>): MenubarRow => ({
  id,
  repo: 'klanggames/seed',
  number: Number(id.replace(/\D/g, '')) || 1,
  author: 'maria',
  own: false,
  isNew: false,
  labels: extra.kinds.slice(0, 2).map((kind) => ATTENTION_LABEL[kind]),
  ...extra,
});
// Like the user's queue: one 9-PR stack with several rows under To review and To fix, long titles, many items.
const agents = { stackId: 'stack-agents', stackSize: 9, author: 'ivaremilsson' };
const economy = { stackId: 'stack-economy', stackSize: 4, own: true };
const groups: MenubarState['groups'] = [
  {
    group: 'review',
    label: 'To review',
    count: 6,
    rows: [
      row('pr377', { title: 'feat: block launches until the player has accepted the latest terms', kinds: ['review-requested'], repo: 'klanggames/seed-launcher', author: 'zsolt', isNew: true }),
      row('pr36170', { title: 'feat: add the building_contents mcp tool for room interiors', kinds: ['review-requested'], ...agents, isNew: true }),
      row('pr36171', { title: 'feat: add the find_places mcp tool for spatial lookups', kinds: ['updated-since-review'], ...agents, isNew: true }),
      row('pr36172', { title: 'feat: add the open tutorial quests tool to the agent toolbox', kinds: ['review-requested', 'explanation-ready'], ...agents }),
      row('pr36173', { title: 'feat: add the find_free_spots mcp tool with radius filters', kinds: ['review-requested'], ...agents }),
    ],
  },
  {
    group: 'fix',
    label: 'To fix',
    count: 9,
    rows: [
      row('pr36160', { title: 'fix: refuse a long-running command when the sandbox is already busy', kinds: ['changes-requested'], own: true, isNew: true }),
      row('pr36144', {
        title: 'fix: forward only a verified player on reconnect to the session host, never the cached one',
        kinds: ['changes-requested', 'checks-failed'],
        own: true,
        isNew: true,
      }),
      row('pr36175', { title: 'feat: add the market and create_settlement tools to the economy server', kinds: ['checks-failed'], ...economy }),
      row('pr36176', { title: 'feat: add the trade route planner', kinds: ['conflicts'], ...economy }),
      row('pr36120', { title: 'chore: bump the protocol buffers toolchain and regenerate the client bindings', kinds: ['replies'], own: true }),
    ],
  },
  {
    group: 'ready',
    label: 'Ready',
    count: 20,
    rows: [
      row('pr91', { title: 'Rename queue filters', kinds: ['ready-to-merge'], repo: 'klanggames/seed-web', own: true, checkedAt: NOW - 3 * 60_000 }),
      row('pr399', { title: 'Move auth to device flow', kinds: ['explanation-ready'], isNew: true }),
      row('pr390', { title: 'Batch webhook deliveries', kinds: ['ready-to-merge'], own: true }),
      row('pr391', { title: 'Drop the legacy importer', kinds: ['explanation-ready'] }),
      row('pr392', { title: 'Cache avatars on disk', kinds: ['ready-to-merge'], own: true }),
    ],
  },
];
const base: MenubarState = {
  account: 'oddur',
  connection: 'ok',
  loading: false,
  checkedAt: NOW - 60_000,
  groups,
  tasks: [{ id: 'review:415', title: 'Explaining #415', detail: 'Write topics, 4 of 6', status: 'running' }],
  // Nine new in all: six shown, three among the rows behind "N more". The icon shows 9.
  summary: { needYou: 15, ready: 20, fresh: 9, marked: 9, line: '15 need you · 9 new · 20 ready' },
  queueSize: 41,
  unchecked: 0,
  refreshing: false,
  hint: false,
};
const none = { needYou: 0, ready: 0, fresh: 0, marked: 0, line: 'Nothing needs you' };
const states: Record<string, MenubarState> = {
  default: base,
  clear: { ...base, groups: [], tasks: [], summary: none, checkedAt: NOW - 10_000 },
  loading: { ...base, loading: true, groups: [], tasks: [] },
  'signed-out': { ...base, account: undefined, connection: 'signed-out', groups: [], tasks: [], summary: none },
  offline: { ...base, connection: 'offline', checkedAt: Date.parse('2026-11-14T14:02:00Z'), tasks: [] },
  paused: { ...base, connection: 'paused', retryAt: Date.parse('2026-11-14T14:32:00Z') },
  error: { ...base, connection: 'error' },
  // The first time the panel opens: the footer tip shows until it is dismissed or a row opens.
  'first-open': { ...base, hint: true },
};

type Call = [keyof MenubarApi, ...unknown[]];
const calls: Call[] = [];
const shown = new Set<() => void>();
let hintDone = false;
let rerender: () => void = () => {};
const finishHint = () => {
  hintDone = true;
  rerender();
};
const api: MenubarApi = {
  get: () => Promise.resolve(states.default),
  onState: () => () => {},
  onShown: (callback) => {
    shown.add(callback);
    return () => shown.delete(callback);
  },
  open: (id) => {
    calls.push(['open', id]);
    finishHint();
  },
  openApp: () => calls.push(['openApp']),
  openSettings: () => calls.push(['openSettings']),
  close: () => calls.push(['close']),
  refresh: () => {
    calls.push(['refresh']);
    return Promise.resolve();
  },
  resize: (height) => calls.push(['resize', height]),
  dismissHint: () => {
    calls.push(['dismissHint']);
    finishHint();
  },
};

let show: (name: string) => void = () => {};
function Fixture() {
  const [name, setName] = useState(new URLSearchParams(location.search).get('state') ?? 'default');
  const [, setVersion] = useState(0);
  show = setName;
  rerender = () => setVersion((version) => version + 1);
  const state = states[name];
  return <MenubarView state={{ ...state, hint: state.hint && !hintDone }} api={api} now={NOW} />;
}
followSystemAppearance();
Object.assign(window, {
  menubarCalls: calls,
  menubarStates: Object.keys(states),
  showMenubarState: (name: string) => show(name),
  fireMenubarShown: () => shown.forEach((callback) => callback()),
  resetMenubarHint: () => {
    hintDone = false;
    rerender();
  },
});
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
