import { watchGitHub } from '../lib/watch-github';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PrChangesView, rememberChangesFile } from './PrChangesView';
import { Button } from './ui/button';
import { BranchBadge, CommitBadge } from './EntityBadge';
import { SearchableSelect } from './SearchableSelect';
import { InspectionFailureNotice } from './InspectionFailureNotice';
import { useChangesComments } from './useChangesComments';
import { usePrDiscussions } from '../lib/use-pr-discussions';
import { inspectionFailure, type InspectionFailure } from '../lib/inspection-batch';
import { linearStack, stackMembershipChanged } from '../lib/stack-changes';
import { peekStackChanges, readStackChanges } from '../lib/stack-inspection-cache';
import type { PrChanges } from '../lib/pr-changes';
import type { ReviewSubject } from '../lib/workbench';
import type { Preferences } from '../lib/types';

type Mode = 'combined' | 'by-pr';
let rememberedMode: Mode | undefined;

/** The mode changes comparison scope, never the identity of a GitHub review. */
export function StackChangesView({
  subject,
  preferences,
  account,
  initialFile,
  onOpenPr,
}: {
  subject: ReviewSubject;
  preferences: Preferences;
  account: string;
  initialFile?: { url: string; path: string; line?: number; headSha?: string };
  onOpenPr: (url: string) => void;
}) {
  const [mode, setMode] = useState<Mode>(() =>
    initialFile ? 'by-pr' : (rememberedMode ?? preferences.stackChangesMode ?? 'combined')
  );
  const [snapshot, setSnapshot] = useState(() => peekStackChanges(account, subject));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InspectionFailure>();
  const [newer, setNewer] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [reviewUrl, setReviewUrl] = useState('');
  const controllers = useRef(new Set<AbortController>());
  const pendingLoad = useRef<{ refresh: boolean; background: boolean } | undefined>(undefined);
  const cancelLoads = () => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    pendingLoad.current = undefined;
  };
  const epoch = useRef(0);
  const selectedPath = useRef<string | undefined>(undefined);
  const writes = useRef(Promise.resolve());
  let reason = '';
  try {
    linearStack(subject);
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  const membershipChanged = !!snapshot && stackMembershipChanged(snapshot, subject);
  const members = snapshot?.stackComparison?.members ?? [];
  const discussion = usePrDiscussions(mode === 'combined' ? members.map((m) => m.metadata.url) : []);
  const selectedSource = members.find((m) => m.metadata.url === reviewUrl);
  const target: PrChanges | undefined = selectedSource && {
    version: 1,
    url: reviewUrl,
    metadata: selectedSource.metadata,
    comparisonBase: selectedSource.comparisonBase,
    files: [],
    fetchedAt: snapshot?.fetchedAt ?? 0,
  };
  const review = useChangesComments({
    enabled: mode === 'combined',
    snapshot: target,
    activeKey: `combined-review:${reviewUrl}`,
    inline: [],
    refresh: discussion.refresh,
    replaceThread: discussion.replace,
  });
  async function load(refresh: boolean, background = mode !== 'combined', promote = false) {
    if (reason) return;
    // Keep the original reader alive during promotion. The backend joins that
    // same operation and raises its priority without cancelling shared member reads.
    if (!promote) cancelLoads();
    const next = new AbortController();
    controllers.current.add(next);
    pendingLoad.current = { refresh, background };
    const sequence = ++epoch.current;
    setBusy(true);
    setFailure(undefined);
    try {
      const value = await readStackChanges(account, subject, refresh, background, next.signal);
      if (sequence !== epoch.current) return;
      setSnapshot(value);
      setReviewUrl('');
      setNewer(false);
      setCheckError('');
    } catch (e) {
      if (sequence === epoch.current && !next.signal.aborted)
        setFailure(inspectionFailure(subject.members[subject.members.length - 1].url, e));
    } finally {
      controllers.current.delete(next);
      if (sequence === epoch.current) {
        pendingLoad.current = undefined;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (!snapshot) void load(false);
    return () => {
      epoch.current++;
      cancelLoads();
    };
  }, [subject.id, account]);
  useEffect(() => {
    if (initialFile) setMode('by-pr');
  }, [initialFile]);
  useEffect(() => {
    if (!snapshot) return;
    let stopped = false;
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        for (const source of members) {
          const revision = await window.electronAPI.checkPrChanges(source.metadata.url);
          if (
            !stopped &&
            (revision.baseSha !== source.metadata.baseSha || revision.headSha !== source.metadata.headSha)
          )
            setNewer(true);
        }
        if (!stopped) setCheckError('');
      } catch {
        if (!stopped) setCheckError('Could not check for new commits. Showing the saved comparison.');
      }
    };
    const stop = watchGitHub({ kind: 'metadata', priority: 'active', targets: members.map(source => ({ url: source.metadata.url })) }, update => {
      if (update.kind !== 'metadata') return;
      const source = members.find(source => source.metadata.url === update.url);
      if (source && (update.value.headSha !== source.metadata.headSha || update.value.baseSha !== source.metadata.baseSha)) setNewer(true);
      setCheckError('');
    }, () => setCheckError('Could not check for new commits. Showing the saved version; retrying automatically.'));
    if (stop) return stop;
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [snapshot]);
  function choose(next: Mode) {
    if (next === 'combined' && mode !== 'combined') {
      const pending = pendingLoad.current;
      if (pending?.background) void load(pending.refresh, false, true);
      else if (!snapshot && !pending) void load(false, false);
    }
    setMode(next);
    rememberedMode = next;
    setSaveError('');
    writes.current = writes.current
      .catch(() => {})
      .then(async () => {
        const current = await window.electronAPI.loadPreferences();
        await window.electronAPI.savePreferences({ ...current, stackChangesMode: next });
      })
      .catch(() => setSaveError('Could not save your comparison preference. Your choice is kept for this session.'));
  }
  const openSource = (url: string, path: string) => {
    if (path) rememberChangesFile(url, path);
    onOpenPr(url);
  };
  const switcher = (
    <div className="stack-changes-switch" role="group" aria-label="Stack changes view">
      <Button
        size="sm"
        variant={mode === 'combined' ? 'secondary' : 'ghost'}
        aria-pressed={mode === 'combined'}
        onClick={() => choose('combined')}
      >
        Combined
      </Button>
      <Button
        size="sm"
        variant={mode === 'by-pr' ? 'secondary' : 'ghost'}
        aria-pressed={mode === 'by-pr'}
        onClick={() => choose('by-pr')}
      >
        By PR
      </Button>
    </div>
  );
  const toolbar = (
    <>
      {switcher}
      {mode === 'combined' && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Update combined changes"
          title="Update combined changes"
          disabled={busy || !!reason}
          onClick={() => void load(true)}
        >
          <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />
        </Button>
      )}
    </>
  );
  return (
    <div className="stack-changes-view">
      {saveError && (
        <p className="changes-notice" role="status">
          {saveError}
        </p>
      )}
      {mode === 'combined' && (
        <>
          {snapshot && (
            <div className="stack-comparison-context">
              <div className="stack-comparison-range" aria-label="Combined comparison boundaries">
                <span>Changes into</span>{' '}
                <BranchBadge branch={snapshot.metadata.baseBranch} repo={snapshot.metadata.baseRepo} />
                <span>through PR #{snapshot.url.split('/').pop()}</span>{' '}
                <CommitBadge sha={snapshot.metadata.headSha} repo={snapshot.metadata.headRepo} />
                <span
                  className="stack-comparison-ancestor"
                  title="Compared from the common ancestor with the target branch"
                >
                  from {snapshot.comparisonBase.slice(0, 7)}
                </span>
              </div>
              <SearchableSelect
                label="Source PR discussions and review"
                value={reviewUrl}
                triggerLabel={reviewUrl ? `PR #${reviewUrl.split('/').pop()}` : 'PR discussions & review…'}
                popupBoundary="viewport"
                options={members.map((m) => ({
                  value: m.metadata.url,
                  label: `#${m.metadata.url.split('/').pop()} · ${m.metadata.title}`,
                }))}
                onValueChange={setReviewUrl}
              />
              {target && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openSource(target.url, '')}>
                    Open PR & discussions
                  </Button>
                  {review.controls}
                </>
              )}
            </div>
          )}
          {review.panel}
          {reason && (
            <div className="changes-notice" role="status">
              <span>
                <strong>Combined changes {snapshot ? 'could not be updated' : 'unavailable'}.</strong>{' '}
                {reason || 'Retry below or review each PR separately.'}
                {snapshot && ' Showing the saved comparison.'}
              </span>
              <Button size="sm" variant="outline" onClick={() => choose('by-pr')}>
                Review by PR
              </Button>
            </div>
          )}
          {failure && (
            <InspectionFailureNotice
              label="combined changes"
              retryLabel="Retry comparison"
              githubUrl={
                snapshot
                  ? `https://github.com/${snapshot.metadata.baseRepo}/compare/${snapshot.comparisonBase}...${snapshot.metadata.headSha}`
                  : undefined
              }
              action={
                <Button size="sm" variant="outline" onClick={() => choose('by-pr')}>
                  Review by PR
                </Button>
              }
              failure={failure}
              saved={!!snapshot}
              kind="changes"
              busy={busy}
              retryDisabled={busy}
              retry={() => void load(true)}
            />
          )}
          {busy && (
            <div className="changes-notice" role="status">
              <span>
                {snapshot ? 'Updating combined changes…' : 'Preparing combined changes…'} You can review by PR while
                this loads.
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  epoch.current++;
                  cancelLoads();
                  setBusy(false);
                  setFailure({ url: subject.members[subject.members.length - 1].url, message: 'Loading was stopped.' });
                }}
              >
                Stop loading
              </Button>
            </div>
          )}
          {snapshot?.filesTruncated && (
            <div className="changes-notice" role="status">
              <span>
                <strong>Partial combined diff.</strong> Showing {snapshot.files.length} available files. GitHub’s
                comparison limit was reached; this may not include every change.
              </span>
              <Button size="sm" variant="outline" onClick={() => choose('by-pr')}>
                Review by PR
              </Button>
            </div>
          )}
          {(newer || membershipChanged) && (
            <div className="changes-notice" role="status">
              <span>
                {membershipChanged ? 'Stack membership has changed.' : 'New commits are available.'} Your current
                comparison is unchanged.
              </span>
              <Button size="sm" variant="outline" disabled={busy || !!reason} onClick={() => void load(true)}>
                Update changes
              </Button>
            </div>
          )}
          {checkError && (
            <p className="changes-notice" role="status">
              {checkError}
            </p>
          )}
        </>
      )}
      {mode === 'by-pr' ? (
        <PrChangesView
          key={`by-pr:${subject.id}`}
          subject={subject}
          preferences={preferences}
          toolbar={toolbar}
          initialFile={initialFile}
          preferredPath={selectedPath.current}
          onActiveFile={(path) => {
            selectedPath.current = path;
          }}
        />
      ) : snapshot ? (
        <PrChangesView
          key={`combined:${subject.id}`}
          subject={subject}
          preferences={preferences}
          toolbar={toolbar}
          combined={{ snapshot, onOpenSource: openSource }}
          preferredPath={selectedPath.current}
          onActiveFile={(path) => {
            selectedPath.current = path;
          }}
        />
      ) : (
        <>
          <div className="changes-toolbar">{toolbar}</div>
          <div className="changes-empty">
            <p>
              {busy
                ? 'Verifying the stack and loading its net changes…'
                : 'Choose By PR to inspect each change in the stack.'}
            </p>
            <Button variant="outline" onClick={() => choose('by-pr')}>
              Review by PR
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
