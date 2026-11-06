# SVG explanation slides

The explanation planner first decides what visual form would explain the code's difficult relationship best. The writer checks that plan against the source, then authors the SVG composition. The renderer does not prescribe a grid, node types, or a diagram catalog.

New explanations use `svgIllustration` or no visual. Static maps, sequence diagrams, and animated walkthroughs all use custom SVG. The planner and writer no longer receive D2 syntax or examples. Generated D2 and legacy mechanism fields are discarded, including after an SVG is rejected; a failed picture leaves the prose intact. Saved card-based mechanisms, D2 diagrams, Mermaid diagrams, and separate free-form explorations remain supported. Regenerate an existing explanation to replace its saved diagrams.

## Visual planning

The generic planning prompt asks for the reader's question, the insight, and why a chosen spatial representation helps. The saved SVG artifact records the chosen approach, its rationale, visual encodings, an explicit animation brief, an outcome the reader should be able to predict, and the evidence that stays visible after motion stops. Older artifacts without the last two fields remain valid. These are design decisions, not a chain of thought.

Planning, drawing, and visual review share a perceptual-clarity contract: make decisive values directly comparable, represent quantitative limits spatially when useful, keep movement consistent with ordering and ownership, and avoid splitting attention between independent executions. Playback must reveal a meaningful action or constraint; a new footer or border color alone does not justify it. This guidance applies to arbitrary source code rather than prescribing a diagram catalog.

The model owns geometry, shape, proportion, arrangement, labels, and meaningful motion. Gnosis owns rendering boundaries, playback, themes, and validation. A single static frame is valid. Animation is appropriate when following a change helps explain the mechanism; it is not required to fill a quota.

`lib/svg-illustration.ts` owns the versioned artifact contract and the planner and writer guidance. The writer receives the planner's `diagramBrief` and may revise it when full source supports a better explanation.

## Architecture and exploration

The planner now chooses the level of explanation before the geometry: system context, component responsibilities, ordered interaction, dataflow, or a local mechanism. Cross-component changes favor architecture or sequence diagrams. This is a preference based on the reader's question, not a required overview or a diagram quota. Detailed implementation prose belongs in inspection or source rather than in boxes.

An optional `exploration` object adds typed entities and directed relationships to the existing SVG artifact. Entities have a short label, responsibility, `changed`/`context` status, and optional source evidence. Relationships have endpoints, a label, a concise explanation, and their own optional evidence. The SVG identifies the matching groups with `data-entity-id` and `data-relationship-id`. It still owns the actual drawing, including shapes, boundaries, sequence lanes, routing, and meaningful motion.

Inline readers can select a component or connection. The inspector shows its role or interaction and offers **Show code** when the source resolves in the current review. Direct connections are explicit; the host does not infer an execution path from graph reachability. Inspection uses saved data and makes no GitHub or model request.

**Explore** opens the same composition in a React Flow viewport beside its inspector. React Flow supplies pan, zoom, and selection targets aligned to measured SVG groups. It does not generate a replacement card layout, move components, edit connections, or delete nodes. Components and source actions work with the keyboard. Relationships are reachable through the selected component's direct-connection list. Window resizing refits the composition; selection does not. Zoom and Fit controls sit in a separate footer below the viewport so they cannot cover the drawing. At viewport widths of 760px or less, the inspector moves below the canvas. Sequence and specialized illustrations retain the existing playback controls when they contain multiple frames.

Browser validation checks that each declared entity and relationship has exactly one matching non-nested SVG group in every frame. Participant bounds must stay inside the canvas and stable across frames. The iframe waits for its aspect-ratio resize before measuring font sizes. Model scripts, network resources, HTML, and event handlers remain forbidden; the sandbox's own code supplies interaction and reports IDs through the existing token-checked message channel.

`lib/diagram-exploration.ts` owns metadata validation and immediate-neighbor focus. `components/DiagramExplorer.tsx` owns the read-only React Flow view and shared inspector. Saved illustrations without exploration metadata keep their original player. Generation checkpoint versions changed so unfinished work does not reuse earlier visual guidance.

The design draws on the [Floorplan and Archify research](research/architecture-diagram-tools.md) and the [React Flow evaluation](research/react-flow-explanations.md). Their complete viewers are not embedded.

### Composition lessons adopted from Archify

