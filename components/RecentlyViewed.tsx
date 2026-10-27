import { createContext, useContext, useState, useSyncExternalStore } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Clock, GitBranch, ListFilter, BookOpen } from 'lucide-react';
import type { RecentlyViewedStore, RecentVisit } from '../lib/recently-viewed';
import { PrStateIcon } from './QueueMetadata';

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
  return (
    <DropdownMenu.Root
      open={visible}
      onOpenChange={(next) => {
        setVisible(next);
        if (next) setFailure('');
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className="workbench-icon recent-history-trigger"
          aria-label="Recently viewed"
          title="Recently viewed"
          disabled={pending}
        >
          <Clock size={17} aria-hidden="true" />
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
                      <GitBranch size={16} aria-label="PR stack" />
                    ) : member ? (
                      <PrStateIcon member={member} />
                    ) : entry.location.page === 'review' ? (
                      <BookOpen size={16} aria-hidden="true" />
                    ) : (
                      <ListFilter size={16} aria-hidden="true" />
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
