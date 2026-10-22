# Gnosis review workbench plan

## Outcome

Reviewers can handle a high volume of PRs while understanding how the codebase changes.
The workbench treats a standalone PR or an entire stack as one review subject.
It supports fast triage, a concise briefing, and detailed review connected to source code.

The product direction is agreed. The implementation choices and numeric defaults below are proposals for delivery.
This plan does not claim that the workbench is implemented.

## Agreed experience

| Area             | Behavior                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Queue            | Compact rows organized around requested reviews, updates since review, and work that blocks other changes. |
| Filtering        | One queue across repositories, with repository filters and visible age.                                    |
| Standalone PR    | Complete briefing, guided review, code, chat, diagrams, and progress.                                      |
| Stack            | One expandable queue group, combined briefing, guided review across members, and visible PR attribution.   |
| Grouping         | Automatic grouping from clear dependency evidence. Confirmation for uncertainty and user corrections.      |
| Generation       | Automatic short briefings within configurable limits. Detailed reviews and explorations on demand.         |
| Workspace        | Two main panes for explanation and code, with collapsible navigation.                                      |
| Contextual tools | Chat or a diagram temporarily occupies a pane and preserves the prior view.                                |
| Updates          | Preserve unaffected progress and identify changed or uncertain review coverage.                            |
| GitHub actions   | Comments and approvals target individual PRs within the stack.                                             |
| Appearance       | Compact sans-serif typography, subtle panels, clear controls, and equal support for light and dark themes. |

The opening view gives intent, affected systems, and review priorities.
Returning to a review restores its position and offers direct access to the overview.
The queue explains its ordering. It does not use an unexplained model priority score.

## Laptop composition

The queue fills the main window. Each stack row expands into its member PRs in dependency order.
Rows show status and a short purpose, without full article excerpts.
The overview shows intent, affected systems, review priorities, and links into supporting code.
Stack members retain their individual CI and review status.

Detailed review uses a narrow, collapsible topic navigator and two resizable main panes.
The explanation selects related code without hiding its source PR.
Chat replaces the explanation pane. An interactive diagram replaces the code pane by default.
These pane choices are implementation proposals to evaluate in the first working layout.
Closing a contextual tool restores scroll position, selection, and focus.

The shell stays usable at proposed acceptance sizes of 1280×800 and 1440×900 CSS pixels.
At narrower widths, the layout can switch to one pane with explicit view controls.
Code and prose can scroll. Toolbars and navigation remain accessible without page-level horizontal scrolling.

## Current implementation gaps

| Current location           | Gap                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `lib/types.ts`             | Reviews and history use one PR URL and mostly one head SHA. There is no stack identity or membership model. |
| `lib/github.ts`            | Detailed metadata includes branch names and SHAs, but queue results omit branch identities.                 |
| `lib/github.ts`            | Base file reads use a moving branch name. Review source needs immutable revisions.                          |
| `src/main.ts`              | Freshness can return current when the head is unchanged, without checking a changed parent or base.         |
| `lib/context-builder.ts`   | Generation context describes one PR without dependencies or member attribution.                             |
| `src/main.ts`              | Proactive mode generates full reviews. Short briefings need separate scheduling and persistence.            |
| `lib/review-archive.ts`    | Saved archives describe one review and need backward-compatible stack support.                              |
| `src/pages/HomePage.tsx`   | Newspaper layout and article excerpts limit queue density.                                                  |
| `src/pages/ReviewPage.tsx` | Explanation, navigation, chat, and explorations do not share one pane model.                                |
| `src/globals.css`          | Editorial typography, large headings, and generous spacing consume laptop space.                            |

## Proposed model and invariants

### Review subjects and snapshots

A `ReviewSubject` identifies a standalone PR, a stack, or an existing local Git review.
A stack keeps a stable local identity as its membership changes.
Each member uses repository identity and PR number, not a branch name alone.
Dependency edges record their evidence and any user correction.

