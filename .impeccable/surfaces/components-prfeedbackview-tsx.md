---
version: 1
slug: "components-prfeedbackview-tsx"
primary_target: "components/PrFeedbackView.tsx"
related_targets: ["components/PrSummary.tsx", "components/GitHubReviewThread.tsx", "components/ReviewEvidence.tsx"]
---

Mode: Operate. Extend the existing PR/stack workspace and visual system.

## Direction contract

THESIS: Read incoming feedback, understand its code context, reply or resolve, and explicitly ask the reviewer to look again. Reading and resolving are different actions.

OWN-WORLD: Inherit Gnosis's typography, neutral panes, blue selection and unread dot, shared identity icons, shadcn controls, and both themes.

STORY: Summary opens Feedback → choose a conversation across the PR or stack → inspect the original code context → reply/resolve → re-request review from the relevant reviewer on the source PR.

FIRST VIEWPORT: Existing scoped PR header and tabs. A compact All/Unread/Unresolved toolbar, searchable stack PR picker, bounded Review requests popover, and refresh status above a two-pane conversation workspace. The list shows author, original excerpt, latest reply preview, comment count, thread state, file, and source PR. Conversations sort by latest activity across the stack, including edits. The detail pane keeps source identity, conversation, and actions together. No automatic read-all on tab entry.

FORM: User-confirmed extension of the existing workspace. Preserve PR ownership inside stacks. General PR comments and review summaries remain distinct from resolvable code threads. On narrow windows, list and conversation use one pane with an explicit return action.

FINISH: Verify rendered laptop, narrow, light/dark, keyboard, loading/empty, errors, and writes. Run critique, clarify, and distill and fix findings before finish review and documentation. No shipping raster assets.

## Scope

No agent-assisted code edits in this version. Replies publish to GitHub explicitly. General comment/review replies post a PR comment linked to their source; do not invent GitHub threading or resolution. Review requests are explicit per reviewer and PR, with remaining unresolved feedback visible, and never imply approval.

Cache and sync use the existing authenticated discussion service, backend SQLite storage, scheduler, and backoff. Renderer read markers are account-scoped and persisted through the backend review-state store. Partial loads and errors cannot appear as an empty/complete result. Keep saved conversations visible while refreshing.

## Implemented behavior

- **Scope and ownership:** The searchable PR picker scopes the list, All/Unread/Unresolved counts, and review-request actions together. Review summaries link to their related code threads. Replies, edits, resolution, and requests remain attached to the source PR.
- **Review requests:** The toolbar opens a bounded, scrolling popover, at most 640px wide with 16px viewport clearance. Rows show reviewers whose latest submitted review requests changes, source PR, unresolved thread count, and pending/sent state. Permission and open-PR checks gate the explicit request action. Requests neither resolve threads nor imply approval.
- **Reading:** Selecting a conversation focuses the detail heading and marks only displayed feedback read while the document is visible. Read fingerprints include other authors’ comment IDs and edit timestamps; the viewer’s own replies do not create unread feedback. Mark unread returns to the list. The selected item stays visible when reading changes its filter membership.
- **Automation filter:** Hide GitHub Actions defaults on, saved per account in SQLite. It recognizes `github-actions` and `github-actions[bot]` without case sensitivity. Threads with human or unknown-author replies remain visible. Counts follow the filter and selected hidden conversations close. Save failures retain the prior option and show recovery text. No network request is needed.
- **Persistence and sync:** Account-scoped read markers use the backend SQLite review-state store; browser previews retain their existing storage adapter. Disk snapshots hydrate the shared renderer discussion cache without superseding newer evidence, and an in-flight refresh can still win. Visible feedback registers interest with the existing sync scheduler and backoff. Local writes and backend updates publish through the shared cache; account changes clear cached discussions. Feedback and evidence share updates rather than running separate polling loops.
- **List and detail:** Wide workspaces use a 28% list with a 240px minimum, independently scrolling beside the detail. At ≤760px of available content width, only the list or selected detail is visible. Detail hides the list filters. Conversations restores focus to its originating row after virtualization, or to the list if that row no longer matches. Keyboard arrows, Home, and End move focus through the list.
- **Code context:** Show the saved hunk immediately, starting with six code lines, with Earlier revision explicit. Wide workspaces put code beside the conversation; smaller windows lead with the conversation. Show full file reads the shared Changes cache on demand, pins that revision, and does not duplicate threads. Missing context retains the discussion. Open in Changes remains optional; stale head/base coordinates are never used for a line jump.
- **Response workflow:** Feedback owns all conversation types and code-thread progression. Changes no longer has a Files / Code threads switch. Toolbar and inline Address feedback links enter this tab, optionally selecting a specific source PR and thread. Reply and submission controls stay docked below the reading pane. Resolve & next crosses PR boundaries within the current filter, advancing only after success. Undo names and reselects the reopened PR/thread. Completion retains review decisions and explicit review requests, and never calls partially loaded feedback complete. Reply drafts share an account scope across Changes and Feedback.
- **Writes:** Code threads retain reply, resolve/reopen, edit, and delete semantics. General PR-comment and review-summary replies create a new PR comment linked to the source, with this behavior stated beside the composer. There is no invented threading or resolution for general comments. Action-specific errors distinguish reply, resolve, reopen, edit, and delete failures, focus the error, and preserve drafts. Successful writes followed by refresh failure are labelled as sent.
- **Loading and recovery:** Preserve saved conversations during refresh. Partial loads and unavailable PRs cannot appear complete or empty. A compact saved-feedback error names affected PRs, with Details and Retry. Long diagnostics remain in disclosure rather than displacing conversations.

