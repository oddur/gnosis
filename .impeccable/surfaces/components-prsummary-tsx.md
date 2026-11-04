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
