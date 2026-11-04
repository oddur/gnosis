---
version: 1
slug: "components-workflowgraph-tsx"
primary_target: "components/WorkflowGraph.tsx"
related_targets: ["components/WorkflowSidebar.tsx","components/WorkflowViewMenu.tsx","components/WorkflowDetailNavigation.tsx","components/PrChecksView.tsx","components/PrSummary.tsx","lib/workflow-navigation.ts","lib/workflow-graph.ts","src/workflow-graph-service.ts","src/workflow-definition.ts","src/globals.css"]
---

# Workflow dependency graph

Mode: Operate. Extend Checks within the existing Gnosis design system. Users review CI on laptop windows in light and dark themes.

THESIS: Show what is running or failed, and how workflow jobs depend on one another, without leaving the PR.

OWN-WORLD: Existing compact toolbar, searchable workflow sidebar and source-PR selector, semantic check colors, workbench surfaces, readable 13px job names and 12px status/timing metadata. No new tokens.

STORY: Switch List to Graph; select a workflow (and source PR for stacks); inspect statuses and prerequisites; expand matrix/reusable groups; select a job to use existing output, steps, logs and rerun tools. Unknown mappings stay disconnected with an explanation.

FIRST VIEWPORT: Checks keeps a compact PR identity above one shared wrapping toolbar. Its coherent groups contain the icon-labelled List/Graph segmented toggle, source-PR selector, Workflows toggle, selected workflow name and GitHub link, View, All jobs/Needs attention/Running highlights, Next issue only when issues exist, External checks, freshness, bulk rerun, and refresh. The toggle retains its shared bordered surface and blue accent and ring border for the selected `aria-pressed` state. Sidebar workflow rows show status and job totals; highlight counts describe the current graph scope. The toolbar remains accessible above open details. Toolbar groups wrap as space requires, including for a long selected workflow name or the extra stack selector. At viewport widths ≤1450px, the freshness clock retains its checked-time title and screen-reader text; wider layouts display that text inline. Visibility and grouping live inside View; zoom, Readable size, Fit entire workflow, and the minimap sit on the canvas. Details open beside a wide canvas, overlay its right side at ≤1050px of workspace width, and cover it at ≤700px. Selection focuses details; Close or Escape restores the selected graph job, then the originating control or Graph as fallback. Both overlay layouts make the underlying graph inert. Sticky details retain Previous/Issue n of m/Next and expandable Needs/Feeds context. Graphs start at readable scale. Status-only refreshes preserve position and zoom; topology and canvas-size changes reframe the graph. Filters emphasize surfaces and edges while preserving full-contrast job text and dependency context.

FORM: User-confirmed extension from the GitHub Actions screenshot, using React Flow and ELK. The backend parses workflow YAML at immutable run revisions and lays out declared prerequisites from left to right. Static matrices and reusable workflows form collapsible groups. Job status comes from actual run/check results; prerequisite failure is contextual evidence, not a guessed downstream status. Unavailable mappings stay disconnected, with a node label and dependency notice. No concept tournament; code-led implementation in the established surface.

RECOVERY: Keep the saved graph visible when a refresh fails. State that it is saved, expose the error and Retry workflow, and retain revision and freshness context. Workflow and stack source-PR changes close the old details and reset group expansion. External provider checks remain accessible in List.

FINISH: The fresh independent finish review returned ship on 2026-11-04, covering all five review-contract sections with no material fixes. A general subagent applied the finish-reviewer contract because no registered reviewer type was available; no quality board ran. This is an ordinary Operate refinement of the existing workbench and a surface-scoped review, not a full application audit.

## Current behavior and evidence

The workflow dropdown is replaced by a 260px left sidebar on desktop. Full names wrap and sort alphabetically; each row pairs its status icon with text and a job total. Duplicate names show file/event context. Cached API totals are exact for each run attempt; matching revision/attempt check evidence yields provisional N+ counts, while unknown totals display “Jobs: —”. Local search matches name, path, and event. Arrow keys, Home, and End move focus only; Enter selects. Close or Escape restores toggle focus. Desktop defaults open with multiple workflows; at viewport widths ≤1000px it defaults closed and opens as an overlay drawer with the graph inert. Manual open/closed state persists with the workflow session, and selecting a workflow closes the compact drawer. The source-PR dropdown remains.

