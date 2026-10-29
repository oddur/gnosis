# SVG explanation slides

The explanation planner first decides what visual form would explain the code's difficult relationship best. The writer checks that plan against the source, then authors the SVG composition. The renderer does not prescribe a grid, node types, or a diagram catalog.

New explanations can use `svgIllustration`, static D2, or no visual. Saved card-based mechanisms, D2 diagrams, Mermaid diagrams, and separate free-form explorations remain supported.

## Visual planning

The generic planning prompt asks for the reader's question, the insight, and why a chosen spatial representation helps. The saved SVG artifact records the chosen approach, its rationale, visual encodings, an explicit animation brief, an outcome the reader should be able to predict, and the evidence that stays visible after motion stops. Older artifacts without the last two fields remain valid. These are design decisions, not a chain of thought.

Planning, drawing, and visual review share a perceptual-clarity contract: make decisive values directly comparable, represent quantitative limits spatially when useful, keep movement consistent with ordering and ownership, and avoid splitting attention between independent executions. Playback must reveal a meaningful action or constraint; a new footer or border color alone does not justify it. This guidance applies to arbitrary source code rather than prescribing a diagram catalog.

The model owns geometry, shape, proportion, arrangement, labels, and meaningful motion. Gnosis owns rendering boundaries, playback, themes, and validation. A single static frame is valid. Animation is appropriate when following a change helps explain the mechanism; it is not required to fill a quota.

`lib/svg-illustration.ts` owns the versioned artifact contract and writer guidance. `lib/d2-guidance.ts` includes the visual planning directive. The writer receives the planner's `diagramBrief` and may revise it when full source supports a better explanation.

## Reader experience

- The illustration appears in the explanation pane beside supporting code.
- Static illustrations omit playback controls.
- Animated illustrations start paused and support play, pause, previous/next step, scrub, restart, and speed.
- Complete SVG snapshots make backward navigation deterministic. Stable `data-motion-id` groups let the host animate the same object between positions.
- Expansion preserves the selected scenario and step. Closing restores keyboard focus.
- A source link appears only when its file and line resolve in the current slide.
- Reduced motion preserves the snapshots without movement. Hiding the window pauses playback.
- Scenarios select saved illustrative input cases. They do not execute the target program or accept arbitrary simulation inputs.

## Rendering and validation

`components/SvgIllustration.tsx` hosts an opaque-origin iframe. `lib/svg-illustration-document.ts` executes only Gnosis playback code, reusing the existing explainer motion runtime. Model-authored content is SVG data, not JavaScript. The drawing allowlist excludes scripts, handlers, HTML, external resources, and model-owned animation. CSP blocks network access and unrelated content. There is no preload, filesystem access, or Electron API inside the frame.

Frames share a viewBox. The two-phase generation path validates every frame in an isolated Electron renderer at a 440px pane width, in both themes. Checks cover SVG structure, stable bounds, duplicate identities, minimum text size, clipped labels, and overlapping labels. Browser failures are sent back to the writer with the previous illustration for one repair attempt. If that also fails, the narrative remains usable and the invalid illustration is omitted. Saved artifacts receive the same drawing allowlist at display time.

After browser validation, a separate model call reviews the source, teaching goal, captions, SVG, and actual rendered pictures. Each contact sheet contains labelled states and transition midpoints at the inline pane size. Midpoints sample the same Web Animations used during playback. The critic checks causality, truthful encodings, persistent identity, useful motion, readable paused states, and whether the reader can predict another outcome.

A critique can accept, request one repair, or omit the picture. A repair changes only the illustration, then repeats browser validation, screenshot capture, and critique. If the repair fails, the critic still finds problems, or visual review is unavailable, the slide keeps its prose and omits the picture. Cancellation stops the job. The visual review and repair share a four-minute deadline; rendering has a one-minute deadline. These model calls add generation time.

Both Claude and Codex receive actual PNG image attachments. Codex uses private temporary files removed after its process exits; Claude receives base64 image blocks over stdin. Screenshots are made in an isolated Electron renderer, not the application renderer. At most 16 contact sheets cover the bounded artifact. Evaluation can save them for inspection; normal generation does not persist them.

These checks improve quality but do not prove source accuracy or educational value. Review the generated picture against its source. Custom continuous simulations remain the responsibility of the existing exploration feature.

## Evaluate and compare

Retained example screenshots live in `docs/images/svg-explanations/`. Browser checks write disposable captures under the ignored `.impeccable/review/` directory.

```sh
npm run eval:illustrations -- --live
npm run diagrams:mechanisms
npx tsx --test tests/svg-illustration.test.ts
node scripts/test-workbench.mjs --illustrations
```

The evaluator uses GPT-6.1 Sol through the installed Codex harness. It runs the normal planner and writer on illustrative source and applies the production browser validator. Optional `--case=queue`, `--case=version`, or `--case=rotation` regenerates one example. Add `--review-only` to render and critique a saved example without regenerating its plan and first draft. Raw plans and explanations are saved in `docs/research/generated-illustrations/`; the comparison gallery reads `tests/fixtures/illustration-generated.json`.

The gallery shows the exact source used for generation. “New version” displays authored SVG; “Previous version” displays the earlier fixed-card prototype for the first two examples. “Why this visual?” exposes the model's saved design rationale. None of these examples modify the user's saved reviews.

The first evaluation chose static compositions; those outputs are preserved in `docs/research/generated-illustrations/static-baseline/`. The new evaluation uses the animation brief and rendered critic. Candidate JSON and labelled contact sheets record the evaluated drawings, including rejected candidates. The first animated run produced three batching frames, two frames per version-check case, and ten rotation frames. The critic corrected a misplaced boundary and obscured index labels in the rotation example before accepting it. The user praised the rotation but found the batching unintuitive and the stale-write playback confusing. Those two outputs are preserved in `pre-clarity-feedback/`. They showed a gap in the critic: correct labels alone were receiving approval despite weak visual reasoning. The shared clarity contract now explicitly rejects that failure. Human feedback remains necessary; model acceptance is not a claim of perfect teaching quality. An independently authored motion fixture tests playback, backward navigation, scenario switching, expansion, and reduced motion. A regression test verifies that a persistent object actually occupies an intermediate position during an SVG replacement; checking only endpoint frames had missed a playback bug. Browser captures also cover light/dark laptop layouts and the real explanation/code integration.

Earlier evaluation artifacts and the old format remain available via `npm run eval:mechanisms -- --live` and `node scripts/test-workbench.mjs --mechanisms`. They are comparison material, not the default generation format.
