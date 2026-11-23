---
version: 1
slug: "components-prsummary-tsx"
primary_target: "components/PrSummary.tsx"
related_targets: ["src/pages/HomePage.tsx","lib/stack-workspace.ts","components/StackOverview.tsx","components/StackBriefing.tsx"]
---

Mode: Operate. Extend the existing PR workspace and visual system.

## Direction contract

THESIS: Review queue → Stack → PR → tab. One explicit scope owns all tabs and actions; a stack overview never doubles as a selected PR description.

OWN-WORLD: Preserve Gnosis's cool neutral surfaces, blue selection, existing typography, status colors, compact dividers, shadcn controls, and both themes.

STORY: Understand the stack's intent and dependency order, find the PR needing attention, enter its complete workspace, and return without losing place. Names are local; comments and Viewed progress remain tied to PR revisions.

FIRST VIEWPORT: Compact breadcrumb, scoped heading/status and existing tabs. The stack summary shows briefing plus ordered PR rows with status, checks and cached file progress. A searchable scope switcher persists across tabs without adding a second full sidebar.

FORM: User-approved extension of the existing tabbed workspace. Stack identity survives completed members; filters identify matches without removing context. No alternate visual world. seed: none (user-pinned direction)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Acceptance

Separate stack and PR explanations, explicit generation only. Direct PR links retain parent context. Scope changes preserve tabs and per-scope positions. Opening the stack overview does not mark all members read. Local renaming must survive restart and not invalidate explanations. Completed stacks stay accessible through saved work, history and stars. Shared cached inventories supply progress without new GitHub calls. Verify laptop widths, keyboard, light/dark, empty and failed persistence states.

## Stack summary behavior

The scope switcher precedes the tabs and moves above them in narrow windows. Compact rows pair the PR number and title above dependency, status, checks, and file progress. A shared repository appears once in the heading. Mixed-repository stacks show the repository in each row.

The briefing area identifies missing, queued, generating, paused, failed, cancelled, and disconnected states. Generation requires an explicit action here. Running and queued briefings link to Activity. Failed and cancelled briefings offer retry when available. Paused briefings expose Activity and available generation actions. Detailed errors remain collapsed.

The heading and member rows share one clock for saved status freshness. The stack header shows one merge verdict and concise blocker counts. Per-PR review status, check results, and branch state form a labeled strip directly below that PR’s title and branch metadata. Viewed-file progress is secondary metadata beside the branches. The duplicate review-summary row and merge-status rail are removed.

The dependency list uses the full width. Each PR expands in place to show confirmed blockers, uncertain requirements, check results, and scoped actions. Optional cancelled checks and optional branch updates never join the blocker list. Fresh GitHub eligibility remains authoritative. Long check lists show three results before a disclosure for the rest. Ready PRs without warnings omit redundant details.

Below 620px of content width, the status strip becomes a vertical label/value list. Actions load permissions on demand, reuse the existing revision guards, and show explicit confirmation. Rerunning failed jobs and rerunning a cancelled workflow are distinct actions. Displaying the summary adds no permission or check-detail requests.


## PR summary layout — November 2026

The PR summary's reading path is identity and review decision → merge verdict and next action → compact GitHub evidence → author description. Merge readiness appears once on Summary and stays in the header on other tabs. The full stack overview retains its dependency-first layout.

The compact decision area retains freshness and blocker facts. Resolve conflicts stays visible when current signals report conflicts, even if permission data has not caught up. All PR actions are directly visible in a wrapping row below the merge verdict: Merge, auto-merge, Update with merge commit, Update with rebase, draft conversion or Mark ready, and permission refresh. Do not hide them in an overflow menu. Existing permissions, revision validation, and confirmations remain authoritative. Healthy ready-state boilerplate and the duplicate check/review/conflict rollup were removed.

Checks open the Checks tab. Review/discussion summaries expand details, with keyboard focus transferred to the evidence heading. Show details remains a stable disclosure. Unknown results use a question-mark icon. Discussions remain lazy; delayed, unavailable, and stale information stays explicit. Routine sync text is available to assistive technology without adding a permanent visible row.

Author description is followed alongside by a 260px metadata column. Change counts link to Changes. Saved AI briefings are collapsed and explicitly attributed. Stack context expands within the metadata column; its PR badges remain compact, titles wrap, and current-PR/source-branch context remains visible. Below 850px of content width, metadata follows the description. No new palette or typography was introduced.

Verification: PR summary, merge readiness, PR actions, review evidence, and Checks browser suites pass, covering both themes, laptop/narrow layouts, 200% evidence text, lazy sync, fresh/stale/error states, draft transitions, guarded merge/update confirmation, cached check details, and stack navigation. The layout regression keeps the author heading above 500px at 1280×800 and confirms stack expansion does not move it. TypeScript, focused lint, and 49 domain tests pass. Captures are under `.impeccable/review/pr-summary`, `merge-readiness`, `pr-actions`, and `review-evidence`. Independent rendered/source finish assessment: ship after focus, unknown-state icon, conflict-action, and sidebar badge fixes. No shipping raster assets were added.

User feedback refinement: the action overflow menu was removed. Separate update-method buttons keep both choices visible. PR action and summary browser suites pass, including visible-action, confirmation, permission, and laptop layout coverage.


## Stack overview layout — November 2026

Reading order: merge actions → Pull requests → labeled status and remedies per PR → supporting GitHub evidence → stack briefing. The merge-action panel has a heading above its action list. Group bulk rerun and Continue review beside the Pull requests heading. State dependency direction as “Dependent PRs first · base branch below”; it is not chronological order.

