import { createContext, useContext, useState, useSyncExternalStore } from 'react';
import { DropdownMenu } from 'radix-ui';
import { WorkspaceIcon } from './WorkspaceIcon';
import { SubjectIcon } from './SubjectIcon';
import { WorkbenchIcon } from './WorkbenchIcon';
import type { RecentlyViewedStore, RecentVisit } from '../lib/recently-viewed';
import { PrStateIcon } from './QueueMetadata';
import { useIntent } from '../lib/use-predictions';
import { openIntent, reviewIntent } from '../lib/navigation-graph';

interface HistoryContext {
  store: RecentlyViewedStore;
  open: (visit: RecentVisit) => Promise<void>;
}
export const RecentlyViewedContext = createContext<HistoryContext | null>(null);
export function RecentlyViewed() {
  const context = useContext(RecentlyViewedContext);
  return context ? <HistoryMenu {...context} /> : null;
}
function HistoryMenu({ store, open }: HistoryContext) {
  const { entries, error } = useSyncExternalStore(store.subscribe, store.snapshot);
  const [visible, setVisible] = useState(false);
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(false);
  const intent = useIntent('recently-viewed');
  return (
    <DropdownMenu.Root
      open={visible}
      onOpenChange={(next) => {
        setVisible(next);
        if (next) setFailure('');
        else intent.leave();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className="workbench-icon recent-history-trigger"
          aria-label="Recently viewed"
          title="Recently viewed"
          disabled={pending}
        >
          <WorkbenchIcon name="history" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="recent-history-menu"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          loop
          aria-label="Recently viewed"
        >
          <DropdownMenu.Label className="recent-history-heading">Recently viewed</DropdownMenu.Label>
          {entries.length ? (
            <div className="recent-history-list">
              {entries.map((entry) => {
                const home = entry.location.page === 'home' ? entry.location.home : undefined;
                const subject = home?.item?.subject;
                const member = subject?.members[0];
                return (
                  <DropdownMenu.Item
                    key={entry.id}
                    {...intent.handlers(subject ? openIntent(subject.id, subject.members)
                      : entry.location.page === 'review' ? reviewIntent(entry.location.reviewId) : null)}
                    className="recent-history-item"
                    textValue={`${entry.label} ${entry.title} ${entry.detail}`}
                    title={[entry.label, entry.title, entry.detail].filter(Boolean).join(' · ')}
                    onSelect={(event) => {
                      event.preventDefault();
                      if (pending) return;
                      setPending(true);
                      void open(entry)
                        .then(() => setVisible(false))
                        .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
                        .finally(() => setPending(false));
                    }}
                  >
                    <span className="recent-history-label">{entry.label}</span>
                    {subject?.kind === 'stack' ? (
                      <SubjectIcon kind="stack" />
                    ) : member ? (
                      <PrStateIcon member={member} />
                    ) : entry.location.page === 'review' ? (
                      <WorkspaceIcon tab="explanation" />
                    ) : (
                      <WorkbenchIcon name={home?.viewId ? 'savedView' : 'queue'} />
                    )}
                    <span className="recent-history-name">{entry.title}</span>
                    {entry.detail && <span className="recent-history-detail">{entry.detail}</span>}
                  </DropdownMenu.Item>
                );
              })}
            </div>
          ) : (
            <p className="recent-history-empty">PRs, stacks, and views you open will appear here.</p>
          )}
          {(error || failure) && (
            <p className="recent-history-error" role="alert">
              {failure || error}
            </p>
          )}
          {error && (
            <DropdownMenu.Item className="recent-history-action" onSelect={() => store.retry()}>
              Retry saving history
            </DropdownMenu.Item>
          )}
          {!!entries.length && (
            <>
              <DropdownMenu.Separator className="recent-history-separator" />
              <DropdownMenu.Item className="recent-history-action" onSelect={() => store.clear()}>
                Clear recently viewed
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