Without a saved selection, Graph starts with the first PR needing attention and prefers a workflow needing attention, then an active run, then a healthy completed run. Needs attention frames the first affected job. Next issue cycles through affected jobs, expands their group when needed, and opens the existing check details. A sticky detail toolbar adds Previous and Next with Issue n of m, plus an expandable Needs/Feeds summary of named prerequisites and dependants with reported status. Closing details or pressing Escape from its controls restores focus to the current selected job, including after issue navigation. Running frames the first active job. Counts and empty messages describe the current graph scope, including dependency focus. External checks opens that PR’s provider checks in List.

The graph stays mounted during List detours. Returning restores the selected graph job. Account/revision-scoped session state retains source PR, workflow run, sidebar open/closed choice, expansion, visibility, dependency focus, and viewport. Grouping remains a saved preference. The View popover puts keyboard and graph help first, followed by Show skipped and Show passed and neutral checkboxes, descriptive Adaptive, Compact, and Off radio choices, and source metadata. Help names the visible Show dependencies action. These replace the previous always-visible visibility row and searchable grouping selector. Group eligibility and topology safety rules remain unchanged.

Dependency focus preserves direct prerequisites outside the visible scope as named status evidence. Failed outside prerequisites appear on affected cards and in the scope notice; Reveal restores the full cached workflow and frames the prerequisite. Visibility compaction retains cards carrying that evidence. Filters and dependency tracing emphasize surfaces and paths without reducing whole-card opacity. The minimap distinguishes attention and running states with existing semantic colors; accessible edge names read “target requires source.”

Individual failed-job cards reserve 232px during layout, before annotation arrival. They show the failed step, the first unique failure annotation excerpt capped at three lines, and a count/action opening full details; notice annotations do not appear on graph cards. Details must match the exact job, run, attempt, and revision. The existing details preloader prioritizes failures and starts immediately when a snapshot is observed. The graph consumes that shared cache without its own network loop. Opening details reads cached content first; refresh retains the content and adds a small header spinner with accessible status.

Node context menus open by right-click, Shift+F10, or the context-menu key. They offer details/group expansion, dependencies, and GitHub; individual jobs also offer “Re-run failed jobs in workflow” and “Re-run entire workflow.” Reruns are disabled for running jobs/workflows, pending/requested reruns, and known read-only access. Existing backend permission and revision guards remain in force, with request/error feedback in the graph workspace.

The documenter inspected the changed graph, detail navigation, View menu, Checks pane, navigation, focus and visibility code, and final workflow styles against PRODUCT.md and DESIGN.md. All seven current captures in `.impeccable/review/workflow-graph/` were opened and visually validated: `laptop-detail-dark.png`, `narrow-dark.png`, `narrow-controls-dark.png`, `dependencies-focus-dark.png`, `desktop-light.png`, `grouping-menu-dark.png`, and `detail-light.png`. They show sticky issue navigation in both themes, laptop and full-width detail overlays, wrapping narrow controls, help-first View options, and outside-prerequisite evidence. The underlying graph is inert whenever details overlay it at ≤1050px of workspace width.

Builder-reported validation: 717 unit tests passed, including 42 workflow tests; TypeScript, focused lint, and diff checks passed; graph and existing Checks browser suites passed. The final graph run also verified Escape from the portalled Next button. The changed-component detector returned `[]`. The documenter did not rerun those checks. Final independent review returned ship with no material fixes, using the general-agent reviewer contract without a separate quality board.

These captures verify fixture states and dimensions, not live GitHub correctness or all workflow topologies. Large workflows require panning at readable scale; a laptop overlay can obscure part of the graph while details are open. Unsupported mappings keep their explicit notices. No new visual world, token changes, sidecar regeneration, or shipping raster assets were needed. The existing DESIGN.md baseline reference, sidecar date, older CSS declarations overridden by the final graph block, and unrelated detector advisories remain outside this surface documentation pass.

