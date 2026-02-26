import type { UpdateInfo } from './types';

interface GitHubRelease {
  tag_name: string;
  html_url: string;
}

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
    const headers: Record<string, string> = { 'User-Agent': 'Gnosis-App' };
    if (token) headers['Authorization'] = `token ${token}`;
    const res = await fetch('https://api.github.com/repos/oddur/gnosis/releases/latest', { headers });
    if (!res.ok) return null;

    const data = (await res.json()) as GitHubRelease;
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
