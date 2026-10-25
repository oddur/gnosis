---
version: 1
slug: "components-d2diagram-tsx"
primary_target: "components/D2Diagram.tsx"
related_targets: ["components/SlideView.tsx", "components/DiagramViewport.tsx"]
---

# D2 explanation diagrams

Mode: Read within the existing explanation workspace. D2/TALA is the default for newly generated explanation diagrams. It preserves saved Mermaid diagrams.

## Direction contract

THESIS: A diagram explains a relationship or a change, with an inspectable overview and an intentional walkthrough instead of an overflowing illustration.

OWN-WORLD: Inherit the compact Gnosis workbench, semantic light/dark tokens, existing buttons and dialog. Diagram colors distinguish boundaries and active paths; icons identify component roles.

STORY: See the system, inspect the invariant, then follow the exchange or change with explicit previous/play/next controls. Source remains inspectable.

FIRST VIEWPORT: Explanation pane contains a fitted diagram, concise caption and playback controls when steps exist. Expanded view retains pan/zoom, step controls, and annotations. The real explanation workflow generates architecture, sequence and algorithm walkthroughs; a development-only gallery holds authored and model-generated fixtures.

FORM: Extension of the existing diagram viewer. Code-led integration of the approved prototype; no visual-world replacement. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implemented decisions

- The viewer reuses the existing Button, Dialog, and pan/zoom viewport. Bordered surfaces, surrounding typography, focus treatment, and light/dark colors follow the workbench. D2's SVG typography and diagram palette are scoped to diagram SVGs.
- A fitted preview opens an expanded diagram with readable annotations. Previous, Play/Pause, Next, Reset, and a step count support walkthroughs. Flow animation starts only after an explicit action; reduced motion suppresses visual animation. Source and render errors remain inspectable.
- Expanded annotations occupy a side column, then move below the diagram at narrow widths. Playback controls and captions remain beneath the inspection area. The development gallery and its responsive example navigation live in test fixtures.
- This incorporates the approved prototype without changing the surrounding design system. `DESIGN.md` records the adopted diagram pattern; its tokens and `.impeccable/design.json` remain unchanged. Technical behavior and limitations are recorded in `docs/d2-explanations.md`; historical research remains in `docs/research/`.

## Finish evidence

Prototype disposition: ship; the narrow gallery overlay finding is resolved. Documentation comparison checked `components/D2Diagram.tsx`, `lib/d2.ts`, `components/SlideView.tsx`, and the final D2 rules in `src/globals.css` against `PRODUCT.md`, `DESIGN.md`, and `.impeccable/design.json`.

Rendered evidence in `.impeccable/review/d2/`: `actual-explanation-slide.png`, `actual-explanation-expanded.png`, `light-Architecture.png`, `dark-Sequence.png`, and `sequence-narrow-dark-fixed.png`. These establish integration into the explanation pane, expanded annotations, both themes, and the narrow switcher fix. They do not establish production readiness or exhaustive accessibility coverage.

## Integration checks

Named board captions support source reordering; invalid optional output cannot break the narrative. The shared DiagramViewport preserves legacy Mermaid. Cached rendering avoids repeat work within the session; errors expose a local retry. Manual step changes and closing the expanded view stop playback and flow animation. Both preview and expanded frame changes respect reduced motion. Gallery imports and styles live in test fixtures, outside the application entry.

Integration disposition: SHIP, with no material findings from the finish reviewer. Documentation comparison checked `components/D2Diagram.tsx`, `components/DiagramViewport.tsx`, `components/SlideView.tsx`, `lib/d2.ts`, and the final D2 styles against `DESIGN.md`, `.impeccable/design.json`, and the behavior record in `docs/d2-explanations.md`. The implementation retains existing controls, border and surface roles, focus treatment, and surrounding type hierarchy. Diagram SVG fonts and palette remain scoped to the diagram.

Inspected captures in `.impeccable/review/d2-integration/`:

- `explanation-light-scrolled.png`: D2 remains within the real explanation pane beside source code.
- `generated-Sequence-expanded.png`: a generated sequence uses the shared expanded viewer, explicit playback, and its board caption.
- `generated-Algorithm.png`: concrete algorithm state appears with a readable caption and source disclosure in the development fixture.
- `expanded-narrow.png`: annotations move below the canvas while playback and captions remain visible.
- `legacy-mermaid.png`: a saved Mermaid diagram retains the shared fit, zoom, and pan viewer.

These captures support the adopted visual pattern and compatibility review. They do not establish explanation accuracy across arbitrary pull requests or exhaustive accessibility coverage. No unrelated design drift was repaired.
