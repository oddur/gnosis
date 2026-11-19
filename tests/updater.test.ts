import test from 'node:test';
import assert from 'node:assert/strict';
import {
  macUpdateManifestName,
  normalizeUpdateChannel,
  resolveUpdate,
  stableFeedUrl,
  updateFeedFor,
  type ReleaseLike,
} from '../lib/updater';
import { stableChannelNote, upToDateMessage } from '../lib/update-channel';

const RELEASES = 'https://github.com/oddur/gnosis/releases';

function release(tag: string, options: { prerelease?: boolean; draft?: boolean; assets?: string[] } = {}): ReleaseLike {
  const assets = options.assets ?? defaultAssets(tag);
  return {
    tag_name: tag,
    html_url: `${RELEASES}/tag/${tag}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? /-/.test(tag),
    assets: assets.map((name) => ({ name, browser_download_url: `${RELEASES}/download/${tag}/${name}` })),
  };
}

function defaultAssets(tag: string): string[] {
  const version = tag.replace(/^v/, '');
  const nuget = version.replace(/-(.*)$/, (_m, pre: string) => `-${pre.replace(/\./g, '')}`);
  return [
    `Gnosis-darwin-arm64-${version}.zip`,
    ...(/-/.test(version) ? [macUpdateManifestName('arm64')] : []),
    'RELEASES',
    `gnosis-${nuget}-full.nupkg`,
    `Gnosis-${version}.Setup.exe`,
  ];
}

// Newest first, as GitHub lists them. Includes the real oddities: a stable-looking tag flagged prerelease (v0.19.0)
// and an old `-pre` tag.
const LIST = [
  release('v0.43.0-beta.1'),
  release('v0.42.0'),
  release('v0.42.0-beta.10'),
  release('v0.42.0-beta.2'),
  release('v0.41.0'),
  release('v0.19.0', { prerelease: true }),
  release('v0.16.1-pre'),
];

void test('Stable is never offered a prerelease, even a newer one', () => {
  const list = [release('v0.42.0-beta.3'), release('v0.41.0'), release('v0.40.0')];
  assert.equal(resolveUpdate('stable', '0.41.0', list), null);
  assert.equal(resolveUpdate('stable', '0.40.0', list)?.version, '0.41.0');
  assert.equal(resolveUpdate('stable', '0.40.0', list)?.prerelease, false);
  // A prerelease tag that GitHub failed to flag is still not stable.
  assert.equal(resolveUpdate('stable', '0.41.0', [release('v0.42.0-beta.3', { prerelease: false })]), null);
  // A stable-looking tag flagged prerelease on GitHub is not stable either.
  assert.equal(resolveUpdate('stable', '0.18.0', [release('v0.19.0', { prerelease: true })]), null);
  for (const current of ['0.30.0', '0.41.0', '0.42.0-beta.2', '0.42.0']) {
    const target = resolveUpdate('stable', current, LIST);
    assert.ok(!target || !target.prerelease, `${current} got ${target?.version}`);
  }
});

void test('Pre-release takes the newest build of either kind', () => {
  assert.equal(resolveUpdate('prerelease', '0.41.0', LIST)?.version, '0.43.0-beta.1');
  assert.equal(resolveUpdate('prerelease', '0.41.0', LIST)?.prerelease, true);
  // Stable 0.42.0 replaces 0.42.0-beta.10 when it is the newest.
  const withoutNextBeta = LIST.slice(1);
  const target = resolveUpdate('prerelease', '0.42.0-beta.10', withoutNextBeta);
  assert.equal(target?.version, '0.42.0');
  assert.equal(target.prerelease, false);
  assert.equal(target.releaseUrl, `${RELEASES}/tag/v0.42.0`);
  // beta.10 beats beta.2.
  assert.equal(resolveUpdate('prerelease', '0.42.0-beta.2', [release('v0.42.0-beta.2'), release('v0.42.0-beta.10')])?.version, '0.42.0-beta.10');
});

void test('no channel ever downgrades or reinstalls the running build', () => {
  for (const channel of ['stable', 'prerelease'] as const) {
    assert.equal(resolveUpdate(channel, '0.43.0-beta.1', LIST), null, channel);
    assert.equal(resolveUpdate(channel, '0.44.0', LIST), null, channel);
    assert.equal(resolveUpdate(channel, '0.42.0', [release('v0.42.0'), release('v0.42.0-beta.10')]), null, channel);
  }
  // On Stable with a pre-release build, the older stable 0.41.0 is not offered.
  assert.equal(resolveUpdate('stable', '0.42.0-beta.2', [release('v0.41.0')]), null);
  assert.equal(resolveUpdate('stable', '0.42.0-beta.2', [release('v0.42.0'), release('v0.41.0')])?.version, '0.42.0');
});

void test('skips drafts and tags that are not versions', () => {
  const list = [release('v0.50.0', { draft: true }), release('nightly'), release('v0.45'), release('v0.42.0-beta.1')];
  assert.equal(resolveUpdate('prerelease', '0.41.0', list)?.version, '0.42.0-beta.1');
  assert.equal(resolveUpdate('stable', '0.41.0', list), null);
  assert.equal(resolveUpdate('prerelease', '0.41.0', []), null);
});

void test('the stable feed is exactly the update.electronjs.org URL Gnosis has always used', () => {
  assert.equal(stableFeedUrl('darwin', 'arm64', '0.41.0'), 'https://update.electronjs.org/oddur/gnosis/darwin-arm64/0.41.0');
  assert.equal(stableFeedUrl('win32', 'x64', '0.42.0-beta.2'), 'https://update.electronjs.org/oddur/gnosis/win32-x64/0.42.0-beta.2');
  // Stable never needs a release list: the target is ignored.
  const target = resolveUpdate('prerelease', '0.41.0', LIST);
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(updateFeedFor({ channel: 'stable', platform, arch: 'x64', currentVersion: '0.41.0', target }), {
      kind: 'feed',
      url: `https://update.electronjs.org/oddur/gnosis/${platform}-x64/0.41.0`,
      target: null,
    });
  }
});