A `ReviewSnapshot` captures membership, dependency edges, repository identities, refs, base SHAs, head SHAs, and comparison bases.
Generation, progress, comments, and explorations refer to this snapshot.
Changes to descriptions or generation settings also invalidate affected generated material.
Source reads use pinned commits. A generation cannot silently mix revisions from different refreshes.

Standalone and local reviews use the same lifecycle without fabricated stack members.
Old reviews load through a migration adapter. Missing revision information remains unknown until refreshed.
Original saved artifacts remain recoverable.

### Dependency discovery

Start with explicit base-to-head relationships between PRs, qualified by repository identity.
Check ambiguous relationships against commit ancestry before automatic grouping.
Titles, authors, branch prefixes, and incidental issue links do not establish dependencies by themselves.

Discovery must find parents outside the initial queue results, including known merged parents.
Forks require repository-qualified refs. Same-named branches cannot identify a parent by themselves.
Inaccessible or truncated results produce an incomplete-stack state, not a false standalone classification.
Cycles and conflicting evidence require correction rather than an invented order.

Preserve known lineage after squash merges, retargets, and parent deletion.
Do not promise reconstruction of historical stacks without sufficient evidence.
Explicit metadata from stacking tools can supply additional evidence through separate adapters.
Provider-specific support requires documented fixtures before release claims.

### Diffs and attribution

Each member contributes its own changes relative to its recorded comparison base.
The combined explanation can cross PR boundaries, but every source reference identifies its member and revision.
Inherited changes must not appear repeatedly as new contributions.

A cumulative comparison provides additional context. It does not replace member diffs or GitHub comment coordinates.
A branching dependency graph can have multiple tips. Do not invent one cumulative diff for unrelated tips.
GitHub comments retain PR, commit, path, side, and line information.
Before submission, check that the target revision still supports the comment anchor.

### Progress and updates

Progress records source coverage, not only generated topic numbers.
Match previous coverage using member identity, content, and dependency context.
Unchanged bytes alone do not prove an explanation remains valid after an upstream change.
Changed or uncertain coverage needs attention. Unaffected coverage retains progress.

A stack update can change membership, ordering, base, head, state, or generation context.
Local completion never implies GitHub approval.
Submission remains explicit for each affected PR, with partial failures visible and retryable.

### Background briefings

Briefings have a separate cache and job lifecycle from full reviews.
Cache keys include the subject snapshot, provider, model, and prompt version.
Foreground review and chat take priority over background work.

Proposed initial limits are one background generation at a time and ten new briefings per day.
These values remain configurable and need evaluation with real queues.
Cap input size, output size, runtime, and retries for each job.
Deduplicate repeated refreshes and cancel obsolete jobs.
Use request and token limits where dollar cost is unavailable from the provider.
Show paused, queued, generating, failed, stale, and ready states without blocking navigation.

Existing proactive settings need an explicit migration that preserves the user's choice about automatic generation.
The new policy must not silently start full reviews or discard saved results.

## Delivery sequence

Each slice includes a usable path and evidence that its behavior works.
The first complete workbench release includes stack support, rather than a standalone-only restyle.

### 1. Review subjects and immutable snapshots

Add the subject and snapshot model, source pinning, persistence adapters, and revision comparison.
Integrate the model into the existing single-PR path before changing the layout.
Keep main-process orchestration separate from discovery, storage, and revision logic.

Primary files: `lib/types.ts`, `lib/diffSource.ts`, `lib/github.ts`, `src/main.ts`, `lib/review-archive.ts`.

Acceptance: an old saved review still opens. A changed base cannot report current solely because its head is unchanged.
Local reviews and imported archives still work.

### 2. Stack discovery and compact queue

Add dependency discovery, user corrections, grouped queue data, and deterministic attention categories.
Replace the newspaper home screen with compact rows and repository filters.
Opening a stack provides its topology, member status, and an entry into review.
A standalone PR uses the same queue and overview components.

