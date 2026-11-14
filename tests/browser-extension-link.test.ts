import assert from 'node:assert/strict';
import { test } from 'node:test';
import fixture from './fixtures/github-page-urls.json';
import { buildGnosisLink, isSupportedPage, MAX_LINK_LENGTH } from '../extensions/browser/src/link';
import { buildManifest, CONTENT_SCRIPT_MATCHES, FIREFOX_ADDON_ID } from '../extensions/browser/manifest';

interface FixtureUrl {
  url: string;
  kind: string;
  target: string;
  extensionButton: boolean;
}

const urls: FixtureUrl[] = fixture.urls;

void test('the fixture covers every page family in design table 3.4', () => {
  const kinds = new Set(urls.map((entry) => entry.kind));
  for (const kind of ['pull', 'actions', 'commit', 'compare', 'queue', 'unsupported']) assert.ok(kinds.has(kind), kind);
  const targets = new Set(urls.map((entry) => entry.target));
  for (const target of ['summary', 'feedback', 'changes', 'commits', 'checks', 'conflicts', 'commit', 'compare']) {
    assert.ok(targets.has(target), target);
  }
  assert.ok(urls.some((entry) => /#diff-[0-9a-f]{64}R42$/.test(entry.url)));
  assert.ok(urls.some((entry) => entry.url.includes('#discussion_r')));
});

void test('every fixture URL becomes gnosis://open?url=<encoded URL> and round-trips', () => {
  for (const { url } of urls) {
    const link = buildGnosisLink(url);
    assert.equal(link, `gnosis://open?url=${encodeURIComponent(url)}`);
    const parsed = new URL(link);
    assert.equal(parsed.protocol, 'gnosis:');
    assert.equal(parsed.host, 'open');
    assert.deepEqual([...parsed.searchParams.keys()], ['url']);
    assert.equal(parsed.searchParams.get('url'), url);
    assert.equal(decodeURIComponent(link.slice('gnosis://open?url='.length)), url);
  }
});

void test('the developer scheme only changes the scheme', () => {
  const url = urls[0].url;
  assert.equal(buildGnosisLink(url, 'gnosis-dev'), `gnosis-dev://open?url=${encodeURIComponent(url)}`);
});

void test('a link over the length limit drops the query except pr and check_run_id', () => {
  const hash = '#diff-4fab5baaca5c14d2de62d8d2fceef376ddddcc8e9509d86cfa5643f51b89ce3dR42';
  const long = `https://github.com/oddur/gnosis/pull/160/checks?check_run_id=7&pr=160&junk=${'x'.repeat(5000)}${hash}`;
  const link = buildGnosisLink(long);
  assert.ok(link.length <= MAX_LINK_LENGTH);
  assert.equal(
    new URL(link).searchParams.get('url'),
    `https://github.com/oddur/gnosis/pull/160/checks?pr=160&check_run_id=7${hash}`
  );

  const longHash = `https://github.com/oddur/gnosis/pull/160?a=1#${'y'.repeat(5000)}`;
  assert.equal(new URL(buildGnosisLink(longHash)).searchParams.get('url'), 'https://github.com/oddur/gnosis/pull/160');

  const atLimit = `https://github.com/oddur/gnosis/pull/160?q=${'z'.repeat(3000)}`;
  assert.equal(new URL(buildGnosisLink(atLimit)).searchParams.get('url'), atLimit);
});

void test('page detection: pull request, commit and compare pages yes, others no', () => {
  for (const entry of urls) {
    assert.equal(isSupportedPage(entry.url), entry.extensionButton, entry.url);
    if (['pull', 'commit', 'compare'].includes(entry.kind)) assert.equal(isSupportedPage(entry.url), true, entry.url);
  }
  for (const other of ['not a url', 'gnosis://open?url=x', 'https://github.com/', 'https://github.com/oddur']) {
    assert.equal(isSupportedPage(other), false, other);
  }
});

void test('the manifests ask for no more than the GitHub match, storage and activeTab', () => {
  for (const browser of ['chrome', 'firefox'] as const) {
    const manifest = buildManifest(browser);
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['storage', 'activeTab']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.optional_host_permissions, undefined);
    assert.deepEqual(CONTENT_SCRIPT_MATCHES, ['https://github.com/*']);
  }
  assert.deepEqual(buildManifest('chrome').background, { service_worker: 'background.js' });
  const firefox = buildManifest('firefox');
  assert.deepEqual(firefox.background, { scripts: ['background.js'] });
  assert.equal((firefox.browser_specific_settings as { gecko: { id: string } }).gecko.id, FIREFOX_ADDON_ID);
  assert.equal(buildManifest('chrome').browser_specific_settings, undefined);
});