Toolbar follow-up: the documenter inspected the shared-toolbar diff and six fresh captures: `desktop-light.png`, `wide-toolbar-light.png`, `laptop-dark.png`, `laptop-detail-dark.png`, `narrow-controls-dark.png`, and `grouping-menu-dark.png`. These verify the wrapping groups, compact/wide freshness treatment, and controls above details. Builder-reported TypeScript, focused lint, graph and Checks browser suites passed; the detector returned `[]`. The fresh independent toolbar reviewer returned ship with no material findings. Tokens, sidecar, and historical records remain unchanged.

Sidebar follow-up: the documenter inspected `WorkflowSidebar.tsx`, the graph integration, count helper, final sidebar styles, and `workflow-sidebar-light.png`, `workflow-sidebar-dark.png`, and `workflow-sidebar-compact-dark.png` in `.impeccable/review/workflow-graph/`. The captures show wrapped names, alphabetical rows, status/count evidence, selected/focused states, and the compact overlay. Builder-reported validation: 719 unit tests, including 44 workflow tests, TypeScript, and graph and Checks browser suites passed. The fresh independent `workflow_sidebar_finish` reviewer returned ship with no material issues. The documenter did not rerun tests or browsers; tokens, sidecar, and historical records remain unchanged.

Annotation/context-menu follow-up: the documenter inspected the changed graph, Checks details, annotation matching, layout reservation, and final CSS. Opened captures in `.impeccable/review/` were `workflow-graph/failure-annotation-light.png`, `workflow-graph/failure-annotation-dark.png`, `workflow-graph/failure-annotation-compact-dark.png`, `workflow-graph/job-context-menu-light.png`, and `pr-checks/cached-refresh-light.png`. They show reserved failure-card context in both themes, compact rerun feedback, the node menu, and retained detail content with a refresh spinner. Builder-reported validation: 722 tests, TypeScript, source lint, and graph and Checks browser suites passed. The fresh independent `workflow_annotations_finish` reviewer returned ship with no material fixes. The documenter did not rerun tests or browsers; tokens, sidecar, and historical records remain unchanged.

## Historical implementation and verification records

The following records preserve earlier implementation evidence and reported test totals. Their control placement, detail layout, and initial framing descriptions are historical; current behavior is defined above. Capture filenames reused by later passes now show the current implementation and do not independently preserve the earlier appearance.

### Initial reviewed evidence

The initial scoped finish reviewer returned ship on 2026-11-04 after inspecting replacement laptop-detail and narrow captures plus corrected code. It marked the prior laptop graph-clipping and offscreen narrow-detail findings resolved under the layout then in use.

The documenter compared the current components and appended workflow styles against PRODUCT.md, DESIGN.md, the existing sidecar, and seven browser captures in `.impeccable/review/workflow-graph/`: `desktop-light.png`, `detail-light.png`, `laptop-dark.png`, `laptop-detail-dark.png`, `narrow-dark.png`, `cached-error-dark.png`, and `stack-light.png`. The replacement laptop-detail and narrow captures show the corrected fit and detail-reveal behavior. `failure.png` is excluded.

The graph preserves the incumbent workbench's cool surfaces, semantic status colors, compact toolbar, searchable selectors, typography, and check-detail hierarchy in both themes. The left-to-right canvas adds dependency context within Checks. No new visual world, token changes, sidecar regeneration, or shipping raster assets were needed; these PNGs are browser review evidence.

Implementation-session QA reported: full suite 687 passed / 2 skipped; 17 workflow unit tests passed; graph and existing Checks browser flows passed; TypeScript and lint checks passed; macOS packaging passed. These results were supplied by the implementing agent, not rerun by the documenter.

### Limitations and existing drift

