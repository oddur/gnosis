import { useId, useRef, type ReactElement } from 'react';
import { Popover } from 'radix-ui';
import { CircleHelp, X } from 'lucide-react';

const terms = [
  [
    'Review queue',
    'PRs that involve you or come from repositories you follow in Gnosis. Filters help you choose what to review next.',
  ],
  [
    'Stack',
    'Related PRs that build on one another. Gnosis groups them into one review, in dependency order. A standalone PR works the same way.',
  ],
  [
    'Saved view',
    'A named set of queue filters, such as your review requests or one author’s recent PRs. Save a view from the filter bar and switch in the sidebar. Views are stored on this computer and share cached GitHub data. Switching views does not refresh GitHub. “Filters changed” means your current filters differ from the saved version; choose Save changes or Restore saved filters.',
  ],
  [
    'PR overview',
    'The author’s description, labels, checks, and review status. You can read it before generating anything with AI. A stack overview lets you switch between its PRs.',
  ],
  [
    'AI briefing',
    'A short AI summary of a PR or stack: what changes, which systems it affects, and where to focus. Automatic briefings use your selected AI tool, within a daily limit.',
  ],
  [
    'AI explanation',
    'An AI walkthrough organized into topics, with explanations beside the relevant code changes. Starting one does not submit a review to GitHub.',
  ],
  [
    'Explanation ready',
    'The AI has finished generating an explanation alongside the code. This does not mean a person has reviewed or approved the PR.',
  ],
  [
    'Viewed file',
    'Your file-level progress in Gnosis. Marking Viewed collapses the file to its header; the arrow opens it again. This does not mark the file viewed on GitHub.',
  ],
  [
    'Inline explanation',
    'AI-generated context on a blue background beside the code. It explains non-obvious behavior; it is not a GitHub comment. Hide or show these with Inline explanations.',
  ],
  ['Topic reviewed', 'Your reading progress in Gnosis. It does not approve the PR or send feedback to GitHub.'],
  [
    'Daily briefing limit',
    'The number of automatic briefing attempts allowed each day, including retries. AI explanations do not use this allowance.',
  ],
  ['Other changes', 'PRs and stacks that are not in Review requested or Changed since AI explanation.'],
  ['Topic', 'One part of an AI explanation. Topics follow the explanation of the change, rather than the file order.'],
  [
    'Interactive explanation',
    'An interactive diagram that explains a concept in a topic. Create interactive explanation generates one. Open interactive explanation reopens the saved result.',
  ],
  [
    'Activity',
    'Background work and its progress, at the bottom of the window. Open it to see results, cancel work, or retry a failed task.',
  ],
  [
    'Saved review',
    'A generated walkthrough stored on this computer. Reopen it to continue; check whether it includes the latest changes.',
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
    'Repositories in your queue',
    'Repositories whose open PRs you add to this queue. This list is a Gnosis setting; it does not change your GitHub watch subscriptions.',
  ],
  [
    'AI tool and model',
    'The tool is Claude Code or Codex, installed and signed in on your computer. The model is the AI selected in the workbench. GitHub sign-in is separate.',
  ],
] as const;

