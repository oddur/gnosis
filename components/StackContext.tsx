import { StackDependencyChain } from './StackDependencyChain';
import { useCachedQueueSignals } from '../lib/use-queue-signals';
import type { ReviewSubject } from '../lib/workbench';

/** Sibling navigation reuses local evidence; expanding it does not poll GitHub. */
export function StackContext({
  subject,
  currentUrl,
  account,
  now,
  onOpen,
  onStack,
}: {
  subject: ReviewSubject;
  currentUrl: string;
  account: string | null;
  now: number;
  onOpen: (url: string) => void;
  onStack: () => void;
}) {
  const signals = useCachedQueueSignals(account, subject.members, true);
  return (
    <details className="stack-context">
      <summary>
        In stack: {subject.title} <span>· {subject.members.length} PRs</span>
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
