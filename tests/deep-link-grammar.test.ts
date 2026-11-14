import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEEP_LINK_MAX_LENGTH,
  formatDeepLink,
  githubUrl,
  parseDeepLink,
  parseDeepLinkError,
  parseDeepLinkTarget,
  parseGitHubUrl,
  prDeepLinks,
  targetFromLocation,
  type DeepLinkTarget,
} from '../lib/deep-link';
import { DEFAULT_QUEUE_FILTERS } from '../lib/queue-filters';
import type { HomeLocation } from '../lib/navigation-history';

const schemes = ['gnosis'];
const corpus = JSON.parse(fs.readFileSync('tests/fixtures/deep-link-corpus.json', 'utf8')) as {
  valid: { name: string; link: string; target: DeepLinkTarget }[];
  rejected: { name: string; link: string; error: string }[];
};
const pages = JSON.parse(fs.readFileSync('tests/fixtures/github-page-urls.json', 'utf8')) as {
  urls: { url: string; kind: string; target: string; note?: string }[];
};
const parsed = (link: string) => {
  const result = parseDeepLink(link, schemes);
  return 'target' in result ? result.target : undefined;
};
const errorOf = (link: string) => {
  const result = parseDeepLink(link, schemes);
  return 'error' in result ? result.error.code : undefined;
};
const roundTrips = (target: DeepLinkTarget, name: string) => {
  assert.deepEqual(parsed(formatDeepLink(target)), target, `parse(format(t)) for ${name}: ${formatDeepLink(target)}`);
  // Everything the parser produces survives the IPC re-validation unchanged.
  assert.deepEqual(parseDeepLinkTarget(target), target, `parseDeepLinkTarget for ${name}`);
};

void test('every route parses to its target and round-trips through the formatter', () => {
  for (const entry of corpus.valid) {
    const result = parseDeepLink(entry.link, schemes);
    assert.deepEqual(result, { target: entry.target }, entry.name);
    roundTrips(entry.target, entry.name);
  }
});

void test('the malicious-input corpus is refused with the stated code', () => {
  for (const entry of corpus.rejected) assert.equal(errorOf(entry.link), entry.error, `${entry.name}: ${JSON.stringify(entry.link)}`);
});

void test('every GitHub page URL shape maps to its table 3.4 target, through open?url= and directly', () => {
  assert.equal(pages.urls.length, 59);
  for (const row of pages.urls) {
    const link = `gnosis://open?url=${encodeURIComponent(row.url)}`;
    const direct = parseGitHubUrl(row.url);
    const target = parsed(link);
    const label = `${row.url}${row.note ? ` (${row.note})` : ''}`;
    if (row.target === 'unsupported') {
      assert.equal(direct, undefined, label);
      assert.match(errorOf(link) ?? '', /^unsupported-(url|host)$/, label);
      continue;
    }
    assert.ok(target, label);
    assert.deepEqual(target, direct, label);
    if (row.target === 'summary') assert.deepEqual([target.kind, target.kind === 'pr' && target.tab], ['pr', undefined], label);
    else if (['feedback', 'changes', 'commits', 'checks'].includes(row.target))
      assert.deepEqual([target.kind, target.kind === 'pr' && target.tab], ['pr', row.target], label);
    else assert.equal(target.kind, row.target, label);
    roundTrips(target, label);
  }
});