## Verification record

The implementation session reported these checks; this documentation pass inspected their corresponding implementation and screenshot inventory rather than rerunning the suites:

- Full unit suite before final refinements: **727 passed, 2 skipped**.
- Focused feedback, discussion-cache, and persistence checks after refinements: **23 passed**.
- TypeScript and lint checks passed.
- Docker browser checks passed for the latest Feedback, threads, and evidence behavior, plus the PR summary regression.
- Independent critiques A and B established a **26/40 baseline**. The full finish review confirmed all original findings resolved and requested two behavior fixes: action-specific write errors and focus restoration when returning to the narrow list. The follow-up finish verdict independently scored both fixes resolved and returned **ship**. `resolve-error-with-draft.png` shows the failed Resolve message with the draft preserved; browser `activeElement` assertions passed after both narrow Mark unread and Conversations. No new whole-surface numerical score was assigned.

Screenshot evidence lives in `../review/feedback/`:

- Stack and scoped requests: `stack-list-light.png`, `review-requests-light.png`, `filtered-requests-light.png`.
- Conversations and themes: `thread-light.png`, `review-light.png`, `review-dark.png`, `outdated-dark.png`.
- Responsive layouts: `short-laptop-light.png`, `narrow-list-dark.png`, `narrow-conversation-dark.png`.
- Recovery and failed writes: `cached-error-dark.png`, `reply-error.png`, `resolve-error-with-draft.png`, `failure.png`.

These PNGs are review evidence only, not shipping product assets. The incumbent visual world, tokens, and sidecar remain unchanged. The local extension is recorded in `DESIGN.md` under Layout and Address Feedback.

Resolved threads use the shared muted card treatment and a checkmarked Resolved label in Feedback and inline diffs. Comment text remains readable; reopening restores active styling. Verified in light/dark Docker captures (`resolved-thread-light`, `resolved-thread-dark`). Changes file trees omit zero-comment badges; the Changes browser check verifies the icon does not leak onto line statistics.

Feedback-home refinement: Docker captures cover code beside conversation, conversation-first short laptops, full-file expansion, narrow navigation, Undo, and completion. The focused browser flow checks exact-thread navigation from Changes, draft preservation across tabs, no duplicated conversations, and failed-write recovery. Tokens and the existing visual system are unchanged.
