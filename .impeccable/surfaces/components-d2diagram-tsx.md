---
version: 1
slug: "components-d2diagram-tsx"
primary_target: "components/D2Diagram.tsx"
related_targets: ["src/pages/D2PrototypePage.tsx"]
---

# D2 diagram prototype

Mode: Read within the existing explanation workspace. This throwaway branch evaluates local D2/TALA rendering and explanation quality. It preserves saved Mermaid diagrams.

## Direction contract

THESIS: A diagram explains a relationship or a change, with an inspectable overview and an intentional walkthrough instead of an overflowing illustration.

OWN-WORLD: Inherit the compact Gnosis workbench, semantic light/dark tokens, existing buttons and dialog. Diagram colors distinguish boundaries and active paths; icons identify component roles.

STORY: See the system, inspect the invariant, then follow the exchange or change with explicit previous/play/next controls. Source remains inspectable.

FIRST VIEWPORT: Explanation pane contains a fitted diagram, concise caption and playback controls when steps exist. Expanded view retains pan/zoom, step controls, and annotations. A prototype gallery offers architecture, sequence and change examples without GitHub or model calls.

FORM: Extension of the existing diagram viewer. Code-led engine prototype; no visual-world replacement. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implemented decisions

- The viewer reuses the existing Button, Dialog, and pan/zoom viewport. Bordered surfaces, surrounding typography, focus treatment, and light/dark colors follow the workbench. D2's SVG typography and diagram palette remain local to this prototype.
- A fitted preview opens an expanded diagram with readable annotations. Previous, Play/Pause, Next, Reset, and a step count support walkthroughs. Flow animation starts only after an explicit action; reduced motion suppresses visual animation. Source and render errors remain inspectable.
- Expanded annotations occupy a side column, then move below the diagram at narrow widths. The gallery becomes one column at 900px; its fixed example switcher is hidden there to avoid covering content. Example tabs remain available.
- This is a throwaway engine evaluation, not a new design system. Preserve `DESIGN.md` and `.impeccable/design.json`. Technical behavior and limitations are recorded in `docs/research/d2-prototype.md` and `docs/research/d2-tala-evaluation.md`.

## Finish evidence

Prototype disposition: ship; the narrow gallery overlay finding is resolved. Documentation comparison checked `components/D2Diagram.tsx`, `lib/d2.ts`, `src/pages/D2PrototypePage.tsx`, and the final D2 rules in `src/globals.css` against `PRODUCT.md`, `DESIGN.md`, and `.impeccable/design.json`.

Rendered evidence in `.impeccable/review/d2/`: `actual-explanation-slide.png`, `actual-explanation-expanded.png`, `light-Architecture.png`, `dark-Sequence.png`, and `sequence-narrow-dark-fixed.png`. These establish integration into the explanation pane, expanded annotations, both themes, and the narrow switcher fix. They do not establish production readiness or exhaustive accessibility coverage.