void test('GitHub URL locators: anchors, lines, sides, comments, commits and checks', () => {
  const anchor = '4fab5baaca5c14d2de62d8d2fceef376ddddcc8e9509d86cfa5643f51b89ce3d';
  const pr = { host: 'github.com', owner: 'oddur', repo: 'gnosis', number: 160 };
  assert.deepEqual(parseGitHubUrl(`https://github.com/oddur/gnosis/pull/160/files#diff-${anchor}L12-R14`), {
    kind: 'pr', pr, tab: 'changes', file: { anchor, line: 12, side: 'before' },
  }, 'A range that mixes sides keeps the first line');
  assert.deepEqual(parseGitHubUrl('https://github.com/oddur/gnosis/pull/160/checks?check_run_id=31000000004&foo=1'), { kind: 'pr', pr, tab: 'checks', check: '31000000004' });
  assert.deepEqual(parseGitHubUrl('https://github.com/oddur/gnosis/pull/160#r1800000003'), { kind: 'pr', pr, tab: 'feedback', commentId: '1800000003' });
  // A diff anchor on the Conversation tab is not a place Gnosis can show there.
  assert.deepEqual(parseGitHubUrl(`https://github.com/oddur/gnosis/pull/160#diff-${anchor}`), { kind: 'pr', pr });
  assert.deepEqual(parseGitHubUrl('https://github.com/oddur/gnosis/compare/main...someone:feat/a%2Bb'), {
    kind: 'compare', host: 'github.com', owner: 'oddur', repo: 'gnosis', base: 'main', head: 'feat/a+b', headOwner: 'someone',
  });
  for (const bad of [
    'https://github.com/oddur/gnosis/compare/main...feat..x',
    'https://github.com/oddur/gnosis/compare/main...feat/.hidden',
    'https://github.com/oddur/gnosis/pull/160/files/nothex',
    'https://github.com/oddur/gnosis/pull/160/checks/1',
    'https://github.com/oddur/gnosis/actions/runs/1?pr=0',
    'https://github.com/oddur/gnosis/commit/xyz',
    'https://github.com/pulls/unknown',
    `https://github.com/${'o'.repeat(2001)}`,
  ])
    assert.equal(parseGitHubUrl(bad), undefined, bad);
});

