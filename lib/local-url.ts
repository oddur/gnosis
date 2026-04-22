// Tiny zero-dependency helper so renderer code can check for local-review
// URLs without pulling `lib/localGit.ts` (and its Node-only `util.promisify`
// / `child_process` imports) into the browser bundle graph.

export function isLocalUrl(url: string): boolean {
  return url.startsWith('local:');
}
