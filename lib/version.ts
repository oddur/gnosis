/**
 * Gnosis version numbers and release tags (#404).
 *
 * Versions follow semver 2.0.0 precedence: the numeric core first, then a version without a prerelease part beats
 * one with it, then prerelease identifiers left to right, numeric identifiers compared as numbers and before
 * alphanumeric ones. So `0.42.0-beta.2 < 0.42.0-beta.10 < 0.42.0 < 0.42.1-beta.1`. Build metadata (`+…`) is ignored.
 *
 * Release tags have two forms, documented in docs/releasing.md:
 * - stable: `vX.Y.Z`
 * - pre-release: `vX.Y.Z-beta.N`, N from 1 to 999, published as a GitHub prerelease.
 * The Release workflow checks the same patterns; tests/version.test.ts keeps them in step.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers; numeric ones are numbers. Empty for a stable version. */
  prerelease: (string | number)[];
}

const NUMERIC = /^(0|[1-9]\d*)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parses `1.2.3`, `v1.2.3`, `1.2.3-beta.4` and `1.2.3-beta.4+build`. Returns null for anything else. */
export function parseVersion(input: string | null | undefined): ParsedVersion | null {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/^v/, '').split('+')[0];
  const dash = text.indexOf('-');
  const core = dash === -1 ? text : text.slice(0, dash);
  const match = CORE.exec(core);
  if (!match) return null;
  const prerelease: (string | number)[] = [];
  if (dash !== -1) {
    const parts = text.slice(dash + 1).split('.');
    for (const part of parts) {
      if (!IDENTIFIER.test(part)) return null;
      if (/^\d+$/.test(part)) {
        // Semver forbids leading zeros in numeric identifiers.
        if (!NUMERIC.test(part)) return null;
        prerelease.push(Number(part));
      } else {
        prerelease.push(part);
      }
    }
  }
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease };
}

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  // Numeric identifiers have lower precedence than alphanumeric ones.
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const order = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (order) return order;
  }
  return 0;
}

/** Semver precedence: negative when `a < b`, 0 when equal, positive when `a > b`. Null when either does not parse. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left && right ? compareParsed(left, right) : null;
}

/** True when `a` is strictly newer than `b`. False when either does not parse: never update to something unknown. */
export function isNewerVersion(a: string, b: string): boolean {
  return (compareVersions(a, b) ?? 0) > 0;
}

/** True for a version with a prerelease part, such as `0.42.0-beta.2`. */
export function isPrereleaseVersion(version: string | null | undefined): boolean {
  return (parseVersion(version)?.prerelease.length ?? 0) > 0;
}

/**
 * A version as Gnosis writes it, from a tag (`v0.42.0-beta.2`), a release name (`Gnosis 0.42.0-beta.2`) or the
 * NuGet version Squirrel.Windows reports (`0.42.0-beta2`: electron-winstaller drops the dots in a prerelease part).
 */
export function normalizeReleaseVersion(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text);
  const version = match ? match[1] : text.replace(/^v/, '');
  // Squirrel.Windows: 0.42.0-beta10 → 0.42.0-beta.10.
  return version.replace(/^(\d+\.\d+\.\d+-[A-Za-z]+)(\d+)$/, '$1.$2');
}

export type ReleaseKind = 'stable' | 'prerelease';

/** Stable release tags. The Release workflow's "Validate release tag" step uses the same pattern. */
export const STABLE_TAG_PATTERN = '^v[0-9]+\\.[0-9]+\\.[0-9]+$';
/** Pre-release tags: `vX.Y.Z-beta.N` with N from 1 to 999. The Release workflow uses the same pattern. */
export const PRERELEASE_TAG_PATTERN = '^v[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[1-9][0-9]{0,2}$';

/** Which kind of release a tag publishes, or null when the Release workflow would reject it. */
export function releaseTagKind(tag: string): ReleaseKind | null {
  if (new RegExp(STABLE_TAG_PATTERN).test(tag)) return 'stable';
  if (new RegExp(PRERELEASE_TAG_PATTERN).test(tag)) return 'prerelease';
  return null;
}
