import { useEffect, useState, type ComponentProps } from 'react';
import { CodeView } from '@pierre/diffs/react';
import { GitBranch, CheckCircle2 } from 'lucide-react';
import { Button } from './ui/button';
import { BranchBadge, PrBadge } from './EntityBadge';
import { hasConflictMarkers, type ConflictSession } from '../lib/conflict-resolution';

export function RestackReview({
  session,
  busy,
  onPrepare,
  onPublish,
  onContinue,
  onSave,
  onDrafts,
  options,
}: {
  session: ConflictSession;
  busy: boolean;
  onPrepare: () => void;
  onPublish: (token: string, reviewed: string[]) => void;
  onContinue: () => void;
  onSave: (path: string, contents: string, resolved: boolean) => void;
  onDrafts: (drafts: Record<string, string>) => void;
  options: ComponentProps<typeof CodeView>['options'];
}) {
  const plan = session.restack;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    setDrafts({});
    onDrafts({});
  }, [session.version]);
  const [review, setReview] = useState<{ token: string; urls: string[] }>({ token: '', urls: [] });
  const reviewed = review.token === plan?.token ? review.urls : [];
  const published = plan?.status === 'published';
  const count = session.dependents?.length ?? 0;
  return (
    <section className="restack-review" aria-label="Restack dependent PRs">
      <header>
        {published ? <CheckCircle2 size={22} /> : <GitBranch size={22} />}
        <div>
          <h2>
            {published
              ? 'Dependent PRs updated'
              : plan?.status === 'blocked'
                ? 'Restack paused for your input'
                : plan
                  ? 'Review dependent PR updates'
                  : 'Update the PRs above this one'}
          </h2>
          <p>
            {published
              ? 'All prepared branches were pushed together. GitHub will run checks for their new commits.'
              : plan
                ? 'No dependent branches have been pushed. Review the prepared updates before publishing them together.'
                : `Rebase ${count} dependent ${count === 1 ? 'PR' : 'PRs'} in order onto the resolved branch. Matching saved resolutions are reused. Preparation does not push anything.`}
          </p>
        </div>
      </header>
      <div className="restack-body">
        {!plan && (
          <Button disabled={busy || !count} onClick={onPrepare}>
            {busy ? 'Preparing restack…' : `Prepare restack · ${count} PRs`}
          </Button>
        )}
        {plan?.blocked && (
          <div className="restack-blocked" role="status">
            <h3>New resolution needed · #{plan.blocked.url.split('/').pop()}</h3>
            <p>{plan.blocked.reason}</p>
            {plan.blocked.files.map((file) => {
              const value = drafts[file.path] ?? file.result;
              const dirty = value !== file.result;
              return (
                <div className="restack-conflict-file" key={file.path}>
                  <h4>
                    {file.path}{' '}
                    <span>
                      {file.unsupported
                        ? 'Needs a local Git tool'
                        : file.resolved && !dirty
                          ? 'Reviewed'
                          : hasConflictMarkers(value)
                            ? 'Conflicted'
                            : 'Resolved · Needs review'}
                    </span>
                  </h4>
                  {file.unsupported ? (
                    <p role="alert">{file.unsupported}</p>
                  ) : (
                    <>
                      <details>
                        <summary>Compare both versions</summary>
                        <div className="restack-versions">
                          <section>
                            <h5>Updated parent</h5>
                            <pre>{file.ours}</pre>
                          </section>
                          <section>
                            <h5>This PR’s commit</h5>
                            <pre>{file.theirs}</pre>
                          </section>
                        </div>
                      </details>
                      <label>
                        Resolved file contents
                        <textarea
                          aria-label={`Resolution for ${file.path}`}
                          value={value}
                          disabled={busy}
                          spellCheck={false}
                          onChange={(event) => {
                            const next = { ...drafts, [file.path]: event.target.value };
                            setDrafts(next);
                            onDrafts(next);
                          }}
                        />
                      </label>
                      <Button
                        variant="outline"
                        disabled={busy || !dirty}
                        onClick={() => onSave(file.path, value, false)}
                      >
                        Save draft
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy || hasConflictMarkers(value) || (file.resolved && !dirty)}
                        onClick={() => onSave(file.path, value, true)}
                      >
                        Save &amp; mark reviewed
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
            <Button
              disabled={
                busy ||
                plan.blocked.files.some(
                  (file) =>
                    !file.resolved ||
                    file.unsupported ||
                    (Object.hasOwn(drafts, file.path) && drafts[file.path] !== file.result)
                )
              }
              onClick={onContinue}
            >
              Continue restack
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onPrepare}>
              Prepare again
            </Button>
          </div>
        )}
        {plan && !published && !!plan.branches.length && (
          <p className="restack-instructions">
            Review each branch update below. Rebasing changes commit IDs and can dismiss GitHub approvals. Tests have
            not been run locally.
          </p>
        )}
        {plan?.branches.map((branch, index) => (
          <details className="restack-branch" key={branch.url} open={index === 0 ? true : undefined}>
            <summary>
              <PrBadge url={branch.url} number={Number(branch.url.split('/').pop())} title={branch.title} />{' '}
              {branch.title}
            </summary>
            <p>
              <BranchBadge branch={branch.branch} repo={branch.repo} /> onto{' '}
              <BranchBadge branch={branch.baseBranch} repo={branch.baseRepo} /> · {branch.commits} original{' '}
              {branch.commits === 1 ? 'commit' : 'commits'}
              {branch.reused
                ? ` · ${branch.reused} remembered file ${branch.reused === 1 ? 'resolution' : 'resolutions'} reused`
                : ''}
            </p>
            <p className="restack-revisions">
              <code>{branch.oldSha.slice(0, 7)}</code> → <code>{branch.newSha.slice(0, 7)}</code>
            </p>
            {!published &&
              (branch.files.length ? (
                <CodeView
                  className="restack-diff selectable"
                  items={branch.files.map((fileDiff, i) => ({
                    id: `${branch.url}:${i}`,
                    type: 'diff' as const,
                    fileDiff,
                  }))}
                  options={options}
                  style={{
                    height: Math.min(
                      360,
                      Math.max(
                        100,
                        branch.files.reduce(
                          (height, file) =>
                            height +
                            60 +
                            file.hunks.reduce(
                              (lines, hunk) => lines + Math.max(hunk.additionCount, hunk.deletionCount) + 1,
                              0
                            ) *
                              20,
                          0
                        )
                      )
                    ),
                    overflow: 'auto',
                  }}
                />
              ) : (
                <p>File contents are unchanged. Only commit ancestry changes.</p>
              ))}
            {plan.status === 'prepared' && (
              <label className="restack-reviewed">
                <input
                  type="checkbox"
                  checked={reviewed.includes(branch.url)}
                  disabled={busy}
                  onChange={(event) =>
                    setReview({
                      token: plan.token,
                      urls: event.target.checked
                        ? [...reviewed, branch.url]
                        : reviewed.filter((url) => url !== branch.url),
                    })
                  }
                />
                Reviewed this PR update
              </label>
            )}
          </details>
        ))}
      </div>
      {plan?.status === 'prepared' && (
        <footer>
          <span>
            {reviewed.length} of {plan.branches.length} PR updates reviewed · Nothing pushed yet
          </span>
          <Button variant="outline" disabled={busy} onClick={onPrepare}>
            Prepare again
          </Button>
          <Button
            disabled={busy || reviewed.length !== plan.branches.length}
            onClick={() => onPublish(plan.token, reviewed)}
          >
            {busy ? 'Updating branches…' : `Push ${plan.branches.length} PR updates`}
          </Button>
        </footer>
      )}
    </section>
  );
}
