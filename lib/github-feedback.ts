/** Keep provider diagnostics available without making them the primary UI message. */
export function githubFailureMessage(reason: string): string {
  if (/rate.?limit|too many requests/i.test(reason)) return 'GitHub’s API limit was reached. Try again later.';
  if (/bad credentials|requires authentication|401|token.*expired/i.test(reason))
    return 'GitHub authentication needs attention. Sign in again.';
  if (/forbidden|403|not found|404|access denied/i.test(reason))
    return 'GitHub could not grant access. Check your repository permissions.';
  if (/fetch failed|network|offline|ENOTFOUND|ETIMEDOUT/i.test(reason))
    return 'GitHub could not be reached. Check your connection and try again.';
  return 'GitHub could not confirm the latest state. Try again later.';
}
