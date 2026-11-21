import { ExternalLink } from 'lucide-react';
import { attentionIcons } from '../lib/interface-icons';
import { openConflictWorkspace } from '../lib/open-conflict-workspace';
import type { QueueSignals } from '../lib/queue-signals';
import { stackConflictPlan } from '../lib/stack-conflict-plan';
import type { ReviewSubject } from '../lib/workbench';
import { Button } from './ui/button';

/** The stack's next fix, lowest PR first, with the one action that moves it. */
export function StackConflictPlan({ subject, signals }: { subject: ReviewSubject; signals: QueueSignals[] }) {
  const plan = stackConflictPlan(subject, (member) => signals.find((s) => s.url === member.url && s.headSha === member.headSha));
  if (!plan) return null;
  const { step } = plan;
  const resolve = step.kind === 'conflicts' || step.merged.conflicts;
  const { icon: Icon, tone } = attentionIcons[resolve ? 'conflicts' : 'restack'];
  return (
    <section className="stack-conflict-plan" aria-label="Stack fixes" data-step={step.kind} data-tone={tone}>
      <Icon size={16} aria-hidden="true" />
      <p>{step.text}</p>
      {resolve ? (
        <Button size="sm" variant="outline" onClick={() => openConflictWorkspace(step.member.url)}>
          Resolve conflicts in #{step.member.number}
        </Button>
      ) : (
        // Gnosis cannot change a PR's base yet; GitHub can, from the PR's title.
        <Button size="sm" variant="outline" asChild>
          <a href={step.member.url} target="_blank" rel="noopener noreferrer">
            Change base of #{step.member.number} on GitHub
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </Button>
      )}
    </section>
  );
}
