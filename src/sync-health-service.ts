import type { Octokit } from '@octokit/rest';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import type { StateStorage } from './app-data-store';
import { createDriftDetector } from './drift-detector';
import { withGitHubPriority } from '../lib/github-scheduler';
import { ATTENTION_SIGNALS_MAX_AGE, isOwnPr, memberAttention } from '../lib/attention';
import { GROUND_TRUTH_SELECTION, groundTruthFrom, type GnosisView, type GroundTruthPull } from '../lib/sync-health';
import { createRefreshThrottle } from '../lib/focus-refresh';
import { prCommentTotal, type QueueSignals } from '../lib/queue-signals';
import type { PrMetadata, PrStatus } from '../lib/types';
import type { GitHubReviewThreads } from '../lib/review-threads';

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/;
const prUrls = (value: unknown, limit: number) =>
  Array.isArray(value) && value.length <= limit && value.every((url) => typeof url === 'string' && PR_URL.test(url))
    ? (value as string[])
    : undefined;

export interface SyncHealthDeps {
  storage: StateStorage;
  token: () => string | null;
  login: () => string | null;
  client: (token: string) => Octokit;
  /** A window or the menu bar panel is visible, the system is awake and online. */
  syncActive: () => boolean;
  /** A rate-limit pause for GraphQL. `background` also honours the automatic reserve. */
  blocked: (token: string, background: boolean) => boolean;
  automaticUsage: (token: string) => { spent: number; limit: number };
  queueUrls: () => string[];
  /** The queue, star or tab copy of the PR, whichever GitHub updated last. */
  member: (url: string) => PrMetadata | undefined;
  signals: (client: Octokit, url: string, headSha: string) => QueueSignals | undefined;
  status: (client: Octokit, url: string, headSha: string) => Promise<PrStatus | undefined>;
  threads: (client: Octokit, url: string) => GitHubReviewThreads | undefined;
  /** Read these PRs' watched metadata and signals now, unless they were read within 30 s. */
  refreshOpen: (urls: string[]) => void;
  /** The reader switched to a queue view: its first screenful of rows. Main skips rows read within 30 s. */
  refreshRows?: (urls: string[]) => void;
  notify: () => void;
  appInfo: () => Record<string, unknown>;
  now?: () => number;
}

