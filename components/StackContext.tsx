import { SubjectIcon } from './SubjectIcon';
import { StackDependencyChain } from './StackDependencyChain';
import { useCachedQueueSignals } from '../lib/use-queue-signals';
import type { ReviewSubject } from '../lib/workbench';
import { useStatusNow } from '../lib/status-clock';

/** Sibling navigation reuses local evidence; expanding it does not poll GitHub. */
export function StackContext({
  subject,
  currentUrl,
  account,
  onOpen,
  onStack,
  compact = false,
}: {
  subject: ReviewSubject;
  currentUrl: string;
  account: string | null;
  onOpen: (url: string) => void;
  onStack: () => void;
  compact?: boolean;
}) {
  const signals = useCachedQueueSignals(account, subject.members, true);
  const now = useStatusNow();
  return (
    <details className={`stack-context ${compact ? 'stack-context-compact' : ''}`}>
      <summary>
        <SubjectIcon kind="stack" />
        {compact ? (
          `Stack · ${subject.members.length} PRs`
        ) : (
          <>
            In stack: {subject.title} <span>· {subject.members.length} PRs</span>
          </>
        )}
      </summary>
      <div className="stack-context-heading">
        <span>Current PR highlighted below</span>
        <button onClick={onStack}>Open stack overview</button>
      </div>
      <StackDependencyChain
        subject={subject}
        signals={signals}
        now={now}
        currentUrl={currentUrl}
        onOpen={(member) => onOpen(member.url)}
      />
    </details>
  );
}
