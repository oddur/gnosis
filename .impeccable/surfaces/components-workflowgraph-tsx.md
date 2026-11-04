---
version: 1
slug: "components-workflowgraph-tsx"
primary_target: "components/WorkflowGraph.tsx"
related_targets: ["components/PrChecksView.tsx","src/workflow-graph-service.ts","src/workflow-definition.ts","src/globals.css"]
---

# Workflow dependency graph

Mode: Operate. Extend Checks within the existing Gnosis design system. Users review CI on laptop windows in light and dark themes.

THESIS: Show what is running or failed, and how workflow jobs depend on one another, without leaving the PR.

OWN-WORLD: Existing compact toolbar, searchable selectors, semantic check colors, workbench surfaces, readable 13px job names and 12px status/timing metadata. No new tokens.

STORY: Switch List to Graph; select a workflow (and source PR for stacks); inspect statuses and prerequisites; expand matrix/reusable groups; select a job to use existing output, steps, logs and rerun tools. Unknown mappings stay disconnected with an explanation.

FIRST VIEWPORT: The Checks toolbar keeps filters and refresh beside List/Graph. Graph uses available workspace width with a compact workflow/source row and a left-to-right pan-and-zoom canvas. Selecting a job opens the existing detail pane; Close restores the canvas width. Canvas resizing and topology changes reframe the graph; status-only refreshes preserve position and zoom. At ≤700px the detail pane stacks below the graph: selection reveals and focuses that region, and Close returns the viewport to the graph. Filter states dim other jobs but retain dependency context.

FORM: User-confirmed extension from the GitHub Actions screenshot, using React Flow and ELK. The backend parses workflow YAML at immutable run revisions and lays out declared prerequisites from left to right. Static matrices and reusable workflows form collapsible groups. Job status comes from actual run/check results; prerequisite failure is contextual evidence, not a guessed downstream status. Unavailable mappings stay disconnected, with a node label and dependency notice. No concept tournament; code-led implementation in the established surface.

RECOVERY: Keep the saved graph visible when a refresh fails. State that it is saved, expose the error and Retry workflow, and retain revision and freshness context. Workflow and stack source-PR changes close the old details and reset group expansion. External provider checks remain accessible in List.

FINISH: Ship verdict from the scoped finish reviewer on 2026-11-04. The reviewer inspected replacement laptop-detail and narrow captures plus the corrected code, and marked both prior findings resolved: graph clipping after the laptop detail pane opened, and narrow details remaining offscreen. This verdict covers the graph extension, not an application-wide audit.

## Reviewed evidence

The documenter compared the current components and appended workflow styles against PRODUCT.md, DESIGN.md, the existing sidecar, and seven browser captures in `.impeccable/review/workflow-graph/`: `desktop-light.png`, `detail-light.png`, `laptop-dark.png`, `laptop-detail-dark.png`, `narrow-dark.png`, `cached-error-dark.png`, and `stack-light.png`. The replacement laptop-detail and narrow captures show the corrected fit and detail-reveal behavior. `failure.png` is excluded.

The graph preserves the incumbent workbench's cool surfaces, semantic status colors, compact toolbar, searchable selectors, typography, and check-detail hierarchy in both themes. The left-to-right canvas adds dependency context within Checks. No new visual world, token changes, sidecar regeneration, or shipping raster assets were needed; these PNGs are browser review evidence.

Implementation-session QA reported: full suite 687 passed / 2 skipped; 17 workflow unit tests passed; graph and existing Checks browser flows passed; TypeScript and lint checks passed; macOS packaging passed. These results were supplied by the implementing agent, not rerun by the documenter.

## Limitations and existing drift

Screenshots establish the captured fixture states and sizes, not live GitHub data correctness or every workflow topology. At laptop detail widths the fitted graph becomes smaller; zoom controls remain available. Unsupported or ambiguous definitions must retain their explicit mapping notices rather than invent edges.

This scoped documentation adds graph behavior only. The existing DESIGN.md baseline commit reference and the older sidecar generation date remain unchanged; the pre-existing bulk-rerun paragraph remains after the Do/Don't list. These are existing documentation drift, not new graph token changes.
