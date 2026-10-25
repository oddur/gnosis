import fs from 'node:fs';
import path from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { ActivityService } from './activity-service';
import { PrMergeFailure } from './pr-actions-service';
import { githubRateLimit } from '../lib/github-client';
import { withGitHubPriority } from '../lib/github-scheduler';
import type { PrActionResult } from '../lib/pr-actions';
interface PendingMerge {
  account: string;
  title: string;
  operation: NonNullable<PrActionResult['operation']>;
  createdAt: number;
}
/** Only polls accepted requests. Restarting the app can never resubmit a merge. */
export function createPrMergeMonitor(deps: {
  directory: () => string;
  auth: () => { login: string | null | undefined; client: Octokit | null };
  activity: ActivityService;
  poll: (client: Octokit, operation: PendingMerge['operation']) => Promise<PrActionResult>;
  changed: (client: Octokit, urls: string[]) => Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now,
    active = new Set<string>(),
    due = new Map<string, number>(),
    shown = new Set<string>();
  let pending: PendingMerge[] | undefined;
  const id = (entry: PendingMerge) => `pr-action:merge:${entry.account}:${entry.operation.uuid}`;
  const file = () => path.join(deps.directory(), 'pending-pr-merges.json');
  function load() {
    if (pending) return pending;
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'));
      pending = Array.isArray(data)
        ? data.filter(
            (entry: Partial<PendingMerge> | null): entry is PendingMerge =>
              !!entry &&
              typeof entry.account === 'string' &&
              typeof entry.title === 'string' &&
              Number.isFinite(entry.createdAt) &&
              !!entry.operation &&
              typeof entry.operation.url === 'string' &&
              typeof entry.operation.uuid === 'string' &&
              Array.isArray(entry.operation.members) &&
              entry.operation.members.every((url) => typeof url === 'string')
          )
        : [];
    } catch {
      pending = [];
    }
    return pending;
  }
  function save() {
    fs.mkdirSync(deps.directory(), { recursive: true });
    fs.writeFileSync(file() + '.tmp', JSON.stringify(load()), { mode: 0o600 });
    fs.renameSync(file() + '.tmp', file());
  }
  function show(entry: PendingMerge) {
    const key = id(entry);
    if (shown.has(key)) return;
    shown.add(key);
    deps.activity.start(
      {
        id: key,
        kind: 'pr-action',
        account: entry.account,
        title: entry.title,
        detail: 'GitHub is processing the merge.',
      },
      {}
    );
  }
  async function check(entry: PendingMerge, client: Octokit) {
    const key = id(entry);
    active.add(key);
    try {
      if (now() - entry.createdAt > 24 * 60 * 60_000)
        throw new PrMergeFailure(
          'The merge request has expired. Check the PR on GitHub before submitting another request.'
        );
      const result = await withGitHubPriority('foreground', () => deps.poll(client, entry.operation));
      if (result.status === 'pending') {
        due.set(key, now() + 5000);
        deps.activity.start(
          {
            id: key,
            kind: 'pr-action',
            account: entry.account,
            title: entry.title,
            detail: 'GitHub is processing the merge.',
          },
          {}
        );
        return;
      }
      // Surface the successful write even if local metadata refresh fails.
      try {
        await deps.changed(client, entry.operation.members);
      } catch {
        /* Next queue sync reconciles metadata. */
      }
      deps.activity.finish(key, 'completed', result.message);
      pending = load().filter((p) => id(p) !== key);
      try {
        save();
      } catch {
        /* A stale persisted entry is safe: restarting only polls its UUID. */
      }
    } catch (error) {
      if (error instanceof PrMergeFailure || (error as { status?: number }).status === 404) {
        deps.activity.finish(
          key,
          'failed',
          error instanceof PrMergeFailure
            ? error.message
            : 'The merge result is no longer available. Check the PR on GitHub.'
        );
        pending = load().filter((p) => id(p) !== key);
        try {
          save();
        } catch {
          /* Retaining a completed UUID never resubmits a write. */
        }
      } else {
        const limit = githubRateLimit(error, now());
        due.set(key, Math.max(now() + 30_000, limit?.retryAt ?? 0));
        deps.activity.pause(
          key,
          limit
            ? `${limit.message} The merge was already submitted; only status checks will resume.`
            : 'Cannot check the submitted merge yet. Status checks will retry; the merge will not be resubmitted.'
        );
      }
    } finally {
      active.delete(key);
    }
  }
  return {
    track(account: string, title: string, operation: PendingMerge['operation']) {
      const entry = { account, title, operation, createdAt: now() };
      if (!load().some((p) => id(p) === id(entry))) load().push(entry);
      show(entry);
      save();
    },
    tick() {
      const { login, client } = deps.auth();
      if (!login || !client) return;
      for (const entry of load()) {
        if (entry.account !== login) continue;
        show(entry);
        const key = id(entry);
        if (!active.has(key) && (due.get(key) ?? 0) <= now()) void check(entry, client);
      }
    },
  };
}
