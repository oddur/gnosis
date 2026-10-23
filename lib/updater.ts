import type { UpdateInfo } from './types';
import { getGitHubClient } from './github-client';

/** Compare two semver strings. Returns true if remote > local. */
function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

export async function checkForUpdate(currentVersion: string, token?: string): Promise<UpdateInfo | null> {
  try {
    const { data } = await getGitHubClient(token).repos.getLatestRelease({ owner: 'oddur', repo: 'gnosis' });
    const remoteVersion = data.tag_name.replace(/^v/, '');

    if (!isNewer(remoteVersion, currentVersion)) return null;

    return {
      version: remoteVersion,
      releaseUrl: data.html_url,
    };
  } catch {
    return null;
  }
}
