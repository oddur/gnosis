export interface GitHubProfile {
  login: string;
  name: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  type: string;
}
export function isGitHubLogin(login: string) {
  return /^[a-z\d](?:[a-z\d-]{0,38})(?:\[bot\])?$/i.test(login) && !['unknown', 'local'].includes(login.toLowerCase());
}
export function githubAvatarUrl(login: string) {
  return `https://github.com/${encodeURIComponent(login.replace(/\[bot\]$/i, ''))}.png?size=64`;
}
