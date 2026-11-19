import { Fragment, useLayoutEffect, useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { DiffFileHeader } from './DiffFileHeader';
import { ReviewDiff } from './ReviewDiff';
import { PrFileInspection, type ChangeFileEntry } from './PrFileInspection';
import { PrFileChat } from './PrFileChat';
import { inspectionData } from '../lib/inspection-cache';
import { diffHunkAnchor, feedbackCodeContext, type FeedbackItem } from '../lib/feedback';
import { prepareReviewHunk } from '../lib/review-diff';
import { diffThemeName } from '../lib/diff-worker-pool';
import { applyCodePalette } from '../lib/diff-code-palette';
import { useDiffAppearance } from '../lib/use-diff-appearance';
import { publishDiffLayout, useDiffLayout, useDiffLayoutTarget } from '../lib/use-diff-layout';
import type { DiffHunk, Preferences } from '../lib/types';
import type { GitHubReviewThread } from '../lib/review-threads';
import type { usePrDiscussions } from '../lib/use-pr-discussions';
import { toast } from './ui/toast';

type Thread = GitHubReviewThread;

/**
 * A code thread where it belongs: in the code, under the line it is anchored to, drawn by the same diff as Changes
 * (ReviewDiff over ChangesDiff and useDiffFileModel): the code-tier file header, hunk headers with their breadcrumbs,
 * gap bars that reveal more of the file, and the reader's code theme. GitHub saves each comment's hunk up to the
 * commented line, so the thread anchors to the hunk's last line. Current threads whose line still matches read
 * their gaps and structure from the PR's head; earlier revisions show only the code as it was, labelled as such.
 */
export function FeedbackCodeThread({
  item,
  thread,
  preferences,
  discussion,
  renderThread,
  onSource,
  tags,
  actions,
}: {
  item: FeedbackItem;
  thread: Thread;
  preferences?: Preferences;
  discussion: ReturnType<typeof usePrDiscussions>;
  renderThread: (thread: Thread) => ReactNode;
  onSource: () => void;
  /** After the anchor in the file header: the thread's state and read status. */
  tags?: ReactNode;
  /** The item's own actions, before Show full file. */
  actions?: ReactNode;
}) {
  const header = useRef<HTMLElement>(null);
  const [fullFile, setFullFile] = useState(false);
  const theme = diffThemeName(preferences?.codeTheme);
  useLayoutEffect(() => applyCodePalette(theme), [theme]);
  const saved_ = useDiffAppearance(preferences?.diffAppearance);
  // Long lines wrap, as Changes wraps them: a thread never scrolls sideways.
  const appearance = useMemo(() => ({ ...saved_, wrap: true }), [saved_]);
  const context = feedbackCodeContext(
    thread,
    item.headSha ? { headSha: item.headSha, baseSha: item.baseSha ?? '' } : undefined,
    item.member
  );
  const earlier = context === 'earlier';
  const saved = thread.comments.find((comment) => comment.diffHunk)?.diffHunk ?? item.comments[0]?.diffHunk;
  const anchor = diffHunkAnchor(saved);
  const hunks = useMemo<DiffHunk[]>(() => {
    if (!saved) return [];
    const [hunkHeader, ...rest] = saved.replace(/\n$/, '').split('\n');
    return [{ filePath: thread.path, hunkHeader, content: rest.join('\n'), language: '', renderedHtml: '' }];
  }, [saved, thread.path]);
  const readable = hunks.length > 0 && !!anchor && !!prepareReviewHunk(hunks[0]);
  // Current coordinates hold only while GitHub's line is still the line the saved hunk ends on.
  const current = context === 'current' && !!anchor && thread.line === anchor.line && thread.diffSide === anchor.side;
  const [revision] = useState(() => ({
    url: item.member.url,
    baseSha: item.member.baseSha,
    headSha: item.member.headSha,
  }));
  const source = useMemo(
    () =>
      current
        ? {
            url: revision.url,
            path: thread.path,
            baseSha: item.baseSha || revision.baseSha,
            headSha: item.headSha || revision.headSha,
          }
        : undefined,
    [current, revision, thread.path, item.baseSha, item.headSha]
  );
  const placed = useMemo<Thread[]>(
    () => (anchor ? [{ ...thread, line: anchor.line, diffSide: anchor.side }] : []),
    [thread, anchor?.line, anchor?.side]
  );
  const status = earlier
    ? `Earlier revision${anchor ? ` · line ${anchor.line} when commented` : ''}`
    : anchor
      ? `${anchor.side === 'LEFT' ? 'Old line' : 'Line'} ${anchor.line}${current ? '' : ' when commented'}`
      : 'Code when commented';
  return (
    <>
      <section
        className="review-file-group feedback-code-thread"
        data-code-theme={theme}
        aria-label={`Code and conversation, ${thread.path}`}
      >
        <DiffFileHeader
          headerRef={header}
          path={thread.path}
          stats={<span data-earlier={earlier || undefined}>{status}</span>}
          tags={tags}
          actions={
            <>
              {actions}
              {preferences && (
                <Button size="sm" variant="outline" aria-expanded={fullFile} onClick={() => setFullFile((open) => !open)}>
                  {fullFile ? 'Hide full file' : earlier ? 'View current file' : 'Show full file'}
                </Button>
              )}
            </>
          }
        />
        {earlier && (
          <p className="feedback-code-note" role="note">
            The code changed after this comment. This is the code as it was then. View current file compares it with
            today’s.
          </p>
        )}
        {readable ? (
          <ReviewDiff
            filePath={thread.path}
            hunks={hunks}
            diffLayout="unified"
            appearance={appearance}
            slideIndex={-1}
            threads={placed}
            renderThread={() => <Fragment key={thread.id}>{renderThread(thread)}</Fragment>}
            plainGaps
            source={source}
            theme={theme}
          />
        ) : (
          <>
            <p className="feedback-code-note">
              {saved
                ? 'GitHub’s saved code for this comment could not be read as a diff.'
                : 'GitHub did not provide code context for this comment.'}
            </p>
            <div className="feedback-code-unplaced">{renderThread(thread)}</div>
          </>
        )}
      </section>
      {preferences && fullFile && (
        <FullFile
          thread={thread}
          earlier={earlier}
          revision={revision}
          preferences={preferences}
          discussion={discussion}
          onSource={onSource}
        />
      )}
    </>
  );
}

/** The whole file from the shared Changes cache, on demand, at the revision first shown. Threads are not repeated. */
function FullFile({
  thread,
  earlier,
  revision,
  preferences,
  discussion,
  onSource,
}: {
  thread: Thread;
  earlier: boolean;
  revision: { url: string; baseSha: string; headSha: string };
  preferences: Preferences;
  discussion: ReturnType<typeof usePrDiscussions>;
  onSource: () => void;
}) {
  const fullContext = useRef<HTMLDivElement>(null);
  const [entry, setEntry] = useState<ChangeFileEntry>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [chat, setChat] = useState<string>();
  const layout = useDiffLayout(preferences.diffLayout);
  // Diff layout keys also work on the full file. Feedback has no appearance menu, so save the choice here.
  useDiffLayoutTarget(
    fullContext,
    (diffLayout) => {
      publishDiffLayout(diffLayout);
      void window.electronAPI
        .loadPreferences()
        .then((current) => window.electronAPI.savePreferences({ ...current, diffLayout }))
        .catch(() =>
          toast.add({
            title: 'Could not save the diff layout',
            description: 'Open diffs use it until you close Gnosis.',
          })
        );
    },
    true
  );
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setError('');
    void inspectionData
      .readChanges(revision, false, false, controller.signal)
      .then((snapshot) => {
        if (!live) return;
        const file = snapshot.files.find((file) => file.path === thread.path || file.previousPath === thread.path);
        if (!file) {
          setError(
            snapshot.filesTruncated
              ? 'This file is outside the available file list. The saved comment context is still available.'
              : 'This file is no longer in the current changes. The saved comment context is still available.'
          );
          return;
        }
        setEntry({ key: `${snapshot.url}:${file.path}`, snapshot, file });
      })
      .catch(() => {
        if (live) setError('Could not load the full file. Your conversation and saved code context remain available.');
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [attempt, revision, thread.path]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => fullContext.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="feedback-full-file" ref={fullContext} data-diff-layout={entry ? layout : undefined}>
      <p>
        {earlier
          ? `Current file at ${revision.headSha.slice(0, 7)}. The earlier comment is not attached to these lines.`
          : `Full file at ${revision.headSha.slice(0, 7)}. The conversation stays above.`}{' '}
        <Button variant="link" size="sm" onClick={onSource}>
          Open in Changes
        </Button>
      </p>
      {error ? (
        <p role="status">
          {error}{' '}
          <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry file
          </Button>
        </p>
      ) : entry ? (
        <PrFileInspection
          entry={entry}
          preferences={preferences}
          discussion={discussion}
          focusThreadId={thread.id}
          renderFeedbackThread={() => null}
          onAsk={setChat}
        />
      ) : (
        <p role="status">
          <RefreshCw size={14} className="animate-spin" /> Loading full file context…
        </p>
      )}
      {chat !== undefined && entry && (
        <PrFileChat
          request={{
            url: entry.snapshot.url,
            path: entry.file.path,
            baseSha: entry.snapshot.metadata.baseSha,
            headSha: entry.snapshot.metadata.headSha,
          }}
          preferences={preferences}
          selection={chat}
          onClose={() => setChat(undefined)}
        />
      )}
    </div>
  );
}