Each full overview row keeps title, branch metadata and viewed progress, labeled Review/Checks/Branch facts, and remedies together. No fixed-width right-hand status block. Required versus optional check failures remain explicit, and unknown requirements remain visible. The reusable compact StackContext layout is unchanged. Stack evidence omits repeated instructional prose and visually hides healthy background-sync boilerplate, retaining delayed, failed, and unavailable feedback.

Verification: two-PR draft/optional-failure case, ten-PR healthy stack, five complete healthy groups at 1280×800 and two at 900×600, mixed repositories at 640px, label visibility/proximity, briefing failure/retry/pause, hierarchy navigation and scope isolation, and review evidence browser suites pass. Thirty-six focused domain tests and TypeScript pass. Independent rendered layout review: ship. Captures: `.impeccable/review/stack-layout`, `stack-hierarchy`, and `review-evidence`. No shipping image assets added.


Stack-status clarification: replaced the ambiguous “Confirm merge requirements” group with explicit missing, stale, pending GitHub evaluation, and repository-hook explanations. The guidance panel shows ready/waiting/unconfirmed counts and confirmed-blocker counts from the existing stack status model, plus a refresh action through the existing scheduler. Known blockers precede uncertainty; shared reasons appear once. Verified with 16 readiness unit tests, TypeScript, focused lint, and the Docker stack-merge-details browser suite, including refresh behavior and narrow light/dark captures. Captures: `.impeccable/review/stack-merge-details/unknown-status-dark.png`, `unknown-status-light.png`, `unknown-status-narrow.png`, and `collapsed-light.png`.

## Address feedback

Feedback is the sole response workspace for PRs and stacks. Stack review blockers open the source review summary; Address code threads selects related unresolved discussions without leaving Feedback. Changes retains inline comments and provides Address feedback links to exact threads, with normal file/scroll restoration on return. Feedback uses the same full shared header as every other tab, with PR actions visible. Source PR identity remains explicit in the conversation header and list. Old coordinates never attach to current code. Completion distinguishes resolved discussions from required approval and offers explicit review requests.

## Stack overview table — November 2026

User feedback: the 12-PR overview was "all over the place, hard to read". Review, Checks and Branch values started at different x positions on every row, and defaults printed as loudly as problems. The list is now a table: fixed Review / Checks / Branch tracks named once in a column header, and status on the same line as each title. The body is bounded at 80rem. Defaults are quiet: a muted dash for no review decision or an up-to-date branch, passed counts without skipped tallies, and "N behind" for optional updates. Merged PRs recede, with no details disclosure. The spine replaces "into #parent" for adjacent parents. Viewed files show as a small bar. The heading summarises merged, attention and viewed counts. The header shows one "Merge status checked" note when both reads agree. Remedy links are no longer underlined at rest. Below 760px of list width, the strip moves under the title in shared tracks. Covered by the `--stack-overview` suite (column alignment, quiet defaults, attention states, narrow layout). Captures: `.impeccable/review/stack-overview`.

## PR header — November 2026 (#542)

Supersedes the action row of "PR summary layout": every PR action now lives in the header, the same on every tab, and Summary's readiness section is information only.

Two rows. Row 1: the title on one line (it truncates last), star, snooze and ⋯; on the right the PR's facts (repo · #number · state · author · updated), the review chip and the readiness chip. The facts drop under the title below about 1100px of header width or when they do not fit. Row 2: the stack's Back and member picker at the far left, the tabs, then the actions right-aligned: Draft and Auto-merge toggles (Auto-merge has a method chevron), the Update menu, Drafts, the review action, and Merge as a split button. Resolve conflicts takes Merge's place. Merged PRs show Delete branch… and Revert… (GitHub's revert, on the PR page); closed PRs show Reopen. Review PR stays on a finished PR while threads are unresolved.

One primary action: Merge when GitHub reports the PR ready and reviewed, Resolve conflicts when it conflicts, otherwise the review action ("Review PR", "Reply to feedback" when threads wait on you, "Request review…" on your own PR). Unavailable actions stay visible and say why in their tooltip (`aria-disabled`, so they keep focus).

The readiness chip is Summary's verdict, from the same reads and with the same priority: the most urgent blocker, with every reason, the checks, "Checked just now" and the GitHub link in its popover.

Toggles act at once on GitHub's current state, show the change optimistically, roll back on failure with Retry, and offer Undo in their toast. Merge's main part opens a short confirmation beside it (PR, method, target branch, optional commit message); nothing merges without a click or Enter on its focused Merge button. Multi-PR and native-stack merges keep the step card. Update and Delete branch keep their confirmation dialogs; Delete branch refuses while the branch has commits the PR does not.

Short of room, the toggles move to ⋯ first, then Update and Drafts; Merge and the review action always stay, and wrap onto their own row at about 760px. ⋯ also holds Open on GitHub and Refresh, which reads the actions again. Shortcuts, shown in the tooltips and the cheatsheet: ⌘⇧M opens the merge confirmation, ⌘⇧U the Update menu, ⌘⇧V the review action (outside text fields, where it still pastes). ⌘⇧R stays Force Reload.

The Overview's ready rows and stack merge details use the same split button, toggle and menu (components/PrActionControls.tsx). Changes hands its drafts to the header, so Drafts and Review PR never appear twice.

Verification: `--pr-actions`, `--readiness`, `--merged-state`, `--optimistic-actions`, `--overview`, `--stack-merge-details`, `--workspace-tabs`, `--sync-health` and `--header-stability` cover it; before-and-after captures at 1440/1280/1024/760 in both themes were approved by the user.
