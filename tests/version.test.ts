import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  PRERELEASE_TAG_PATTERN,
  STABLE_TAG_PATTERN,
  compareVersions,
  isNewerVersion,
  isPrereleaseVersion,
  normalizeReleaseVersion,
  parseVersion,
  releaseTagKind,
} from '../lib/version';
import { publishAsPrerelease } from '../lib/release-guard';

// Ascending semver precedence (#404).
const ORDERED = [
  '0.9.9',
  '0.10.0',
  '0.41.0',
  '0.42.0-alpha',
  '0.42.0-beta',
  '0.42.0-beta.1',
  '0.42.0-beta.2',
  '0.42.0-beta.9',
  '0.42.0-beta.10',
  '0.42.0-beta.11',
  '0.42.0-beta.100',
  '0.42.0-beta.x',
  '0.42.0',
  '0.42.1-beta.1',
  '0.42.1',
  '1.0.0-beta.1',
  '1.0.0',
];

void test('orders versions by semver precedence, prerelease numbers as numbers', () => {
  for (let i = 0; i < ORDERED.length; i++) {
    for (let j = 0; j < ORDERED.length; j++) {
      const expected = Math.sign(i - j);
      assert.equal(Math.sign(compareVersions(ORDERED[i], ORDERED[j]) ?? NaN), expected, `${ORDERED[i]} vs ${ORDERED[j]}`);
      assert.equal(isNewerVersion(ORDERED[i], ORDERED[j]), i > j, `${ORDERED[i]} newer than ${ORDERED[j]}`);
    }
  }
  const shuffled = [...ORDERED].reverse();
  assert.deepEqual(shuffled.sort((a, b) => compareVersions(a, b) ?? 0), ORDERED);
});

void test('the acceptance chain from the issue holds', () => {
  assert.equal(isNewerVersion('0.42.0-beta.10', '0.42.0-beta.2'), true);
  assert.equal(isNewerVersion('0.42.0', '0.42.0-beta.10'), true);
  assert.equal(isNewerVersion('0.42.1-beta.1', '0.42.0'), true);
  assert.equal(isNewerVersion('0.42.0-beta.2', '0.42.0'), false);
  assert.equal(isNewerVersion('0.42.0', '0.42.0-beta.2'), true);
});

void test('x.y.z comparisons are unchanged', () => {
  assert.equal(isNewerVersion('0.38.0', '0.37.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.37.0', '0.37.0'), false);
  assert.equal(isNewerVersion('0.36.5', '0.37.0'), false);
  assert.equal(isNewerVersion('v0.38.0', '0.37.0'), true);
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
});

void test('ignores build metadata and a leading v', () => {
  assert.equal(compareVersions('0.42.0+build.5', '0.42.0'), 0);
  assert.equal(compareVersions('v0.42.0-beta.1', '0.42.0-beta.1'), 0);
  assert.deepEqual(parseVersion('v0.42.0-beta.3+abc'), { major: 0, minor: 42, patch: 0, prerelease: ['beta', 3] });
});

void test('an unparseable version is never newer, and nothing is newer than it', () => {
  for (const bad of ['', 'latest', '0.42', '0.42.0.1', '01.2.3', '0.42.0-beta.01', '0.42.0-', '0.42.0-beta..1', 'Gnosis']) {
    assert.equal(parseVersion(bad), null, bad);
    assert.equal(isNewerVersion(bad, '0.1.0'), false, bad);
    assert.equal(isNewerVersion('9.9.9', bad), false, bad);
  }
});

void test('knows a pre-release version', () => {
  assert.equal(isPrereleaseVersion('0.42.0-beta.1'), true);
  assert.equal(isPrereleaseVersion('v0.16.1-pre'), true);
  assert.equal(isPrereleaseVersion('0.42.0'), false);
  assert.equal(isPrereleaseVersion('0.42.0+build'), false);
  assert.equal(isPrereleaseVersion('nonsense'), false);
  assert.equal(isPrereleaseVersion(undefined), false);
});

void test('reads the version from tags, release names and Squirrel.Windows NuGet versions', () => {
  const cases: [string, string][] = [
    ['v0.38.0', '0.38.0'],
    ['Gnosis 0.38.0', '0.38.0'],
    ['0.38.0', '0.38.0'],
    ['v0.42.0-beta.2', '0.42.0-beta.2'],
    ['Gnosis 0.42.0-beta.10', '0.42.0-beta.10'],
    // Squirrel.Windows reports the NuGet version, without the prerelease dot.
    ['0.42.0-beta2', '0.42.0-beta.2'],
    ['0.42.0-beta10', '0.42.0-beta.10'],
    ['v0.16.1-pre', '0.16.1-pre'],
  ];
  for (const [raw, expected] of cases) assert.equal(normalizeReleaseVersion(raw), expected, raw);
});

void test('accepts only the two documented tag forms', () => {
  const kinds: [string, ReturnType<typeof releaseTagKind>][] = [
    ['v0.42.0', 'stable'],
    ['v1.2.3', 'stable'],
    ['v0.42.0-beta.1', 'prerelease'],
    ['v0.42.0-beta.10', 'prerelease'],
    ['v0.42.0-beta.999', 'prerelease'],
    ['v0.42.0-beta.0', null],
    ['v0.42.0-beta.01', null],
    ['v0.42.0-beta.1000', null],
    ['v0.42.0-beta', null],
    ['v0.42.0-rc.1', null],
    ['v0.42.0-beta.1+build', null],
    ['0.42.0', null],
    ['v0.42', null],
    ['v0.16.1-pre', null],
  ];
  for (const [tag, kind] of kinds) assert.equal(releaseTagKind(tag), kind, tag);
});

