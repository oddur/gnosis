---
version: 1
slug: "components-d2diagram-tsx"
primary_target: "components/D2Diagram.tsx"
related_targets: ["components/SlideView.tsx", "components/DiagramViewport.tsx", "lib/d2-presentation.ts", "lib/d2-label-changes.ts"]
---

# D2 explanation diagrams

Mode: Read within the existing explanation workspace. D2/TALA is the default for newly generated explanation diagrams. Saved Mermaid diagrams retain their renderer.

## Direction contract

THESIS: Each step gives one takeaway and points to the exact changed value on a stable diagram. Before/after comparison supports that causal explanation.

OWN-WORLD: Inherit the compact Gnosis workbench, semantic light/dark tokens, existing buttons, and dialog. Diagram colors distinguish boundaries and active paths. Icons identify component roles.

STORY: Read the overview, select a named step, understand its action and consequence, then inspect supporting code when an anchor resolves.

FIRST VIEWPORT: The explanation pane contains a fitted diagram, named navigation, a takeaway heading, and a short explanation. Changed values have a persistent underline and one brief opacity pulse. The full change list starts collapsed. Expansion places that explanation beside the canvas, or below it at narrow widths. Additional notes start collapsed.

FORM: Ordinary extension of the existing diagram viewer. Code-led integration preserves the approved workbench system. No visual-world replacement or new system tokens.

FINISH: The build ends with an independent finish review, a verdict, and documentation grounded in the implementation. No shipping raster assets were added.

## Implemented decisions

- The viewer reuses Button, Dialog, and DiagramViewport. Borders, surfaces, focus treatment, and surrounding type retain the workbench system. SVG typography and diagram colors remain scoped to the diagram.
- Named buttons and Previous/Next controls support manual inspection. Explicit `walkthrough` diagrams also offer optional auto-play at 6.5-second intervals. Maps, comparisons, and older diagrams without `kind` use named views without auto-play.
- Exact node and connection identifiers select focus on a compiled board. Focus changes preserve layout and zoom. Clicking an entity in the expanded viewer selects the first matching step. A node also matches focus on an incident connection. Keyboard users use the navigation buttons.
- Native boards represent actual state changes or alternative outcomes. Adjacent boards in authored view order expose compiled label changes and added or removed entities. The comparison does not depend on navigation direction. The viewer does not simulate algorithm state beyond compiled labels.
- Inserted or replaced words and values receive a persistent underline and one 450ms opacity pulse. This treatment preserves compiled coordinates, font metrics, and line breaks. Reduced motion keeps the underline without the pulse. Removed text remains in the collapsed “Changes in this step” list. Unsupported SVG labels, including labels drawn as paths, retain the entity outline without guaranteed marks on individual words or values.
- Generation guidance asks for a takeaway title and one short sentence explaining the constraint or consequence. An optional change adds only an essential concrete value or action absent from both. The viewer suppresses exact duplicate prose. The supporting-code link appears only for a resolvable `filePath` and `startLine` in the current slide. Additional tooltip notes start collapsed.
- The expanded explanation occupies a side column and moves below the diagram at narrow widths. Navigation remains available in both layouts. Reduced motion removes animation and transitions.
- Manual navigation, Pause, dialog dismissal, source navigation, and window hiding stop auto-play and flow animation. Source disclosure and local retry preserve recovery from rendering errors.
- Compiled output is cached by source and theme, separately from presentation metadata. Focus and caption changes do not recompile or rewrite source. Existing saved diagrams gain the rendering changes without regeneration. Improved generated prose and richer metadata require regeneration.

Technical behavior and limits appear in [D2 explanation diagrams](../../docs/d2-explanations.md). DESIGN.md records the adopted component pattern. Its tokens and `.impeccable/design.json` remain unchanged.

## Finish evidence

Integration disposition: SHIP, with no material findings from the independent finish reviewer.

Documentation comparison covered `components/D2Diagram.tsx`, `components/DiagramViewport.tsx`, `components/SlideView.tsx`, `lib/d2-presentation.ts`, `lib/diagram-spec.ts`, `lib/types.ts`, `lib/d2-guidance.ts`, and `lib/d2.ts`. The final D2 styles preserve the system in PRODUCT.md, DESIGN.md, and `.impeccable/design.json`.

The finish pass reported 288 passing tests, the diagram browser suite, TypeScript, and targeted ESLint checks. A fresh synthetic sequence from the live writer compiled with exact focus identifiers. The accepted response remains in `tests/fixtures/d2-generated.json`.

Reviewed captures in `.impeccable/review/d2-integration/`:

- `sequence-expanded-dark.png`: named steps and the active explanation beside the sequence in Dark.
- `expanded-narrow.png`: the explanation moves below the canvas while navigation remains available.
- `light-Sequence.png`: the sequence preview and guidance in Light.
- `generated-Sequence-expanded.png`: the fresh generated sequence in the shared expanded viewer.
- `explanation-light-scrolled.png`: D2 within the real explanation pane beside source code.

These captures support the adopted visual pattern and tested integration. They do not establish explanation accuracy across arbitrary pull requests or exhaustive accessibility coverage.

The detector reported only preexisting global CSS advisories outside the changed blocks, with no new findings. This ordinary extension neither records those advisories as system rules nor repairs unrelated design drift.

### Step-insights refinement

The independent finish reviewer returned SHIP with no material fixes. The reported checks passed: 11 diagram unit tests, the Electron D2 browser suite, TypeScript, and targeted ESLint.

Documentation comparison covered the diff from `4f0974b`, including `components/D2Diagram.tsx`, `lib/d2-presentation.ts`, `lib/d2-label-changes.ts`, `lib/d2-guidance.ts`, and the D2 blocks in `src/globals.css`. The comparison also covered diagram unit tests, browser assertions, and the capacity fixture. PRODUCT.md, DESIGN.md, and `.impeccable/design.json` remain the incumbent system references.

The finish reviewer inspected these captures in `.impeccable/review/d2-integration/`:

- `step-insights-light.png` and `step-insights-dark.png`: the takeaway, changed values, and collapsed details in the preview.
- `step-insights-expanded-light.png` and `step-insights-expanded-dark.png`: the explanation beside the expanded canvas.
- `step-insights-expanded-narrow.png`: the explanation below the canvas at a narrow width.

This evidence establishes behavior for the tested fixture, not arbitrary model output quality. The detector report at `/tmp/gnosis-step-insights-design-check.json` contains 96 existing global CSS advisories. None concern the modified D2 blocks or component.

Pre-existing sidecar drift remains: its motion and breakpoint lists omit earlier D2 flow/focus motion and the 900px/700px diagram breakpoints. This ordinary extension leaves that drift unrepaired and adds no system tokens. DESIGN.md and `.impeccable/design.json` remain unchanged.
