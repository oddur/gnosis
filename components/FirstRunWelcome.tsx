import { Button } from '@/components/ui/button';

interface Props {
  onDismiss: () => void;
  onShowShortcuts: () => void;
}

// First-run welcome. One page, no wizard. Introduces the slideshow
// concept, points at the keyboard cheatsheet, and gets out of the
// way. Senior reviewers can dismiss with a single click; first-time
// users get the editorial register from their first second.
//
// "Senior-first, gentle first-run": the page is friendly enough to
// onboard a newcomer but quiet enough that an experienced developer
// reads it once and dismisses it.

export function FirstRunWelcome({ onDismiss, onShowShortcuts }: Props) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center px-8 pt-[14vh] pb-12 bg-background">
      <div className="w-full max-w-2xl flex flex-col gap-10">
        <div className="flex flex-col gap-5">
          <div className="slide-chapter">
            <span>Welcome to Gnosis</span>
          </div>
          <h1 className="slide-title">A pull request is a story. Read it like one.</h1>
          <div className="slide-prose flex flex-col gap-3">
            <p>
              Gnosis turns a GitHub pull request into an ordered walkthrough you can read like a chapter. Foundation
              changes first, then the features built on top, then the tests and config — each on its own slide, each
              with a short narrative explaining <em>why</em> the change is there.
            </p>
            <p>
              You'll still see every diff. The walkthrough just gives you the order, the grouping, and the context
              that the file list never could.
            </p>
          </div>
        </div>

        <div className="border-t border-border pt-6 flex flex-col gap-4">
          <h2 className="editorial-heading text-base">How it works</h2>
          <ol className="slide-prose flex flex-col gap-2 list-decimal pl-5 marker:text-[var(--ring)] marker:font-mono marker:text-xs">
            <li>Sign in with GitHub, then paste a PR URL or browse your open requests.</li>
            <li>
              Pick a model and hit <span className="editorial-label">Generate review</span>. Reviews run locally
              against the Claude or Gemini CLI you already have installed.
            </li>
            <li>
              Walk through the slides with <kbd className="kbd">←</kbd> <kbd className="kbd">→</kbd>, leave inline
              comments, and submit them as a single review when you're done.
            </li>
          </ol>
          <p className="slide-meta">
            Press <kbd className="kbd">?</kbd> from anywhere to see the full keyboard cheatsheet — or{' '}
            <button
              type="button"
              onClick={onShowShortcuts}
              className="underline decoration-dotted decoration-[var(--ring)]/50 underline-offset-4 hover:decoration-[var(--ring)] hover:text-foreground transition-colors"
            >
              open it now
            </button>
            .
          </p>
        </div>

        <div className="flex items-center gap-6 pt-2">
          <Button onClick={onDismiss}>Get started →</Button>
          <button
            type="button"
            onClick={onDismiss}
            className="slide-meta hover:text-foreground transition-colors"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