void test('the Release workflow validates tags with the same patterns', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const pattern = (name: string) => new RegExp(`${name}='([^']+)'`).exec(workflow)?.[1];
  assert.equal(pattern('STABLE_TAG'), STABLE_TAG_PATTERN);
  assert.equal(pattern('PRERELEASE_TAG'), PRERELEASE_TAG_PATTERN);
  // Bash's =~ must agree with the JavaScript reading for every case above.
  const tags = ['v0.42.0', 'v0.42.0-beta.1', 'v0.42.0-beta.999', 'v0.42.0-beta.01', 'v0.42.0-beta.1000', 'v0.42.0-rc.1', 'v0.42.0-beta'];
  const script = `for t in "$@"; do if [[ "$t" =~ ${STABLE_TAG_PATTERN} ]]; then echo stable; elif [[ "$t" =~ ${PRERELEASE_TAG_PATTERN} ]]; then echo prerelease; else echo none; fi; done`;
  const result = spawnSync('bash', ['-c', script, 'bash', ...tags], { encoding: 'utf8' });
  if (result.error) return; // No bash on this machine; the pattern comparison above still holds.
  assert.deepEqual(result.stdout.trim().split('\n'), tags.map((tag) => releaseTagKind(tag) ?? 'none'));
});

void test('Forge publishes a pre-release version as a GitHub prerelease, and refuses a mismatched tag', () => {
  assert.equal(publishAsPrerelease('0.42.0'), false);
  assert.equal(publishAsPrerelease('0.42.0', 'stable'), false);
  assert.equal(publishAsPrerelease('0.42.0-beta.1'), true);
  assert.equal(publishAsPrerelease('0.42.0-beta.1', 'prerelease'), true);
  assert.throws(() => publishAsPrerelease('0.42.0', 'prerelease'), /Release kind mismatch/);
  assert.throws(() => publishAsPrerelease('0.42.0-beta.1', 'stable'), /Release kind mismatch/);
});

// Squirrel.Windows 2.0.1 (vendored by electron-winstaller 5) compares NuGet versions with Squirrel's NuGet fork:
// https://github.com/Squirrel/NuGet/blob/50f8d9e438fe948d7109501bd10f6024d0585b70/src/Core/SemanticVersion.cs#L216
// and reads a package's version from its file name with VersionExtensions._versionRegex:
// https://github.com/Squirrel/Squirrel.Windows/blob/develop/src/Squirrel/ReleaseExtensions.cs
function squirrelVersionFromFileName(fileName: string): string {
  const name = fileName.replace(/(-full|-delta)?\.nupkg$/, '');
  return /\d+(\.\d+){0,3}(-[A-Za-z][0-9A-Za-z-]*)?$/.exec(name)?.[0] ?? '';
}
function squirrelCompare(a: string, b: string): number {
  const split = (v: string) => {
    const [core, special = ''] = v.split(/-(.*)/s);
    const parts = core.split('.').map(Number);
    while (parts.length < 4) parts.push(0);
    return { parts, special };
  };
  const left = split(a), right = split(b);
  for (let i = 0; i < 4; i++) if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  if (!left.special && !right.special) return 0;
  if (!left.special) return 1;
  if (!right.special) return -1;
  const numbered = /([a-z]+)([0-9]+)$/i;
  const l = numbered.exec(left.special.trim()), r = numbered.exec(right.special.trim());
  if (l && r && l[1].toLowerCase() === r[1].toLowerCase()) {
    const delta = Number(l[2]) - Number(r[2]);
    if (delta) return delta;
  }
  const x = left.special.toLowerCase(), y = right.special.toLowerCase();
  return x === y ? 0 : x < y ? -1 : 1;
}

void test('Windows: the NuGet versions electron-winstaller makes keep the semver order in Squirrel.Windows', () => {
  const requireFromMaker = createRequire(createRequire(import.meta.url).resolve('@electron-forge/maker-squirrel'));
  const { convertVersion } = requireFromMaker('electron-winstaller') as { convertVersion: (version: string) => string };
  assert.equal(convertVersion('0.42.0-beta.10'), '0.42.0-beta10');
  assert.equal(convertVersion('0.42.0'), '0.42.0');
  const versions = ['0.41.0', '0.42.0-beta.1', '0.42.0-beta.2', '0.42.0-beta.9', '0.42.0-beta.10', '0.42.0-beta.11', '0.42.0-beta.99', '0.42.0-beta.100', '0.42.0-beta.999', '0.42.0', '0.42.1-beta.1', '0.42.1'];
  const nuget = versions.map((version) => {
    const converted = convertVersion(version);
    // Squirrel reads the version back from the package file name; it must survive the trip.
    assert.equal(squirrelVersionFromFileName(`gnosis-${converted}-full.nupkg`), converted);
    // And Gnosis reads Squirrel's version back as the semver one.
    assert.equal(normalizeReleaseVersion(converted), version);
    return converted;
  });
  for (let i = 0; i < nuget.length; i++) {
    for (let j = 0; j < nuget.length; j++) {
      assert.equal(Math.sign(squirrelCompare(nuget[i], nuget[j])), Math.sign(i - j), `${nuget[i]} vs ${nuget[j]}`);
    }
  }
});