export function WorkbenchHelp({
  onGettingStarted,
  onWalkthrough,
  open,
  onOpenChange,
  anchor,
}: {
  onGettingStarted?: () => void;
  onWalkthrough?: () => void;
  /** Controlled use: a menu opens help, which then attaches to `anchor` instead of its own trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchor?: ReactElement;
}) {
  const titleId = useId();
  const replaying = useRef(false);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) replaying.current = false;
        onOpenChange?.(next);
      }}
    >
      {anchor ? (
        <Popover.Anchor asChild>{anchor}</Popover.Anchor>
      ) : (
        <Popover.Trigger asChild>
          <button className="workbench-help-trigger" title="Help and terminology" aria-label="Help and terminology">
            <CircleHelp size={16} /> <span>Help</span>
          </button>
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Content
          className="workbench-help"
          sideOffset={8}
          align="end"
          collisionPadding={12}
          aria-labelledby={titleId}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (replaying.current) {
              event.preventDefault();
              document.getElementById('getting-started-title')?.focus();
            }
          }}
        >
          <div className="workbench-help-heading">
            <h2 id={titleId}>Using Gnosis</h2>
            <Popover.Close className="workbench-icon" aria-label="Close help">
              <X size={16} />
            </Popover.Close>
          </div>
          <ol className="workbench-help-steps">
            <li>
              Open a PR to read its description, inspect changes, and check GitHub status. AI setup is optional.
            </li>
            <li>
              Generate an explanation, then scroll through each section beside its code. Use Next section to skip ahead and Ask a question for help.
            </li>
            <li>
              Mark files Viewed to track progress. Use Review PR to send comments, approve, or request changes.
            </li>
          </ol>
          {onWalkthrough && <Popover.Close asChild><button className="workbench-help-link" onClick={onWalkthrough}>Show walkthrough</button></Popover.Close>}
          {onGettingStarted && (
            <Popover.Close asChild>
              <button
                className="workbench-help-link"
                onClick={() => {
                  replaying.current = true;
                  onGettingStarted();
                }}
              >
                Run setup again
              </button>
            </Popover.Close>
          )}
          <details className="workbench-help-shortcuts">
            <summary>Code and explanations</summary>
            <p>
              <strong>Inline explanations</strong> add context on a blue background. GitHub comments show their author and replies.
            </p>
            <p>
              <strong>Diff appearance</strong> controls Unified or Split view and surrounding lines. Expand hidden lines in the diff for more context.
            </p>
            <p>
              <strong>Images</strong> show Before and After revisions. Expand a preview to inspect it; SVG source and comments are below it.
            </p>
            <p>
              <strong>Activity</strong> tracks generation. Results are saved when complete.
            </p>
          </details>
          <details className="workbench-help-shortcuts">
            <summary>Keep reviews open in tabs</summary>
            <p>
              <kbd>{window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'}-click</kbd> a PR title to open it in the
              background. Add Shift to switch to it immediately.
            </p>
            <p>
              Each tab keeps its reading position and Back/Forward history. Comments and Viewed progress are shared.
            </p>
            <p>
              <kbd>{window.electronAPI.platform === 'darwin' ? '⌘T' : 'Ctrl+T'}</kbd> opens a tab;{' '}
              <kbd>{window.electronAPI.platform === 'darwin' ? '⌘W' : 'Ctrl+W'}</kbd> closes it.{' '}
              <kbd>{window.electronAPI.platform === 'darwin' ? '⌘⇧T' : 'Ctrl+Shift+T'}</kbd> reopens the last closed
              tab.
            </p>
            <p>
              <kbd>Ctrl+Tab</kbd> switches tabs. Use{' '}
              <kbd>{window.electronAPI.platform === 'darwin' ? '⌘1–9' : 'Ctrl+1–9'}</kbd> to jump to a tab. Right-click
              a tab to move it or close other tabs. You can also drag tabs to reorder them.
            </p>
          </details>
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
              <strong>Review requests</strong> shows PRs you were asked to review. If PR content or stack membership
              changed since a saved AI explanation, they appear under <strong>Updated PRs</strong> instead.
              <strong> Stacks</strong> shows PRs that build on each other. Other filters still apply to each section.
            </p>
            <p>
              All PR filters must match the same open PR. A matching PR keeps its whole stack visible, including merged
              PRs. Each stack counts as one queue item. Built-in sidebar counts use cached data before your other
              filters.
            </p>
            <p>
              <strong>Involving me</strong> includes PRs you authored, are assigned to, or were asked to review. It also
              reduces the PR details fetched from GitHub. Other filters narrow the loaded queue. Automatic briefings
              follow the scope selected in Filters.
            </p>
            <p>
              For example, PR #42 adds an API and PR #43 uses it. #43 builds on #42; reviewing #42 helps the stack move
              forward. Expand the stack to see its PRs in dependency order, with the base PR first.
            </p>
            <p>
              In the queue: <kbd>↑</kbd>/<kbd>↓</kbd> or <kbd>j</kbd>/<kbd>k</kbd> select a change; <kbd>Enter</kbd>{' '}
              opens the PR overview or a ready AI explanation; <kbd>/</kbd> searches. Double-click a change to read its
              author description. In the PR overview, <kbd>j</kbd>/<kbd>k</kbd> move through your filtered queue and
              <kbd>Esc</kbd> returns to it. Generate an AI explanation for a walkthrough alongside the code.
            </p>
            <p>
              <kbd>{window.electronAPI.platform === 'darwin' ? '⌘\\' : 'Ctrl+\\'}</kbd> shows or hides the queue sidebar.
              In a review, press <kbd>?</kbd> for its keyboard shortcuts.
            </p>
            <p>
              In any diff, <kbd>d</kbd> switches between split and unified layouts. <kbd>u</kbd> and <kbd>s</kbd> choose
              one.
            </p>
          </details>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
