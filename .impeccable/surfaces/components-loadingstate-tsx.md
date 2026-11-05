---
version: 1
slug: "components-loadingstate-tsx"
primary_target: "components/LoadingState.tsx"
related_targets: ["components/WorkflowGraphState.tsx", "components/LoadingScreen.tsx", "components/PrChangesView.tsx", "components/PrCommitsView.tsx", "components/SettingsDialog.tsx", "src/globals.css"]
---

# Shared loading feedback

Mode: Operate. Preserve the compact Gnosis workbench and its light/dark themes.

THESIS: Make unavoidable waits visibly active and understandable without replacing available content.

PATTERN: Empty panes use the Checks graph's three-node moving signal with a short operation title. Small file panels use a compact spinner and title. Inline operations and refreshes use a spinner beside their actual status. Existing chat and Activity progress remain intact.

BEHAVIOR: Render results immediately when ready. No artificial delays, extra requests, simulated percentages, or invented generation phases. Keep cached content visible during refreshes. Stop motion when hidden or offscreen; respect reduced motion. A single shared observer avoids one observer per file. Announce operation text, not elapsed seconds.

EVIDENCE: Docker loading-state checks cover a delayed Settings read and dismissal, light/dark laptop captures, compact layout, 200% zoom, reduced motion, offscreen animation pause, and completion. Revision-preload checks verify cached first-open Changes/Commits and pinned revisions. Workflow graph checks cover its loading, refresh, and error transitions. Screenshots live under `.impeccable/review/loading-states/` and are generated review artifacts.
