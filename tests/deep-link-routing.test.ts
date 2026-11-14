import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkErrorNotice, linkSupport, prLinkBlock, prMetadataItem, routeDeepLink } from '../lib/deep-link-routing';
import { parseDeepLink, type DeepLinkTarget, type PrLinkTarget } from '../lib/deep-link';
import { groupSubjects } from '../lib/workbench';
import type { WorkspaceTabEntry } from '../lib/workspace-tabs';
import type { PrMetadata } from '../lib/types';
import { member } from './notification-fixtures';

const pr = { host: 'github.com', owner: 'oddur', repo: 'gnosis', number: 160 };
const tab = (id: string, location?: WorkspaceTabEntry['location']): WorkspaceTabEntry => ({ id, title: id, label: id, detail: '', section: '', location });
const link = (raw: string) => {
  const result = parseDeepLink(raw, ['gnosis']);
  assert.ok('target' in result, raw);
  return result.target;
};

void test('Phase 1 opens PR links from outside, at their tab', () => {
  for (const source of ['os', 'content'] as const) {
    assert.deepEqual(linkSupport(link('gnosis://pr/oddur/gnosis/160/checks'), source), { supported: true, target: { kind: 'pr', pr, tab: 'checks' } });
    const open = linkSupport(link('gnosis://open?url=https%3A%2F%2Fgithub.com%2Foddur%2Fgnosis%2Fpull%2F160%2Ffiles'), source);
    assert.deepEqual(open, { supported: true, target: { kind: 'pr', pr, tab: 'changes' } });
  }
});

void test('a locator this version cannot follow opens the tab with a note, never nothing', () => {
  const support = linkSupport(link('gnosis://pr/oddur/gnosis/160/changes?file=src/main.ts&line=4'), 'os');
  assert.equal(support.supported, true);
  assert.ok(support.supported);
  assert.deepEqual(support.target, { kind: 'pr', pr, tab: 'changes' }, 'The locator is not passed on');
  assert.equal(support.note?.title, 'Opened oddur/gnosis#160');
  assert.match(support.note.description ?? '', /Links to a file or line are not supported yet, so Gnosis opened the Changes tab/);
  const comment = linkSupport(link('gnosis://open?url=https%3A%2F%2Fgithub.com%2Foddur%2Fgnosis%2Fpull%2F160%23issuecomment-5'), 'os');
  assert.ok(comment.supported);
  assert.deepEqual(comment.target, { kind: 'pr', pr, tab: 'feedback' });
  assert.match(comment.note?.description ?? '', /a comment/);
  const stack = linkSupport(link('gnosis://stack/oddur/gnosis/160'), 'content');
  assert.ok(stack.supported);
  assert.deepEqual(stack.target, { kind: 'pr', pr });
  assert.match(stack.note?.description ?? '', /whole stack/);
});

void test('other routes from outside say they are not supported yet, with a safe fallback', () => {
  const routes: [string, string | undefined][] = [
    ['gnosis://queue?section=requested', 'https://github.com/pulls/review-requested'],
    ['gnosis://review/3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c', undefined],
    ['gnosis://settings/repositories', undefined],
    ['gnosis://activity', undefined],
    ['gnosis://open?url=https%3A%2F%2Fgithub.com%2Foddur%2Fgnosis%2Fcommit%2Fe49f59e', 'https://github.com/oddur/gnosis/commit/e49f59e'],
    ['gnosis://open?url=https%3A%2F%2Fgithub.com%2Foddur%2Fgnosis%2Fcompare%2Fmain...feat%2Fx', 'https://github.com/oddur/gnosis/compare/main...feat/x'],
  ];
  for (const [raw, url] of routes) {
    const support = linkSupport(link(raw), 'os');
    assert.equal(support.supported, false, raw);
    assert.ok(!support.supported);
    assert.equal(support.title, 'This link is not supported yet', raw);
    assert.deepEqual(support.action, url ? { label: 'Open on GitHub', url } : undefined, raw);
  }
  const conflicts = linkSupport(link('gnosis://conflicts/oddur/gnosis/160'), 'os');
  assert.ok(!conflicts.supported);
  assert.deepEqual(conflicts.action, { label: 'Open PR', target: { kind: 'pr', pr } }, 'A link never starts conflict resolution');
});

void test('trust by source: targets Gnosis built keep the routes the app already handles', () => {
  for (const source of ['notification', 'menubar', 'tray'] as const) {
    assert.equal(linkSupport({ kind: 'review', reviewId: 'local-1' }, source).supported, true);
    assert.equal(linkSupport({ kind: 'queue', filters: { read: 'unread' } }, source).supported, true);
    assert.equal(linkSupport({ kind: 'settings', section: 'notifications' }, source).supported, true, 'The panel opens Settings');
    assert.equal(linkSupport({ kind: 'activity' }, source).supported, true);
  }
  assert.equal(linkSupport({ kind: 'settings', section: 'notifications' }, 'os').supported, false);
  assert.equal(linkSupport({ kind: 'review', reviewId: 'local-1' }, 'os').supported, false);
  assert.equal(linkSupport({ kind: 'conflicts', pr }, 'notification').supported, false, 'Conflict links wait for Phase 3 everywhere');
});

