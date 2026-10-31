import type { CheckSelection, PrChecks } from './pr-checks';
import type { ReviewMember } from './workbench';

export interface WorkflowRerun {
  key: string;
  revision: string;
  target: CheckSelection;
  number: number;
  names: string[];
  mode: 'all' | 'failed';
}

/** Group jobs by workflow run, including cancelled jobs without rerunning a run twice. */
export function checkRerunPlan(members: ReviewMember[], values: Partial<Record<string, PrChecks>>) {
  const runs = new Map<string, WorkflowRerun & { running: boolean }>();
  for (const member of members) {
    const snapshot = values[member.url];
    if (!snapshot || snapshot.headSha !== member.headSha) continue;
    const pr = new URL(member.url);
    const repo = pr.pathname.split('/').slice(0, 3).join('/');
    for (const check of [...snapshot.checks].sort((a, b) => a.id.localeCompare(b.id))) {
      if (check.kind !== 'check' || !['github-actions', 'GitHub Actions'].includes(check.provider)) continue;
      let url: URL;
      try {
        url = new URL(check.url ?? '');
      } catch {
        continue;
      }
      const match = /^(.+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(url.pathname);
      if (url.origin !== pr.origin || !match || match[1].toLowerCase() !== repo.toLowerCase()) continue;
      const key = `${url.origin}${match[1]}/actions/runs/${match[2]}`;
      let entry = runs.get(key);
      if (!entry) {
        entry = {
          key,
          revision: snapshot.headSha,
          target: { url: member.url, headSha: snapshot.headSha, id: check.id },
          number: member.number,
          names: [],
          mode: 'failed',
          running: false,
        };
        runs.set(key, entry);
      }
      if (check.status !== 'completed') entry.running = true;
      if (
        check.status === 'completed' &&
        ['failure', 'timed_out', 'startup_failure', 'cancelled'].includes(check.conclusion ?? '')
      ) {
        entry.names.push(check.name);
        // Timestamps distinguish subsequent attempts without refreshing eligibility on every poll.
        entry.revision += `:${check.id}:${check.startedAt}:${check.completedAt}:${check.conclusion}`;
        entry.target.id = check.id;
        if (check.conclusion === 'cancelled') entry.mode = 'all';
      }
    }
  }
  return [...runs.values()].filter((run) => run.names.length && !run.running);
}
