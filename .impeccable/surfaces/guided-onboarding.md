# Guided onboarding

Mode: Operate.

## Direction contract

Engineers configure their review queue, then learn the existing workbench through an optional spotlight walkthrough.
This surface extends the cool-neutral system in [DESIGN.md](../../DESIGN.md) and the laptop context in [PRODUCT.md](../../PRODUCT.md).
It retains the existing fonts, theme colors, controls, focus treatment, and restrained hierarchy.
The extension introduces no global tokens or replacement visual world.

## Setup composition

[OnboardingSetup](../../components/OnboardingSetup.tsx) composes the shadcn Questionnaire primitives, shared Dialog, Buttons, and searchable controls.
The centered dialog has a maximum width of 680px and a viewport height allowance of 48px.
Its question content scrolls independently. The heading, progress, and footer remain outside that scroll area.
The footer keeps **Finish later**, **Back**, and the primary next action visible.
Below 600px, the dialog uses 16px padding and a 24px height allowance. AI tool and model fields form one column.

The dialog title uses 20px text. Question headings use 18px, descriptive text uses 14px, and control notes use 13px.
Choice rows pair a checkbox with a short title and description. Selection uses the existing accent surface and ring color for its border.
Repository selections appear as removable labels. Search supports multiple repositories, direct `owner/repository` entry, and retry after a search failure.

## Decisions and persistence

The connected path has six steps: goals, GitHub, repositories, filters, AI, and preview.
Each goal creates a distinct saved view:

| Goal | Default view | Scope |
| --- | --- | --- |
| Review PRs assigned to me | Needs my review | Review requests and PRs where the user is an assignee |
| Follow repository work | Repository activity | Open PRs across selected repositories |
| Track my own PRs | My PRs | PRs the user authored |

The two personal goals require no repository selection. Repository activity requires at least one repository.
Local mode skips the GitHub, repositories, and filters steps. It creates no queue views.
New installations use a 30-day activity cutoff and hide Dependabot PRs. Replay starts with current preferences.
The cutoff and Dependabot setting apply across Gnosis. Optional label, author, and target-branch filters further narrow the setup views.

AI remains optional. CLI detection establishes binary availability only, with separate installation and sign-in guidance.
Automatic briefings require explicit opt-in and a daily cap. Existing automation choices remain visible during replay.
Full explanations start on request. **Set up AI later** leaves provider choices unchanged and disables automatic briefings.

The preview names each view, selects the initial view, and states the repository, filter, and automation effects.
**Apply setup** applies the preview. Stable `setup:review`, `setup:repositories`, and `setup:authored` identities prevent duplicate views during replay.
Setup preserves unrelated saved views, reviews, and drafts.

SQLite stores the setup draft and walkthrough progress by GitHub account, with a separate local key.
Preferences and saved views retain their existing file stores. Apply validates the views before writes and attempts compensating rollback after a failure.
This is not one atomic transaction across stores. A rollback failure reports that some settings can have changed and offers another setup attempt.

## Pause, resume, and walkthrough

**Finish later**, close, and Escape save setup progress before dismissal. A failed save leaves the dialog open with an error.
During Apply, controls and dismissal remain disabled. Escape first respects an open combobox.
Paused setup offers **Resume setup**. Help, Settings, and Cmd/Ctrl+K expose separate **Run setup again** and **Show walkthrough** actions.
Apply offers the walkthrough with a **Not now** action.

[GuidedTour](../../components/GuidedTour.tsx) uses driver.js with the existing theme tokens and font.
Its bordered popover has no shadow, uses a compact heading, and stays within 340px or the viewport minus 24px.
The spotlight leaves its target interactive. Back, Next, close, and a step count provide explicit control.
Reduced-motion preferences disable animation.

The connected walkthrough visits the saved-view queue, PR summary, Changes, and Explanation in that order.
Without visible saved views, its first spotlight targets Review queue and explains filters and saved views.
The summary includes stack-specific guidance when the selected item is a stack.
The walkthrough changes the visible workspace without generating content or submitting a review.
An empty queue explains how to open a PR and resume. Missing targets receive an explanatory fallback instead of an indefinite wait.
Local or signed-out mode uses one **Local changes** spotlight, including at narrow widths.
Closing preserves the current step. Finishing resets progress so **Show walkthrough** replays from the start.

## Evidence

Source evidence includes the setup, Questionnaire, repository picker, tour, HomePage integration, onboarding model, hook, service, and final onboarding CSS block.
Rendered evidence lives in [review/onboarding](../review/onboarding/):

- `goals-light.png`, `filters-light.png`, `ai-light.png`, and `preview-light.png` show the connected setup and bounded scrolling layout.
- `goals-narrow-dark.png` shows the narrow dark layout and selected goals.
- `tour-queue.png`, `tour-summary.png`, `tour-changes.png`, and `tour-explanation.png` show the connected sequence.
- `tour-local-narrow-light.png` and `tour-queue-fallback.png` show the local target and the queue fallback.

These captures match the incumbent workbench palette, typography, controls, and laptop density.
The README still contains earlier slideshow-first descriptions outside this extension. That pre-existing terminology drift remains outside the documentation scope.
DESIGN.md and `.impeccable/design.json` remain unchanged.
