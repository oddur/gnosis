export interface Release {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}
export const releasesUrl = 'https://github.com/oddur/gnosis/releases';
let request: Promise<{ releases: Release[]; unavailable: boolean }> | undefined;
export function getReleases() {
  return (request ??= (async () => {
    try {
      const headers: Record<string, string> = { 'User-Agent': 'gnosis-site', Accept: 'application/vnd.github+json' };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const response = await fetch('https://api.github.com/repos/oddur/gnosis/releases?per_page=20', {
        headers,
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const data = (await response.json()) as Release[];
      return { releases: data.filter((release) => !release.draft), unavailable: false };
    } catch {
      return { releases: [], unavailable: true };
    }
  })());
}