Screenshots establish the captured fixture states and sizes, not live GitHub data correctness or every workflow topology. At laptop detail widths the fitted graph becomes smaller; zoom controls remain available. Unsupported or ambiguous definitions must retain their explicit mapping notices rather than invent edges.

This scoped documentation adds graph behavior only. The existing DESIGN.md baseline commit reference and the older sidecar generation date remain unchanged; the pre-existing bulk-rerun paragraph remains after the Do/Don't list. These are existing documentation drift, not new graph token changes.

### Readability follow-up

The user’s live workflow exposed edges passing behind unrelated job cards. Layout now preserves ELK’s orthogonal route points with distinct incoming and outgoing attachment points. The renderer rounds the routed corners without changing the path. Hover and keyboard focus highlight immediate dependencies and dim unrelated cards and edges. Duplicate job/definition names are omitted; active steps, group counts, and prerequisite failures remain.

Rendered evidence: `routing-fanin-dark.png` recreates the reported five-job shape; `routing-focus-dark.png` shows dependency tracing. Updated laptop-detail, desktop, narrow, and stack captures retain the existing responsive layout. The focused suite passes 18 tests, including orthogonal routes, unrelated-card clearance, distinct ports, and deterministic geometry. The graph browser suite, TypeScript, and focused lint pass. The final layout detector reports no findings on the changed targets. A fitted graph is still smaller when details take half a laptop window; zoom controls remain available.

Independent finish review: ship for this scoped routing fix. The reviewer inspected the original screenshot, four current captures, and routing code. Its nonblocking focus finding was corrected by tracking pointer hover and keyboard focus separately. Dense topologies beyond the captured fixture remain outside this visual verification.

### Job visibility controls

Show skipped and Show completed are independent, initially enabled controls above the canvas. Completed covers success and neutral outcomes. Failed, cancelled, active, mixed-state, and unreported groups remain visible. Hidden jobs use 48px-high count summaries; only identical original incoming/outgoing dependency sets can share one. Summaries keep arrows, job-name tooltips, mapping notices in their titles, and count-aware accessible labels. Clicking a summary restores its category. The backend compacts and routes cached data; the renderer refreshes handle geometry when ports change.

Verification: 21 workflow tests pass, including topology preservation, unsafe-to-hide states, compact ports, and cache reuse without GitHub requests. Browser coverage compacts a 23-job fan-out to six cards, verifies all eight dependency paths, keeps failed/running cards visible, and restores skipped jobs from a summary. `visibility-collapsed-dark.png` captures that result. TypeScript, focused lint, and the layout detector pass. This verifies the fixture, not every live workflow or missing dependency mapping.

### Large workflows and dependency focus

The earlier fit-to-window behavior is superseded: graphs open at 1:1 scale. Each axis that fits is centered independently; overflowing overviews start at the top, and focused/selected jobs stay readable. Fit entire workflow is explicit. Readable size restores full text size. The minimap supports panning and zooming. Viewport controls share the visibility row; compact panes keep a 180px minimum canvas.

Parallel stages use the saved Adaptive, Compact, or Off choice described below; this supersedes the original three-node automatic grouping default. Job focus shows ancestors and descendants separately, so siblings do not enter through common prerequisites. Back to workflow leaves focus. Unrelated group-collapse controls are omitted inside focus.

Skipped reusable workflows map to their exact caller names when unambiguous. Expanding a mixed matrix preserves skipped caller variants beside executed children. Replaying the user’s cached run changed 18 unmatched jobs plus 18 empty placeholders into 25 correctly matched jobs, presented as seven top-level cards (one stage contains 19 parallel jobs). That local replay is not checked in. Existing warnings about unavailable source definitions remain explicit.

Verification: 29 workflow tests cover mapping, expansion, status safety, topology, focused paths, and readable framing. Browser checks cover stage expansion/collapse, focus/back, explicit fit/readable controls, stable status updates, visibility toggles, and laptop/narrow detail panes. Captures include `stages-dark.png`, `stages-expanded-dark.png`, `dependencies-focus-dark.png`, and optional cached-run replay captures. Large workflows intentionally require panning at readable scale; screenshots do not establish every possible topology.