void test('signed out and muted PRs are blocked before any GitHub read; a link never unmutes', () => {
  const target: PrLinkTarget = { kind: 'pr', pr };
  assert.deepEqual(prLinkBlock(target, { signedIn: false, mutedUrls: new Set() }), {
    title: 'Connect GitHub to open oddur/gnosis#160',
    action: { label: 'Connect GitHub', destination: { kind: 'home', account: true } },
  });
  const muted = prLinkBlock(target, { signedIn: true, mutedUrls: new Set(['https://github.com/oddur/gnosis/pull/160']) });
  assert.equal(muted?.title, 'oddur/gnosis#160 is muted');
  assert.deepEqual(muted.action, { label: 'Show muted PRs', target: { kind: 'queue', section: 'muted' } });
  assert.equal(prLinkBlock(target, { signedIn: true, mutedUrls: new Set() }), undefined);
});

void test('refusals become a short reason and never echo the link', () => {
  assert.deepEqual(linkErrorNotice({ code: 'bad-parameter', route: 'pr' }), { title: 'Could not open link', description: 'The link has a value Gnosis cannot use. (pr link)' });
  assert.deepEqual(linkErrorNotice({ code: 'unsupported-version' }), { title: 'Could not open link', description: 'This link needs a newer version of Gnosis.' });
  assert.equal(linkErrorNotice({ code: 'rate-limited', count: 195 }).title, 'Ignored 195 links');
  assert.equal(linkErrorNotice({ code: 'rate-limited', count: 1 }).title, 'Ignored 1 link');
});

void test('routing: reuse the tab showing the PR, else a new tab; never replace another tab', () => {
  const a = member(1), b = member(2, { baseBranch: a.headBranch });
  const [stack] = groupSubjects([a, b]);
  const queue = { items: [{ subject: stack, attention: 'other' as const }] };
  const fresh = routeDeepLink({ kind: 'pr', pr: { host: 'github.com', owner: 'klang', repo: 'engine', number: 2 }, tab: 'checks' } as DeepLinkTarget, { tabs: [tab('t1')], active: 't1' }, queue, 5);
  assert.deepEqual(fresh.tab, { kind: 'new' });
  const showing = tab('t2', { page: 'home', home: { item: { subject: stack, attention: 'other' } } as never });
  const url = new URL(b.url);
  const [, owner, repo, , number] = url.pathname.split('/');
  const target: DeepLinkTarget = { kind: 'pr', pr: { host: 'github.com', owner, repo, number: Number(number) } };
  assert.deepEqual(routeDeepLink(target, { tabs: [tab('t1'), showing], active: 't1' }, queue).tab, { kind: 'reuse', id: 't2' });
  // A stack-scoped target opens the whole stack, unfocused.
  const scoped = routeDeepLink({ ...target, scope: 'stack' } as DeepLinkTarget, { tabs: [tab('t1')], active: 't1' }, queue, 1);
  assert.equal(scoped.destination.kind === 'home' && scoped.destination.subject, queue.items[0]);
  const member2 = routeDeepLink(target, { tabs: [tab('t1')], active: 't1' }, queue, 1);
  assert.equal(member2.destination.kind === 'home' && member2.destination.subject?.subject.members[0].url, b.url, 'A stack member is focused');
});

void test('routing for the other kinds, for when they are enabled', () => {
  const state = { tabs: [tab('t1')], active: 't1' };
  assert.deepEqual(routeDeepLink({ kind: 'settings', section: 'repositories' }, state, { items: [] }), { tab: { kind: 'active' }, destination: { kind: 'home', settings: 'repositories' } });
  assert.deepEqual(routeDeepLink({ kind: 'activity' }, state, { items: [] }), { tab: { kind: 'active' }, destination: { kind: 'activity' } });
  assert.deepEqual(routeDeepLink({ kind: 'queue', view: 'My reviews' }, state, { items: [] }).destination, { kind: 'home', section: 'all', viewId: 'My reviews' });
  assert.deepEqual(routeDeepLink({ kind: 'queue', filters: { repo: 'o/r' } }, state, { items: [] }).destination, { kind: 'home', section: 'all', repo: 'o/r', filters: { repo: 'o/r' } });
  assert.deepEqual(routeDeepLink({ kind: 'conflicts', pr }, state, { items: [] }, 3).destination, { kind: 'home', url: 'https://github.com/oddur/gnosis/pull/160', open: { tab: undefined, nonce: 3 } });
  assert.deepEqual(
    routeDeepLink({ kind: 'commit', host: 'github.com', owner: 'o', repo: 'r', sha: 'e49f59e' }, state, { items: [] }).destination,
    { kind: 'home', section: 'all', repo: 'o/r', filters: { repo: 'o/r' } },
    'Without a lookup, a commit opens its repository'
  );
});

void test('a PR outside the queue becomes a watched queue item from its metadata', () => {
  const meta = { title: 'Add links', author: 'oddur', headSha: 'h' } as unknown as PrMetadata;
  const item = prMetadataItem(pr, meta);
  assert.equal(item.subject.id, 'https://github.com/oddur/gnosis/pull/160');
  assert.equal(item.subject.title, 'Add links');
  assert.deepEqual([item.subject.members[0].number, item.subject.members[0].repo, item.subject.members[0].role], [160, 'oddur/gnosis', 'watched']);
});
