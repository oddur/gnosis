import { useId } from 'react';
import { Popover } from 'radix-ui';
import { CircleHelp, X } from 'lucide-react';

const terms = [
  [
    'Work queue',
    'PRs that involve you or come from repositories you follow in Gnosis. Filters help you choose what to review next.',
  ],
  [
    'Stack',
    'Related PRs that build on one another. Gnosis groups them into one review, in dependency order. A standalone PR works the same way.',
  ],
  [
    'Briefing',
    'A short AI summary of a PR or stack: what changes, which systems it affects, and where to focus. Automatic briefings use your selected AI tool, within a daily limit.',
  ],
  [
    'Guided review',
    'An AI walkthrough organized into topics, with explanations beside the relevant code changes. Starting one does not submit a review to GitHub.',
  ],
  ['Topic', 'One part of a guided review. Topics follow the explanation of the change, rather than the file order.'],
  [
    'Exploration',
    'An interactive diagram that explains a concept in a topic. Use Explore to generate or reopen one, then try its controls.',
  ],
  [
    'Activity',
    'Background work and its progress, at the bottom of the window. Open it to see results, cancel work, or retry a failed task.',
  ],
  [
    'Saved review',
    'A generated walkthrough stored on this computer. Reopen it to continue; check its freshness when the PR changes.',
  ],
  [
    'Source PR',
    'The PR that contributed the code you are reading. In a stack, this can differ from the PR selected for review submission.',
  ],
  [
    'Review submission',
    'Comments, approval, or a request for changes that you explicitly send to an individual GitHub PR. Marking a topic reviewed only tracks your progress in Gnosis.',
  ],
  [
    'Watched repository',
    'A repository whose open PRs you add to this queue. This is a Gnosis setting; it does not change your GitHub watch subscriptions.',
  ],
  [
    'AI tool and model',
    'The tool is Claude Code or Codex, installed and signed in on your computer. The model is the AI selected in the workbench. GitHub sign-in is separate.',
  ],
] as const;

export function WorkbenchHelp({ onGettingStarted }: { onGettingStarted?: () => void }) {
  const titleId = useId();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="workbench-help-trigger" title="Help and terminology" aria-label="Help and terminology">
          <CircleHelp size={16} /> <span>Help</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="workbench-help"
          sideOffset={8}
          align="end"
          collisionPadding={12}
          aria-labelledby={titleId}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="workbench-help-heading">
            <h2 id={titleId}>Using Gnosis</h2>
            <Popover.Close className="workbench-icon" aria-label="Close help">
              <X size={16} />
            </Popover.Close>
          </div>
          <p>Choose a change, understand its intent, then inspect the code.</p>
          <ol className="workbench-help-steps">
            <li>Select a PR or stack to read its short briefing.</li>
            <li>
              Start a guided review for an explanation beside the code. Ask questions or explore a concept as needed.
            </li>
            <li>Track your progress by topic. Submit feedback to GitHub when you are ready.</li>
          </ol>
          {onGettingStarted && (
            <Popover.Close asChild>
              <button className="workbench-help-link" onClick={onGettingStarted}>
                Show getting started
              </button>
            </Popover.Close>
          )}
          <h3>Terms you’ll see</h3>
          <div className="workbench-glossary">
            {terms.map(([term, definition]) => (
              <details key={term}>
                <summary>{term}</summary>
                <p>{definition}</p>
              </details>
            ))}
          </div>
          <details className="workbench-help-shortcuts">
            <summary>Queue filters and keyboard shortcuts</summary>
            <p>
              <strong>Requested</strong> means you were asked to review. <strong>Updated</strong> means code changed
              since a saved review. <strong>Dependencies</strong> shows changes that other PRs build on.
            </p>
            <p>
              In the queue: <kbd>↑</kbd>/<kbd>↓</kbd> or <kbd>j</kbd>/<kbd>k</kbd> select a change; <kbd>Enter</kbd>{' '}
              opens its guided review; <kbd>/</kbd> searches.
            </p>
            <p>
              In a review, press <kbd>?</kbd> for its keyboard shortcuts.
            </p>
          </details>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