Independent finish review: ship. Source review and final captures confirm all four focused jobs fit at 1280×800 and the replayed 25-job workflow has seven readable cards at 1920×1080. The review found and verified fixes for dropped skipped matrix variants, hidden unknown stage members, and viewport framing. The reviewer did not independently rerun the reported checks.

### Workflow cache and local navigation

Expanding groups, focusing dependencies, and changing visibility now project saved workflow data without a network revalidation. Check freshness and explicit refresh own network updates independently; a refresh finishing during navigation applies to the current view. If saved data was evicted or cleared, the existing Retry workflow action reloads it explicitly.

Parsed files are cached by immutable source revision and caller inputs. Resolved definition trees also include the run’s pinned reusable-workflow revisions in their cache identity. Resolution copies cached parses so callers cannot mutate one another. Permanent definition warnings do not refetch completed jobs; transient fetch failures remain retryable. Workflow sources, parses, resolved trees, run data, and layouts use the configurable SQLite content-cache budget, including entries larger than the metadata memory limit.

The old 20-reference limit counted repeated files. Resolution now counts distinct immutable sources (50 maximum), with independent limits of ten nesting levels and 500 calls plus cycle detection. The reported run resolves 21 distinct files without warnings. Browser regression tests assert no network-capable graph requests during navigation and retain the chosen expansion when a pending refresh finishes. Validation: 34 workflow tests and 46 combined workflow/cache tests pass, along with graph browser checks, TypeScript, and focused lint.


### Cold-load responsiveness

The open Checks workspace warms its first PR’s default workflow. Preparation respects the API reserve and replaces queued targets when navigating. Cold graph requests take interactive priority; cached refreshes keep lower priority. Jobs and independent workflow sources overlap through a three-read HTTP limit. Request starts remain paced and rate-limit responses stop subsequent dispatch. Ordinary traffic and mutations remain serialized.

### Adaptive parallel grouping

Parallel jobs sits beside the visibility controls and reuses the searchable selector. Adaptive is the saved default. It leaves graphs of 16 or fewer nodes open. Above that count, it groups eligible sets of at least six nodes, largest first, until the planned count is 16 or fewer or no eligible sets remain. Compact groups eligible sets of at least three; Off disables inferred parallel stages. Eligibility requires identical original predecessor/successor sets, at least one dependency connection, and only finished successful, neutral, or skipped jobs. Active, failed, cancelled, unknown, and mixed groups stay separate. Matrix and reusable-workflow groups expand independently in all modes.

Grouping depends on workflow complexity, not viewport size. Stage selection happens before manual expansion, so opening a stage cannot cause another stage to collapse. Mode changes project existing prepared workflow data without GitHub requests. The choice persists in local preferences; if saving fails, the session choice remains active with an inline explanation. The controls wrap at narrow widths while retaining their labels and the existing readable-size and fit actions.

Scoped evidence: the documenter inspected `components/WorkflowGraph.tsx`, `src/workflow-stages.ts`, and current `desktop-light.png`, `grouping-menu-dark.png`, and `narrow-controls-dark.png` captures in `.impeccable/review/workflow-graph/`. They show the selector in the existing workbench control row, its three choices in dark theme, and wrapped controls at narrow width. The incumbent tokens and sidecar remain unchanged.

Implementation-session verification supplied for this refinement: 39 workflow tests passed; the full unit suite passed 714 tests with no failures; TypeScript and lint passed. Graph browser coverage passed for grouping choice, persistence, no network requests on mode changes, and responsive sizes. The layout detector returned no findings. The documenter did not rerun these checks. Independent scoped finish review returned ship with no material fixes. These results cover the tested fixtures and changed surface, not every live workflow topology.

## Failure visibility

Matrix and reusable-workflow groups automatically expand when a descendant needs attention, including nested calls. These groups offer no collapse action while the failure remains. Failed, cancelled, timed-out, and action-required jobs retain individual cards and dependency edges in every grouping mode, including with completed/skipped jobs hidden.
