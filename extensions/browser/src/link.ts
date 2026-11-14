// The extension holds no URL grammar. The Gnosis app parses GitHub page URLs (design 3.4, `lib/deep-link.ts`);
// the extension only hands it the page URL as it is, read at click time.

export const DEFAULT_SCHEME = 'gnosis';

/** Longest link the extension sends before it drops the query (design section 9, "Length"). */
export const MAX_LINK_LENGTH = 4096;

/** The only query parameters the app reads from a GitHub URL. Everything else is ignored by the app. */
const KEPT_QUERY_PARAMETERS = ['pr', 'check_run_id'];

function linkFor(pageUrl: string, scheme: string): string {
  return `${scheme}://open?url=${encodeURIComponent(pageUrl)}`;
}

/**
 * Builds `gnosis://open?url=<encoded page URL>`. When the link would pass {@link MAX_LINK_LENGTH}, the query
 * is dropped except `pr` and `check_run_id`, then (if still too long) the fragment.
 */
export function buildGnosisLink(pageUrl: string, scheme: string = DEFAULT_SCHEME): string {
  const full = linkFor(pageUrl, scheme);
  if (full.length <= MAX_LINK_LENGTH) return full;

  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return full;
  }
  const kept = new URLSearchParams();
  for (const name of KEPT_QUERY_PARAMETERS) {
    const value = parsed.searchParams.get(name);
    if (value !== null) kept.set(name, value);
  }
  const query = kept.size > 0 ? `?${kept.toString()}` : '';
  const base = `${parsed.origin}${parsed.pathname}${query}`;
  const withHash = linkFor(`${base}${parsed.hash}`, scheme);
  if (withHash.length <= MAX_LINK_LENGTH) return withHash;
  return linkFor(base, scheme);
}

const PULL_NUMBER = /^\d+$/;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/**
 * A coarse test for pages that get the button: pull requests (any tab), commits and compare views on
 * github.com. It may be looser than the app's grammar; the app rejects what it cannot map.
 */
export function isSupportedPage(pageUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '') return false;
  if (url.username !== '' || url.password !== '') return false;
  const [owner, repo, kind, id] = url.pathname.split('/').filter((part) => part !== '');
  if (!owner || !repo || !kind || !id) return false;
  switch (kind) {
    case 'pull':
      return PULL_NUMBER.test(id);
    case 'commit':
      return COMMIT_SHA.test(id);
    case 'compare':
      return true;
    default:
      return false;
  }
}