Primary files: `lib/github.ts`, new discovery and queue modules, `src/preload.ts`, `src/pages/HomePage.tsx`, `src/globals.css`.

Acceptance: a three-PR stack appears once, expands in dependency order, and retains individual member status.
Uncertain grouping is visible and correctable. Partial discovery does not masquerade as complete coverage.

### 3. Bounded automatic briefings

Implement the briefing schema, cache, scheduler, limits, and settings.
Connect background jobs to queue status and the compact overview.
Keep detailed review generation on demand.

Primary files: new briefing service, `src/main.ts`, `lib/agent.ts`, `lib/context-builder.ts`, `components/SettingsDialog.tsx`.

Acceptance: unchanged snapshots reuse a briefing. Updates replace obsolete work, limits survive restart, and foreground work takes priority.
Failures preserve the queue and expose a retry action.

### 4. Stack reviews and two-pane workspace

Build shared context from the snapshot and each member's contribution.
Plan topics across the stack and retain source attribution through generation and rendering.
Add the compact overview, collapsible navigation, pane state, and contextual chat and explorations.
Use the same path for a one-member subject.

Primary files: `lib/context-builder.ts`, `lib/agent.ts`, `src/pages/ReviewPage.tsx`, `components/SlideView.tsx`, `components/OverviewSlide.tsx`.
Related components: `TocRail`, `SlideNav`, `SlideChatSheet`, `ExplainerView`, and diff renderers.

Acceptance: a stack receives one coherent walkthrough with no duplicate inherited hunks and clear PR attribution.
At laptop sizes, chat and diagrams open without creating a third main pane.
Closing a tool restores the previous view, selection, and keyboard focus.

### 5. Progress across updates and per-PR actions

Add revision comparison across stack members, coverage matching, and affected-topic indicators.
Bind draft comments to their source PR and revision.
Expose a completion checklist for the stack and explicit submission for each PR.
Extend archive export and import for snapshots and attribution.

Primary files: `src/main.ts`, `lib/use-review-comments.ts`, `components/StaleBanner.tsx`, `components/SubmitReviewDialog.tsx`, `lib/review-archive.ts`.

Acceptance: parent changes, retargets, force pushes, merged members, and membership changes produce correct attention states.
Uncertain mappings never transfer completion or comment anchors silently.

## Validation and release evidence

Use deterministic fixtures for linear stacks, branching dependencies, forks, ambiguous matches, unavailable parents, merged parents, and standalone PRs.
Cover base-only changes, retargets, rebases, force pushes, and member additions or removals.
Cover repeated paths across members, renames, overlapping hunks, and changed comment anchors.

Run integration checks through discovery, snapshots, generation context, persistence, and reload.
Cover cancellation, obsolete jobs, provider failures, authentication loss, rate limits, and truncated input.
Keep the existing provider, chat, and explainer suites as regression coverage.

Use Electron browser checks for both themes at 1280×800 and 1440×900, plus a narrower fallback layout.
Inspect keyboard navigation, focus restoration, resizing, long names, large diffs, and empty or partial queues.
The app shell must not require horizontal scrolling. Diff panes can scroll horizontally.
Run the Impeccable detector after UI implementation and inspect the rendered screens.

Compare the old and new UI using the same PR and stack fixtures.
Record steps needed to find pending work, understand intent, reach code, open an exploration, and return to the queue.
Record visible queue rows and scroll distance to the first useful code section.
Use these observations to judge space efficiency without sacrificing comprehension.

## Decisions during implementation

The product direction is settled. The following details need evidence from the working slices:

- Exact spacing, type sizes, panel minimums, and collapse thresholds.
- Queue section precedence when an item matches multiple attention categories.
- Practical briefing limits across Claude and Codex providers.
- Supported metadata formats for external stacking tools.
- Progress matching rules for changes that preserve bytes but alter dependency context.

These details must preserve the agreed behavior and remain explicit in the relevant PR.
