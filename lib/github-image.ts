/** Only these GitHub-owned image URLs may use the user's GitHub credential. */
export function isGitHubImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    if (url.hostname === 'github.com')
      return (
        /^\/user-attachments\/assets\/[\da-f-]+$/i.test(url.pathname) ||
        /^\/[^/]+\/[^/]+\/assets\/\d+\/[\da-f-]+$/i.test(url.pathname)
      );
    return (
      (url.hostname === 'raw.githubusercontent.com' && /^\/[^/]+\/[^/]+\/[^/]+\/.+/.test(url.pathname)) ||
      (url.hostname === 'private-user-images.githubusercontent.com' && url.pathname.length > 1)
    );
  } catch {
    return false;
  }
}
