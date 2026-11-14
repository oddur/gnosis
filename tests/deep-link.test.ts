import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLinkTarget, prTarget, prUrl } from '../lib/deep-link';
import { createDeepLinks, DEEP_LINK_QUEUE_LIMIT } from '../src/deep-link-service';
import { routeDeepLink } from '../lib/deep-link-routing';
import { groupSubjects } from '../lib/workbench';
import type { WorkspaceTabEntry } from '../lib/workspace-tabs';
import { member } from './notification-fixtures';

const pr = { host: 'github.com', owner: 'o', repo: 'r', number: 1 };

test('targets crossing IPC are re-validated, and unknown fields are dropped', () => {
  assert.deepEqual(parseDeepLinkTarget({ kind: 'pr', pr, tab: 'checks', extra: 1 }), { kind: 'pr', pr, tab: 'checks' });
  assert.deepEqual(parseDeepLinkTarget({ kind: 'review', reviewId: '7d0f-uuid' }), { kind: 'review', reviewId: '7d0f-uuid' });
  assert.deepEqual(parseDeepLinkTarget({ kind: 'queue', filters: { read: 'unread' } }), { kind: 'queue', filters: { read: 'unread' } });
  for (const bad of [
    null,
    { kind: 'pr', pr: { ...pr, host: 'evil.example' } },
    { kind: 'pr', pr: { ...pr, owner: '../x' } },
    { kind: 'pr', pr: { ...pr, number: 0 } },
    { kind: 'pr', pr, tab: 'settings' },
    { kind: 'review', reviewId: '../../etc/passwd' },
    { kind: 'queue', section: 'everything' },
    { kind: 'queue', filters: { read: 'maybe' } },
    { kind: 'settings' },
  ])
    assert.equal(parseDeepLinkTarget(bad), undefined, JSON.stringify(bad));
  assert.equal(prUrl(pr), 'https://github.com/o/r/pull/1');
  assert.equal(prTarget('https://github.com/o/r/pull/1/files'), undefined);
});

test('targets wait until a renderer is ready, then arrive at once; a reload asks again', () => {
  const sent: [number, string][] = [];
  let shown = 0;
  const links = createDeepLinks({ show: () => shown++, send: (id, item) => (sent.push([id, item.target.kind]), true), log: () => {} });
  links.open({ kind: 'review', reviewId: 'a' }, 'tray');
  links.open({ kind: 'review', reviewId: 'a' }, 'tray');
  assert.equal(shown, 2);
  assert.deepEqual(sent, []);
  assert.deepEqual(links.take(7).map((item) => item.target), [{ kind: 'review', reviewId: 'a' }], 'A duplicate of the newest is dropped');
  links.open({ kind: 'queue' }, 'notification');
  assert.deepEqual(sent, [[7, 'queue']]);
  links.reset(7);
  for (let i = 0; i < 8; i++) links.open({ kind: 'review', reviewId: `r${i}` }, 'notification');
  assert.equal(links.pending(), DEEP_LINK_QUEUE_LIMIT);
  assert.deepEqual(links.take(8).map((item) => item.target.kind === 'review' && item.target.reviewId), ['r3', 'r4', 'r5', 'r6', 'r7']);
});

test('an invalid target is rejected; a renderer that is gone is skipped', () => {
  const lines: string[] = [];
  const alive = new Set([2]);
  const sent: number[] = [];
  const links = createDeepLinks({ show: () => {}, send: (id) => alive.has(id) && (sent.push(id), true), log: (line) => lines.push(line) });
  assert.equal(links.open({ kind: 'pr', pr: { ...pr, number: -1 } }, 'notification'), false);
  assert.match(lines[0], /result=rejected/);
  links.take(1);
  links.take(2);
  links.open(prTarget('https://github.com/o/r/pull/1')!, 'notification');
  assert.deepEqual(sent, [2]);
  assert.doesNotMatch(lines.join('\n'), /github\.com/, 'Log lines never contain the target');
});

const tab = (id: string, location?: WorkspaceTabEntry['location']): WorkspaceTabEntry => ({ id, title: id, label: id, detail: '', section: '', location });
test('a PR target reuses the tab showing it, else opens a new tab, with the tab to land on', () => {
  const a = member(1), b = member(2, { baseBranch: a.headBranch });
  const [stack] = groupSubjects([a, b]);
  const queue = { items: [{ subject: stack, attention: 'other' as const }] };
  const fresh = routeDeepLink(prTarget(b.url, 'checks')!, { tabs: [tab('t1')], active: 't1' }, queue, 5);
  assert.deepEqual(fresh.tab, { kind: 'new' });
  assert.equal(fresh.destination.kind === 'home' && fresh.destination.subject?.subject.members[0].url, b.url, 'A stack member is focused');
  assert.deepEqual(fresh.destination.kind === 'home' && fresh.destination.open, { tab: 'checks', nonce: 5 });
  const showing = tab('t2', { page: 'home', home: { item: { subject: stack, attention: 'other' } } as never });
  assert.deepEqual(routeDeepLink(prTarget(b.url)!, { tabs: [tab('t1'), showing], active: 't1' }, queue).tab, { kind: 'reuse', id: 't2' });
  const unknown = routeDeepLink(prTarget('https://github.com/o/r/pull/9', 'notes')!, { tabs: [tab('t1')], active: 't1' }, { items: [] }, 1);
  assert.deepEqual(unknown.destination, { kind: 'home', url: 'https://github.com/o/r/pull/9', open: { tab: 'brief', nonce: 1 } });
});

test('a review opens in the active tab; the Unread view reuses a plain queue tab', () => {
  assert.deepEqual(routeDeepLink({ kind: 'review', reviewId: 'r' }, { tabs: [tab('t1')], active: 't1' }, { items: [] }), {
    tab: { kind: 'active' },
    destination: { kind: 'review', reviewId: 'r', explore: false },
  });
  assert.deepEqual(routeDeepLink({ kind: 'queue', filters: { read: 'unread' } }, { tabs: [tab('t1')], active: 't1' }, { items: [] }), {
    tab: { kind: 'active' },
    destination: { kind: 'home', section: 'all', filters: { read: 'unread' } },
  });
});