The [agent workflow](https://archify.si/gallery/artifacts/agent-tool-call.workflow.html), [deployment architecture](https://archify.si/gallery/artifacts/production-deployment.architecture.html), and [async sequence](https://archify.si/gallery/artifacts/async-job-roundtrip.sequence.html) demonstrate useful hierarchy and reading order. Gnosis adapts those principles to its smaller explanation pane:

- Answer one question with a clear entry point, reading direction, and outcome.
- Use space to explain real ownership, collaboration, or phases. Do not force a common layout onto unrelated mechanisms.
- Lead with roles and actions. Keep secondary implementation details in inspection or source.
- Give competing requests or values meaningful identities instead of unexplained symbols.
- Use consistent shapes, lines, and restrained color to communicate meaning; preserve readable context during exploration.
- Require the picture to teach before the reader clicks or reads its surrounding prose.

`DIAGRAM_COMPOSITION_DIRECTIVE` gives the planner, writer, and rendered critic the same standard. It distinguishes behavior from exact reference wiring: a behavioral edge follows a verified influence and labels its meaning; a literal reference edge must preserve the exact reference. Intermediate responsibilities remain visible when omitting them would change causality or ownership. The critic first assesses the picture's own reading path and decisive relationship, then checks source accuracy. Passing geometry checks or exposing clickable components is not sufficient for acceptance. Decorative grids, glow, and extra viewer controls are not part of this adoption.

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

The critic judges the stated visual question, not whether the picture covers every detail in the chapter. It requires an omitted detail when that detail changes the answer or makes a depicted claim misleading. A critique can accept, request one repair, or omit the picture. A repair changes only the illustration, then repeats browser validation, screenshot capture, and critique. If the repair fails, the critic still finds problems, or visual review is unavailable, the slide keeps its prose and omits the picture. Cancellation stops the job. The visual review and repair share a four-minute deadline; rendering has a one-minute deadline. These model calls add generation time.

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

Earlier evaluation artifacts remain as comparison material. The `--mechanisms` browser check verifies the saved legacy format; new generation does not produce it. Run browser checks through the Docker wrapper.

## Explore the generated examples

```sh
npm run diagrams:architecture
npm run eval:architecture -- --live --run=my-comparison
npm run test:browser:docker -- --diagram-exploration
```

The evaluation generates explanations from pinned Gnosis source snapshots through the normal planner, writer, browser validator, and educational critic. The model runs through the local Codex harness; all browser rendering runs in Docker. Build `gnosis-browser-tests` with `tests/docker/Dockerfile` before a live evaluation. Individual cases use `--case=priority`, `--case=cache`, or `--case=pipeline`. Results, candidate diagrams, source snapshots, and rendered contact sheets are retained under `docs/research/generated-architecture/`. Each run records whether a visual was accepted or omitted; omission is not counted as a successful example and does not replace the last accepted gallery entry. Runs retain the actual prompt directives and supplied context. For directed iteration, use `--refine-run=<prior-run> --feedback-file=<text-file>` with `--case=<case>`; the prior source revision must match, and the feedback is saved with the result context. Add `--reuse-plan` for a layout refinement that should retain the accepted teaching plan.

The gallery opens at `http://127.0.0.1:5173/tests/fixtures/mechanisms.html?architecture`. It currently shows three accepted examples: priority promotion as a component map, cache clearing as a sequence, and explanation generation as a dataflow. The latest priority diagram is a static causal path through caller, shared work, client request, and scheduler. It replaces the earlier three-frame reference map after a source-grounded refinement. Cache and pipeline remain static. The retained evaluation record includes rejected attempts and the editorial feedback used for refinement.

The gallery source pane uses TypeScript syntax highlighting in both light and dark themes. Highlighting runs in a worker so source processing does not block diagram interaction. Line numbers and source-evidence navigation remain available.

To inspect an example, select a component in the inline SVG, open one of its direct connections, and choose **Explore**. Pan or use Zoom and Fit to inspect the same drawing. Select another component to confirm that inspection preserves the viewport. **Show code** is available only when the current review or fixture resolves the saved source reference; otherwise the inspector displays the reference as text.

The independent finish review inspected all 16 diagram-exploration captures. Its material finding was overlap between viewport controls and diagram content. The separate footer resolved that finding, and the reviewer passed the change at the scope of that fix. Typecheck, scoped ESLint, 15 focused unit tests, and the final Docker exploration and existing SVG-player suites passed. The retained research record describes generation results and limitations; these interaction checks and the finish review do not constitute a controlled educational benchmark.
