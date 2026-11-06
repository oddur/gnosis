# Explorable explanation diagrams

Mode: Read / Operate. This extends the existing explanation pane and SVG player.

PRIMARY TARGET: components/DiagramExplorer.tsx
RELATED TARGETS: components/SvgIllustration.tsx, components/diagram-explorer.css, lib/svg-illustration.ts, lib/svg-illustration-document.ts

## Direction contract

THESIS: Give reviewers an authored picture they can inspect without changing its visual language or losing their place.

OWN-WORLD: Retain Gnosis typography, semantic colors, source navigation, restrained controls, and the explanation/code split. No new global design tokens or visual identity.

FIRST VIEWPORT: A complete custom SVG follows the short explanation. Components and connections can be selected. A quiet hint explains inspection; an Explore button opens the larger view. The diagram must teach before the reader clicks anything.

SIGNATURE INTERACTION: Select a component in the authored drawing to see its responsibility, direct relationships, and supporting code. The same drawing expands into a React Flow viewport with an inspector beside it. Selection preserves component positions and viewport. A source action returns to the code pane. Narrow windows put the inspector below the canvas and refit the drawing.

MOTION: Keep the existing controlled SVG playback for meaningful sequences or transformations. Static maps need no playback controls. Participants remain fixed across frames. Reduce motion, preserve paused-state meaning, and never imply that playback measures runtime.

CONTENT: Favor component responsibilities, architecture, sequence and dataflow when they match the reader's missing understanding. Retain bespoke SVG for local algorithms. Do not create an entire-codebase inventory or populate boxes with API documentation. Show changed versus contextual components explicitly when source establishes that distinction.

TRUTH: Directed relationships are authored claims grounded in supplied source, not inferred execution paths. Inspection reads the saved artifact and makes no API or model request. Source actions appear only where their anchors resolve. Safety validation and model critique do not prove educational quality; retain evaluation artifacts and compare them visually.

## Evaluation scope

The isolated gallery uses real, pinned Gnosis source for priority promotion, cache clearing, and explanation generation. It is an evaluation of existing code rather than a fabricated PR diff. A separate authored fixture tests interaction behavior. Docker browser checks cover geometry, sandbox IDs, stable participants, pointer and keyboard selection, source navigation, resizing, and themes. The earlier SVG player receives regression coverage.

## Implemented constraints

The expanded view uses the existing background, card, border, primary, accent, and focus-ring variables. The inspector is 270px wide with a 20px inset. Its heading is 15px, its summary 14px, and supporting labels 12px. These are local component choices, not additions to the global type scale.

At viewport widths of 760px or less, the inspector follows the 340px canvas and scrolls within a 240px maximum height. Zoom and Fit controls occupy a separate bordered footer below the viewport. Keep that footer outside the drawing area so controls cannot obscure authored labels or connections.

The latest generated examples are a priority component map, a cache sequence, and a generation dataflow. The initial examples were static. A composition pass added a three-frame priority walkthrough. Later screenshot-driven iteration replaced it with a static causal path; cache and pipeline remain static. The separate generation evaluation records acceptance, rejected candidates, and remaining educational limitations. The examples demonstrate possible outputs, not required templates.

## Finish evidence

The independent finish reviewer inspected all 16 captures in `.impeccable/review/diagram-exploration/`, including inline, expanded, selected, light/dark desktop, and the 620px narrow fixture. The initial material finding was viewport controls overlapping drawing content. Moving those controls to a separate footer resolved it. The final verdict was pass, with disposition **ship at the scope of the scored fix**; this is not a blanket assessment of educational quality.

Typecheck, scoped ESLint, and 15 focused unit tests passed. The final Docker diagram-exploration and existing SVG-player browser suites passed; the session log is `/tmp/gnosis-diagram-final-verification.log`. The screenshot directory and session log are local verification evidence, not durable research artifacts. Generated source snapshots, candidates, and contact sheets remain under `docs/research/generated-architecture/`.

After the finish review, the gallery source pane gained TypeScript syntax highlighting with GitHub light/dark themes, computed in a worker with a bounded source cache. Source-evidence navigation remains intact. The Docker exploration suite passed again, including an assertion that rendered source has at least three syntax colors; all exploration screenshots were refreshed. The follow-up log is `/tmp/gnosis-diagram-highlight-check.log`. This follow-up check does not extend the earlier independent visual-review verdict.

Run `npm run diagrams:architecture` to open the isolated gallery at `http://127.0.0.1:5173/tests/fixtures/mechanisms.html?architecture`. Select a component, inspect a direct connection, then use Explore, zoom, and Fit to inspect the same composition. See `docs/animated-svg-explanations.md` for evaluation commands.

This is an ordinary extension. DESIGN.md and its sidecar remain unchanged. Its pre-existing explanation-diagram section still centers the legacy D2 viewer; the SVG implementation guide and this brief describe the current extension without treating that older coverage as a new global rule.