void test('Pre-release feeds: the macOS manifest, the Windows download folder, or update.electronjs.org for a stable target', () => {
  const beta = resolveUpdate('prerelease', '0.41.0', LIST);
  assert.deepEqual(updateFeedFor({ channel: 'prerelease', platform: 'darwin', arch: 'arm64', currentVersion: '0.41.0', target: beta }), {
    kind: 'feed',
    url: `${RELEASES}/download/v0.43.0-beta.1/Gnosis-darwin-arm64-update.json`,
    target: beta,
  });
  assert.deepEqual(updateFeedFor({ channel: 'prerelease', platform: 'win32', arch: 'x64', currentVersion: '0.41.0', target: beta }), {
    kind: 'feed',
    url: `${RELEASES}/download/v0.43.0-beta.1`,
    target: beta,
  });
  const stable = resolveUpdate('prerelease', '0.42.0-beta.10', LIST.slice(1));
  assert.deepEqual(updateFeedFor({ channel: 'prerelease', platform: 'darwin', arch: 'arm64', currentVersion: '0.42.0-beta.10', target: stable }), {
    kind: 'feed',
    url: 'https://update.electronjs.org/oddur/gnosis/darwin-arm64/0.42.0-beta.10',
    target: stable,
  });
  assert.equal(updateFeedFor({ channel: 'prerelease', platform: 'linux', arch: 'x64', currentVersion: '0.41.0', target: beta }).kind, 'manual');
});

void test('Pre-release offers a download instead when the update files are missing', () => {
  const bare = resolveUpdate('prerelease', '0.41.0', [release('v0.42.0-beta.1', { assets: ['Gnosis-darwin-arm64-0.42.0-beta.1.zip'] })]);
  const mac = updateFeedFor({ channel: 'prerelease', platform: 'darwin', arch: 'arm64', currentVersion: '0.41.0', target: bare });
  assert.equal(mac.kind, 'manual');
  assert.equal(mac.target.releaseUrl, `${RELEASES}/tag/v0.42.0-beta.1`);
  // An Intel Mac needs its own manifest.
  const full = resolveUpdate('prerelease', '0.41.0', [release('v0.42.0-beta.1')]);
  assert.equal(updateFeedFor({ channel: 'prerelease', platform: 'darwin', arch: 'x64', currentVersion: '0.41.0', target: full }).kind, 'manual');
  assert.equal(updateFeedFor({ channel: 'prerelease', platform: 'win32', arch: 'x64', currentVersion: '0.41.0', target: bare }).kind, 'manual');
});

void test('Pre-release with nothing newer points Squirrel nowhere', () => {
  assert.deepEqual(updateFeedFor({ channel: 'prerelease', platform: 'darwin', arch: 'arm64', currentVersion: '0.43.0-beta.1', target: null }), { kind: 'none' });
  // Even a target that is not newer is refused: Squirrel.Mac would download whatever the feed names.
  const old = resolveUpdate('prerelease', '0.41.0', [release('v0.42.0-beta.1')]);
  assert.deepEqual(updateFeedFor({ channel: 'prerelease', platform: 'darwin', arch: 'arm64', currentVersion: '0.42.0-beta.2', target: old }), { kind: 'none' });
});

void test('normalizes the channel preference', () => {
  assert.equal(normalizeUpdateChannel('prerelease'), 'prerelease');
  for (const value of ['stable', undefined, null, '', 'beta', 'Prerelease', 1, {}]) assert.equal(normalizeUpdateChannel(value), 'stable');
});

void test('explains the no-downgrade rule when a pre-release build is on Stable', () => {
  assert.equal(
    stableChannelNote('0.42.0-beta.3'),
    "You're on v0.42.0-beta.3, a pre-release. Gnosis won't go back to an older version: you'll get the next stable release, 0.42.0 or later."
  );
  assert.equal(stableChannelNote('0.42.0'), null);
  assert.equal(upToDateMessage('stable', '0.42.0-beta.3'), stableChannelNote('0.42.0-beta.3'));
  assert.equal(upToDateMessage('stable', '0.42.0'), 'Gnosis v0.42.0 is the newest stable release.');
  assert.equal(upToDateMessage('prerelease', '0.42.0-beta.3'), 'Gnosis v0.42.0-beta.3 is the newest build.');
});