/** Drift detector, diagnostics export and the open PR's refresh on focus. Registers its IPC handlers. */
export function createSyncHealthService(deps: SyncHealthDeps) {
  const now = deps.now ?? Date.now;
  async function view(url: string): Promise<GnosisView | undefined> {
    const token = deps.token();
    const member = deps.member(url);
    if (!token || !member) return;
    const client = deps.client(token);
    const login = deps.login();
    const signals = deps.signals(client, url, member.headSha);
    const status = await deps.status(client, url, member.headSha).catch(() => undefined);
    const threads = deps.threads(client, url);
    const open = member.state === 'open' && !member.merged;
    // Needs-you status kinds use signals at most 30 minutes old; older ones are not shown, so they are not compared.
    const attention =
      login && open && signals && isOwnPr(member, login) && now() - signals.checkedAt <= ATTENTION_SIGNALS_MAX_AGE
        ? memberAttention({ ...member, role: undefined }, signals, login)
        : undefined;
    // The comment badge's own rule: signals for this head, else the REST counts.
    const comments = signals ? undefined : prCommentTotal(member);
    return {
      url,
      member: {
        updatedAt: member.updatedAt,
        state: member.merged ? 'merged' : member.state,
        isDraft: member.isDraft,
        headSha: member.headSha,
        ...(comments !== undefined ? { comments } : {}),
      },
      ...(signals
        ? {
            signals: {
              checkedAt: signals.checkedAt,
              headSha: signals.headSha,
              ...(signals.readiness
                ? { reviewDecision: signals.readiness.reviewDecision, mergeState: signals.readiness.mergeState }
                : {}),
              checks: signals.checks.state,
              comments: prCommentTotal(member, signals) ?? signals.comments,
            },
          }
        : {}),
      ...(attention && signals
        ? {
            attention: {
              checkedAt: signals.checkedAt,
              headSha: signals.headSha,
              checksFailed: !!attention['checks-failed'],
              changesRequested: !!attention['changes-requested'],
            },
          }
        : {}),
      ...(status?.checkedAt && !status.stale
        ? {
            status: {
              checkedAt: status.checkedAt,
              headSha: status.headSha ?? member.headSha,
              approvals: status.reviewSummary.approved,
              changesRequested: status.reviewSummary.changesRequested,
            },
          }
        : {}),
      ...(threads?.checkedAt !== undefined && !threads.stale
        ? {
            threads: {
              checkedAt: threads.checkedAt,
              unresolved: threads.threads.filter((thread) => !thread.isResolved).length,
            },
          }
        : {}),
    };
  }
  async function read(url: string, trigger: 'background' | 'manual') {
    const token = deps.token();
    if (!token) throw new Error('Not signed in to GitHub.');
    const [, owner, name, number] = PR_URL.exec(url) ?? [];
    if (!owner) throw new Error('Not a GitHub PR.');
    const client = deps.client(token);
    const query = `query($owner:String!,$name:String!,$number:Int!) { rateLimit { cost } repository(owner:$owner,name:$name) { pullRequest(number:$number) { ${GROUND_TRUTH_SELECTION} } } }`;
    type Data = { rateLimit?: { cost?: number } | null; repository: { pullRequest: GroundTruthPull | null } | null };
    const run = async () => {
      try {
        return await client.graphql<Data>(query, { owner, name, number: Number(number) });
      } catch (error) {
        // Without Actions access GitHub cannot list workflow runs. The rest of the answer still stands.
        const partial = error as { data?: Data; errors?: { path?: (string | number)[] }[] };
        if (!partial.data || !partial.errors?.length || partial.errors.some((e) => !e.path?.includes('workflowRun')))
          throw error;
        return partial.data;
      }
    };
    // Background samples are the lowest tier and count against the automatic allowance; Check now is the user's.
    const data =
      trigger === 'background'
        ? await withGitHubPriority('background', run, { automatic: true })
        : await withGitHubPriority('foreground', run, { automatic: false });
    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error('GitHub did not return this PR.');
    return { truth: groundTruthFrom(url, pr, now()), cost: data.rateLimit?.cost ?? 1 };
  }
  const detector = createDriftDetector({
    storage: deps.storage,
    now,
    active: () => {
      const token = deps.token();
      if (!token || !deps.syncActive() || deps.blocked(token, true)) return false;
      // Lowest priority: half of the automatic GraphQL allowance stays for sync, as for queue preloading.
      const usage = deps.automaticUsage(token);
      return usage.spent < 0.5 * usage.limit;
    },
    available: () => {
      const token = deps.token();
      return !!token && !deps.blocked(token, false);
    },
    queue: deps.queueUrls,
    view,
    read,
    changed: deps.notify,
  });
  const focusThrottle = createRefreshThrottle(undefined, now);
  function report() {
    const token = deps.token();
    const state = detector.state();
    return {
      kind: 'gnosis-diagnostics',
      version: 1,
      generatedAt: new Date(now()).toISOString(),
      app: deps.appInfo(),
      github: token
        ? { signedIn: true, syncActive: deps.syncActive(), automaticGraphQL: deps.automaticUsage(token) }
        : { signedIn: false },
      syncHealth: {
        enabled: state.enabled,
        drifts: state.drifts,
        stale: state.stale,
        runs: state.runs,
        unconfirmed: state.suspects,
      },
    };
  }
  function register() {
    ipcMain.handle('sync-health', () => detector.snapshot());
    ipcMain.handle('sync-health-check-now', (_event, raw: unknown) => detector.checkNow(prUrls(raw ?? [], 3) ?? []));
    ipcMain.handle('sync-health-enabled', (_event, enabled: unknown) => detector.setEnabled(enabled === true));
    ipcMain.handle('sync-health-clear', () => detector.clear());
    ipcMain.handle('diagnostics-report', () => report());
    ipcMain.handle('export-diagnostics', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const stamp = new Date(now()).toISOString().slice(0, 10);
      const options = {
        title: 'Export diagnostics',
        defaultPath: `gnosis-diagnostics-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      };
      const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (chosen.canceled || !chosen.filePath) return null;
      fs.writeFileSync(chosen.filePath, JSON.stringify(report(), null, 2));
      return chosen.filePath;
    });
    // The reader switched to a PR tab or returned to Gnosis with one open.
    ipcMain.on('refresh-open-pr', (_event, raw: unknown) => {
      const urls = prUrls(raw, 10);
      if (!urls?.length || !deps.token()) return;
      for (const url of urls) detector.noteSeen(url);
      const due = focusThrottle.take(urls);
      if (due.length) deps.refreshOpen(due);
    });
    // The reader switched to a saved view or sidebar section: its first screenful of rows, at most 15 PRs.
    ipcMain.on('refresh-queue-rows', (_event, raw: unknown) => {
      const urls = prUrls(raw, 15);
      if (urls?.length && deps.token()) deps.refreshRows?.(urls);
    });
  }
  return {
    register,
    tick: () => void detector.tick(),
    noteSeen: (url: string) => detector.noteSeen(url),
    report,
    detector,
  };
}