void test('length, value and parameter-count limits are enforced before anything else', () => {
  const base = 'gnosis://pr/o/r/1?';
  const fill = (length: number) => {
    // Unknown parameters of at most 512 characters, padded to an exact total length.
    const parts: string[] = [];
    let link = base;
    for (let i = 0; link.length < length; i++) {
      const room = length - link.length - (parts.length ? 1 : 0) - `p${i}=`.length;
      const part = `p${i}=${'a'.repeat(Math.max(0, Math.min(500, room)))}`;
      parts.push(part);
      link = base + parts.join('&');
    }
    return link;
  };
  const longest = fill(DEEP_LINK_MAX_LENGTH);
  assert.equal(longest.length, DEEP_LINK_MAX_LENGTH);
  assert.deepEqual(parsed(longest), { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 1 } });
  assert.equal(errorOf(`${longest}a`), 'too-long', 'A 4097-character link');
  assert.equal(errorOf(`gnosis://queue?q=${'x'.repeat(2 * 1024 * 1024)}`), 'too-long', 'A 2 MB query is refused before parsing');
  assert.equal(errorOf(`gnosis://queue?q=${'x'.repeat(201)}`), 'too-long');
  assert.equal(errorOf(`gnosis://pr/o/r/1/changes?file=${'a'.repeat(1025)}`), 'too-long');
  assert.equal(errorOf(`gnosis://pr/o/r/1?x=${'a'.repeat(513)}`), 'too-long');
  assert.equal(errorOf(`gnosis://open?url=${encodeURIComponent(`https://github.com/o/r/pull/1#${'a'.repeat(2000)}`)}`), 'too-long');
  const params = (count: number) => `gnosis://pr/o/r/1?${Array.from({ length: count }, (_, i) => `p${i}=1`).join('&')}`;
  assert.ok(parsed(params(16)), '16 parameters');
  assert.equal(errorOf(params(17)), 'bad-parameter', '17 parameters');
});

void test('the scheme decides the build: gnosis when packaged, gnosis-dev in development', () => {
  assert.ok('target' in parseDeepLink('gnosis-dev://pr/o/r/1', ['gnosis-dev']));
  assert.deepEqual(parseDeepLink('gnosis://pr/o/r/1', ['gnosis-dev']), { error: { code: 'malformed' } });
  assert.ok('error' in parseDeepLink(42 as unknown as string, schemes));
});

void test('errors name the route word at most and never echo the link', () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  for (const link of [`gnosis://pr/o/r/1?file=${secret}%00`, `gnosis://${secret}/x`, `gnosis://open?url=https%3A%2F%2Fevil.io%2F${secret}`]) {
    const result = parseDeepLink(link, schemes);
    assert.ok('error' in result);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
  assert.deepEqual(parseDeepLink('gnosis://pr/o/r/1?v=2', schemes), { error: { code: 'unsupported-version', route: 'pr' } });
  assert.deepEqual(parseDeepLinkError({ code: 'rate-limited', count: 3, route: 'nope', extra: 1 }), { code: 'rate-limited', count: 3 });
  assert.equal(parseDeepLinkError({ code: 'pwned' }), undefined);
});

void test('targets crossing IPC are re-validated field by field', () => {
  const pr = { host: 'github.com', owner: 'o', repo: 'r', number: 1 };
  for (const bad of [
    { kind: 'pr', pr, file: { path: '../x' } },
    { kind: 'pr', pr, file: { line: 3 } },
    { kind: 'pr', pr, file: { path: 'a', line: 5, endLine: 2 } },
    { kind: 'pr', pr, commentId: '1; drop' },
    { kind: 'pr', pr, scope: 'everything' },
    { kind: 'conflicts', pr: { ...pr, repo: '..' } },
    { kind: 'review', reviewId: 'r', file: { path: 'a', sha: 'e49f59e6d81ad44fc709ddd318911b41fad2bc28' } },
    { kind: 'queue', filters: { repo: '../../x' } },
    { kind: 'queue', view: 'a‮b' },
    { kind: 'settings', section: 'secrets' },
    { kind: 'commit', host: 'evil.io', owner: 'o', repo: 'r', sha: 'e49f59e' },
    { kind: 'compare', host: 'github.com', owner: 'o', repo: 'r', head: 'a..b' },
    { kind: 'shell', command: 'rm' },
  ])
    assert.equal(parseDeepLinkTarget(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(parseDeepLinkTarget({ kind: 'activity', path: '/etc' }), { kind: 'activity' });
});

void test('"Open on GitHub" URLs are rebuilt from parsed fields', () => {
  const pr = { host: 'github.com', owner: 'o', repo: 'r', number: 1 };
  assert.equal(githubUrl({ kind: 'pr', pr, tab: 'checks', check: '9' }), 'https://github.com/o/r/pull/1/checks?check_run_id=9');
  assert.equal(githubUrl({ kind: 'pr', pr, tab: 'changes' }), 'https://github.com/o/r/pull/1/files');
  // A host never comes from the target: only github.com is ever opened.
  assert.equal(githubUrl({ kind: 'pr', pr: { ...pr, host: 'evil.io' } }), 'https://github.com/o/r/pull/1');
  assert.equal(githubUrl({ kind: 'queue', section: 'requested' }), 'https://github.com/pulls/review-requested');
  assert.equal(githubUrl({ kind: 'activity' }), undefined);
});

void test('Copy Gnosis link formats PR links, and a tab location becomes its target', () => {
  assert.deepEqual(prDeepLinks(['https://github.com/oddur/gnosis/pull/160', 'local:/repo', 'https://github.com/o/r/pull/2'], 'gnosis-dev'), [
    'gnosis-dev://pr/oddur/gnosis/160',
    'gnosis-dev://pr/o/r/2',
  ]);
  const home = (patch: Partial<HomeLocation>): HomeLocation => ({
    account: 'a', filters: DEFAULT_QUEUE_FILTERS, savedView: false, savedQuery: '', viewId: null, muted: false, item: null, tab: 'summary', selected: null, scroll: 0, ...patch,
  });
  const member = { url: 'https://github.com/oddur/gnosis/pull/160' };
  const item = { attention: 'other', subject: { id: member.url, kind: 'pr', members: [member] } } as unknown as HomeLocation['item'];
  assert.deepEqual(targetFromLocation({ page: 'home', home: home({ item, tab: 'brief' }) }), {
    kind: 'pr', pr: { host: 'github.com', owner: 'oddur', repo: 'gnosis', number: 160 }, tab: 'notes',
  });
  const checks = targetFromLocation({ page: 'home', home: home({ item, tab: 'checks' }) });
  assert.ok(checks);
  assert.equal(formatDeepLink(checks), 'gnosis://pr/oddur/gnosis/160/checks');
  assert.deepEqual(targetFromLocation({ page: 'review', reviewId: 'r1' }), { kind: 'review', reviewId: 'r1' });
  assert.deepEqual(targetFromLocation({ page: 'home', home: home({ muted: true }) }), { kind: 'queue', section: 'muted' });
  assert.deepEqual(targetFromLocation({ page: 'home', home: home({ filters: { ...DEFAULT_QUEUE_FILTERS, attention: 'requested', repo: 'oddur/gnosis', readStatus: 'unread' } }) }), {
    kind: 'queue', section: 'requested', filters: { repo: 'oddur/gnosis', read: 'unread' },
  });
});
