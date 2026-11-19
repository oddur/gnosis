/**
 * Release-time guards (#404). Used by forge.config.ts; the Release workflow sets GNOSIS_RELEASE_KIND. See docs/releasing.md.
 * Imports only lib/version.ts: Forge loads this file before anything is built.
 */
import { isPrereleaseVersion, type ReleaseKind } from './version';

/**
 * Whether Forge publishes `version` as a GitHub prerelease. A version with a prerelease part always does.
 * The Release workflow sets `GNOSIS_RELEASE_KIND` from the tag it validated; a mismatch throws before anything is
 * published, so a pre-release tag can never become a normal release and a stable tag never a prerelease.
 */
export function publishAsPrerelease(version: string, expectedKind?: string): boolean {
  const kind: ReleaseKind = isPrereleaseVersion(version) ? 'prerelease' : 'stable';
  if (expectedKind && expectedKind !== kind) {
    throw new Error(`Release kind mismatch: the tag is ${expectedKind}, but package.json's version ${version} is ${kind}.`);
  }
  return kind === 'prerelease';
}
