import { defaultUrlTransform } from 'react-markdown';

export interface GitHubMarkdownSource {
  repo: string;
  ref: string;
  /** Repository-relative file path; omitted for PR descriptions. */
  path?: string;
}

/** Resolve repository-relative content at the PR's revision, never the app's origin. */
export function githubMarkdownUrl(url: string, image: boolean, source: GitHubMarkdownSource): string {
  const safe = defaultUrlTransform(url);
  if (!safe || (image && /^(?:mailto:|#)/i.test(safe))) return '';
  if (/^https?:\/\//i.test(safe) || safe.startsWith('//')) {
    const absolute = safe.startsWith('//') ? `https:${safe}` : safe;
    let parsed: URL;
    try {
      parsed = new URL(absolute);
    } catch {
      return '';
    }
    if (image) {
      if (parsed.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/blob\//.test(parsed.pathname)) {
        parsed.hostname = 'raw.githubusercontent.com';
        parsed.pathname = parsed.pathname.replace(/^\/([^/]+\/[^/]+)\/blob\//, '/$1/');
        return parsed.href;
      }
    }
    return absolute;
  }
  if (safe.startsWith('#') || /^mailto:/i.test(safe)) return image ? '' : safe;
  if (/^[a-z][a-z\d+.-]*:/i.test(safe)) return '';
  if (safe.startsWith('/user-attachments/')) return `https://github.com${safe}`;
  const base = image
    ? `https://raw.githubusercontent.com/${source.repo}/${encodeURIComponent(source.ref)}/`
    : `https://github.com/${source.repo}/blob/${encodeURIComponent(source.ref)}/`;
  const directory = source.path?.split('/').slice(0, -1).map(encodeURIComponent).join('/');
  return new URL(safe.replace(/^\//, ''), base + (!safe.startsWith('/') && directory ? directory + '/' : '')).href;
}
