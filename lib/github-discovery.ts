import type { Octokit } from '@octokit/rest';
import type { PrLabel, PrSearchResult } from './types';
import { parseGitHubLabels } from './github-labels';

// Keep only the fields needed for queue discovery and stack matching. Raw GitHub
// list responses repeat large repository/user payloads for every PR.
export interface ListedPull {
  html_url: string;
  updated_at: string;
  // Optional so discovery checkpoints written before label support still load.
  labelDetails?: PrLabel[];
  user: { login: string } | null;
  base: { ref: string; sha: string; repo: { full_name: string; default_branch?: string } };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}
interface SearchWindow {
  from: number;
  to: number;
  page: number;
}
export interface DiscoveryListings {
  updatedSince?: string;
  searches: Partial<
    Record<'author' | 'assignee' | 'review-requested', { windows: SearchWindow[]; items: PrSearchResult[] }>
  >;
  repos: Record<string, { page: number; done: boolean; items: ListedPull[]; archived?: boolean }>;
}
export function createDiscoveryListings(
  client: Octokit,
  state: DiscoveryListings,
  options: {
    login: string;
    now: number;
    includeAssigned?: boolean;
    updatedSince?: string;
    beforeRead: () => void;
    save: () => void;
    progress: (detail: string) => void;
  }
) {
  state.updatedSince ??= options.updatedSince;
  return {
    async personal(): Promise<PrSearchResult[]> {
      const seen = new Map<string, PrSearchResult>();
      const roles = options.includeAssigned
        ? (['author', 'assignee', 'review-requested'] as const)
        : (['author', 'review-requested'] as const);
      for (const role of roles) {
        const search = (state.searches[role] ??= {
          windows: [{ from: 0, to: Math.floor(options.now / 1000), page: 1 }],
          items: [],
        });
        while (search.windows.length) {
          const window = search.windows[0];
          const date = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
          options.beforeRead();
          options.progress(`Finding your pull requests (${role}, page ${window.page})`);
          const { data } = await client.search.issuesAndPullRequests({
            q: `is:pr is:open archived:false ${role}:${options.login}${state.updatedSince ? ` updated:>=${state.updatedSince}` : ''} created:${date(window.from)}..${date(window.to)}`,
            sort: 'created',
            order: 'asc',
            per_page: 100,
            page: window.page,
          });
          if (data.incomplete_results)
            throw new Error('GitHub returned an incomplete search. Retry to continue from the last complete page.');
          // GitHub exposes only 1,000 results per search. Split creation-time
          // windows instead of silently treating that server limit as the end.
          if (data.total_count > 1000) {
            if (window.from === window.to)
              throw new Error(
                'GitHub search has over 1,000 PRs created in one second. This search cannot be completed.'
              );
            const middle = Math.floor((window.from + window.to) / 2);
            search.windows.splice(
              0,
              1,
              { from: window.from, to: middle, page: 1 },
              { from: middle + 1, to: window.to, page: 1 }
            );
            options.save();
            continue;
          }
          for (const item of data.items) {
            const parts = item.repository_url.split('/');
            search.items.push({
              number: item.number,
              title: item.title,
              url: item.html_url,
              repoOwner: parts.at(-2) ?? '',
              repoName: parts.at(-1) ?? '',
              author: item.user?.login ?? 'unknown',
              updatedAt: item.updated_at,
              isDraft: item.draft ?? false,
              role: role === 'assignee' ? 'assigned' : role,
            });
          }
          if (data.items.length < 100 || window.page * 100 >= data.total_count) search.windows.shift();
          else window.page++;
          options.save();
        }
        // Process review requests last so that role wins duplicate URLs.
        for (const item of search.items) seen.set(item.url, item);
      }
      return [...seen.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
    async repository(fullName: string): Promise<{ data: ListedPull[]; archived?: boolean }> {
      const listing: DiscoveryListings['repos'][string] = (state.repos[fullName] ??= { page: 1, done: false, items: [] });
      const [owner, repo] = fullName.split('/');
      while (!listing.done) {
        options.beforeRead();
        options.progress(`Checking ${fullName} (page ${listing.page})`);
        const { data } = await client.pulls.list({
          owner,
          repo,
          state: 'open',
          per_page: 100,
          sort: 'created',
          direction: 'asc',
          page: listing.page,
        });
        // A list response already carries the target repository's archive state.
        // Stop here instead of fetching every PR or adding a repository lookup.
        if (data.length) listing.archived = data[0].base.repo.archived;
        if (listing.archived) {
          listing.items = [];
          listing.done = true;
          options.save();
          break;
        }
        for (const pr of data)
          listing.items.push({
            html_url: pr.html_url,
            updated_at: pr.updated_at,
            labelDetails: parseGitHubLabels(pr.labels),
            user: pr.user ? { login: pr.user.login } : null,
            base: {
              ref: pr.base.ref,
              sha: pr.base.sha,
              repo: { full_name: pr.base.repo.full_name, default_branch: pr.base.repo.default_branch },
            },
            head: {
              ref: pr.head.ref,
              sha: pr.head.sha,
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- deleted forks can be null
              repo: pr.head.repo ? { full_name: pr.head.repo.full_name } : null,
            },
          });
        listing.page++;
        listing.done = data.length < 100;
        options.save();
      }
      return { data: [...new Map(listing.items.map((pr) => [pr.html_url, pr])).values()], archived: listing.archived };
    },
  };
}
