# Checks, reviews & discussions

Mode: Operate. Extends the existing PR/stack Summary; no new visual identity.

## Direction contract

THESIS: Show what is known about the displayed revision, with sources and explicit gaps. Evidence is not a merge verdict or an AI-generated confidence score.

OWN-WORLD: Preserve Gnosis typography, neutral surfaces, semantic status colors and Lucide icons. Use a compact disclosure and aligned text rows, not a dashboard of cards.

STORY: Scan checks and review freshness, expand to inspect provenance and discussions, then open the relevant check or GitHub review. Never imply a reproduction was run from CI success alone.

FIRST VIEWPORT: Standalone PRs place Checks, reviews & discussions above the description. Stacks lead with their dependency list and its per-PR review, check, and branch statuses; the detailed evidence disclosure follows the list, before the stack briefing. Preserve at least six complete PR rows at 1280×800 and three at 900×600 in the ordinary ready-stack fixture. Up to three concise signals remain visible while collapsed. Expansion replaces that rollup with PR-scoped rows, explicit displayed/reviewed commits, review submission time, and GitHub refresh time. The introduction names the task; named source actions make the next step clear. Missing data is unknown, never green.

FORM: Local extension of Summary, code-led; no concept seed needed. Checks and review metadata reuse existing subscriptions. Discussions load through the shared scheduler on expansion. No AI jobs or new polling loop in native builds. Refresh reuses existing PR status and discussion readers. Paused requests retain results and expose known retry timing; unchanged discussion observations publish their updated timestamp without increasing the polling rate.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
