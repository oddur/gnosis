/**
 * The menu bar panel (#308) with a fake `window.gnosisMenubar` and named states. `window.showMenubarState(name)`
 * switches state; `window.menubarCalls` records every API call; `window.fireMenubarShown()` acts like main
 * showing the panel. The time is fixed so screenshots are stable.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MenubarView } from '../../components/MenubarView';
import type { MenubarApi, MenubarRow, MenubarState } from '../../lib/menubar-state';
import { followSystemAppearance } from '../../src/menubar/appearance';
import '../../src/menubar/menubar.css';

const NOW = Date.parse('2026-11-14T14:03:00Z');
const row = (id: string, extra: Partial<MenubarRow> & Pick<MenubarRow, 'title' | 'kinds' | 'labels'>): MenubarRow => ({
  id,
  repo: 'acme/api',
  number: Number(id.replace(/\D/g, '')) || 1,
  author: 'maria',
  own: false,
  isNew: false,
  ...extra,
});
const groups: MenubarState['groups'] = [
  {
    group: 'review',
    label: 'To review',
    count: 2,
    rows: [
      row('pr412', { title: 'Add retry budget to sync scheduler', kinds: ['review-requested', 'explanation-ready'], labels: ['Review requested', 'Explanation ready'], isNew: true }),
      row('pr388', { title: 'Split billing module', kinds: ['updated-since-review'], labels: ['Updated since your review'], author: 'jon', stackSize: 3 }),
    ],
  },
  {
    group: 'fix',
    label: 'To fix',
    count: 1,
    rows: [
      row('pr407', {
        title: 'Fix flaky cache eviction when the eviction queue is drained concurrently by two workers on a cold start',
        kinds: ['changes-requested', 'checks-failed'],
        labels: ['Changes requested', 'Checks failed'],
        own: true,
        isNew: true,
      }),
    ],
  },
  {
    group: 'ready',
    label: 'Ready',
    count: 7,
    rows: [
      row('pr91', { title: 'Rename queue filters', kinds: ['ready-to-merge'], labels: ['Ready to merge'], repo: 'acme/web', own: true, checkedAt: NOW - 3 * 60_000 }),
      row('pr399', { title: 'Move auth to device flow', kinds: ['explanation-ready'], labels: ['Explanation ready'], isNew: true }),
      row('pr390', { title: 'Batch webhook deliveries', kinds: ['ready-to-merge'], labels: ['Ready to merge'], own: true }),
      row('pr391', { title: 'Drop the legacy importer', kinds: ['explanation-ready'], labels: ['Explanation ready'] }),
      row('pr392', { title: 'Cache avatars on disk', kinds: ['ready-to-merge'], labels: ['Ready to merge'], own: true }),
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
  summary: { needYou: 3, ready: 7, fresh: 3, line: '3 need you · 7 ready' },
  queueSize: 14,
  unchecked: 0,
  refreshing: false,
};
const states: Record<string, MenubarState> = {
  default: base,
  clear: { ...base, groups: [], tasks: [], summary: { needYou: 0, ready: 0, fresh: 0, line: 'Nothing needs you' }, checkedAt: NOW - 10_000 },
  loading: { ...base, loading: true, groups: [], tasks: [] },
  'signed-out': { ...base, account: undefined, connection: 'signed-out', groups: [], tasks: [], summary: { needYou: 0, ready: 0, fresh: 0, line: 'Nothing needs you' } },
  offline: { ...base, connection: 'offline', checkedAt: Date.parse('2026-11-14T14:02:00Z'), tasks: [] },
  paused: { ...base, connection: 'paused', retryAt: Date.parse('2026-11-14T14:32:00Z') },
  error: { ...base, connection: 'error' },
};

type Call = [keyof MenubarApi, ...unknown[]];
const calls: Call[] = [];
const shown = new Set<() => void>();
const api: MenubarApi = {
  get: () => Promise.resolve(states.default),
  onState: () => () => {},
  onShown: (callback) => {
    shown.add(callback);
    return () => shown.delete(callback);
  },
  open: (id) => calls.push(['open', id]),
  openApp: () => calls.push(['openApp']),
  openSettings: () => calls.push(['openSettings']),
  close: () => calls.push(['close']),
  refresh: () => {
    calls.push(['refresh']);
    return Promise.resolve();
  },
  resize: (height) => calls.push(['resize', height]),
};

let show: (name: string) => void = () => {};
function Fixture() {
  const [name, setName] = useState(new URLSearchParams(location.search).get('state') ?? 'default');
  show = setName;
  return <MenubarView state={states[name]} api={api} now={NOW} />;
}
followSystemAppearance();
Object.assign(window, {
  menubarCalls: calls,
  menubarStates: Object.keys(states),
  showMenubarState: (name: string) => show(name),
  fireMenubarShown: () => shown.forEach((callback) => callback()),
});
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
