# D2 explanation diagrams

New explanations use D2 with the local TALA engine. Saved Mermaid diagrams and Mermaid fences in PR descriptions still use Mermaid. Regenerate an old explanation to produce new D2 diagrams; opening a saved explanation does not call a model or rewrite it.

The viewer supports architecture containers, role icons, annotated sequences, concrete algorithm states, and before/after changes. Native D2 steps and scenarios become an explicit walkthrough. Playback, edge animation, zoom, pan, and expanded annotations work within the explanation pane. Motion starts on user action and respects reduced motion. Frame changes fade in; arbitrary graph layouts do not morph smoothly between states.

## Generation

The planner suggests a reviewer question and visual approach in `diagramBrief`. Each writer verifies that suggestion against the actual source. The whole-review and topic-writer paths share [the instructions](../lib/d2-guidance.ts) and [compiler-checked recipes](../lib/d2-recipes.ts).

The instructions ask the writer to:

- Show ownership or execution boundaries, not a directory listing.
- Use compact sequences with shared actors/messages and alternate-outcome scenarios.
- Show concrete algorithm inputs, state changes and stopping conditions.
- Explain invariants, races, failure boundaries and reviewer questions in annotations.
- Keep captions attached to named boards and clear inherited state when it no longer applies.
- Use motion to explain a path or transition. Avoid decorative movement and unsupported guarantees.
- Omit a diagram when prose or code is clearer. Diagram count is not a quality target.

A saved `d2Diagram` contains `source`, `caption`, and `steps`. Each step caption has `board`, `title`, and `description`. Board identifiers are `overview`, `steps.<name>`, or `scenarios.<name>`. Older positional captions remain readable. The current viewer supports top-level steps/scenarios, with a safety limit of 12 frames; nested boards and layers produce a recoverable diagram error.

`steps` inherit the previous board. `scenarios` inherit the overview. Named captions prevent a reordered board from receiving another frame's explanation.

## Rendering and recovery

D2 0.9.0, including TALA, runs through the pinned `@d2lang/d2` 0.1.34 WASM worker. TALA lays out ordinary graphs; D2 uses its specialized sequence layout for sequence diagrams. Fonts, theme and padding belong to Gnosis.

The renderer caches completed output by source and theme. Limits apply to both entry count and SVG bytes. Revisiting a cached diagram can display it immediately. Rendered SVG is not persisted across application restarts; the source remains in the saved review.

Malformed optional JSON is normalized at generation and display boundaries. Rendering errors leave the narrative and code available. Retry uses the local renderer, with no additional model call. A deadline covers worker initialization, compilation and rendering; an expired worker is discarded. SVG is sanitized and each displayed copy receives distinct IDs. Icons come from the bundled role set; external resources are not allowed. License and source notices ship in `public/licenses/d2/`.

## Prompt evaluation

Run the deterministic checks:

```sh
npm run test:diagrams
```

These compile every prompt recipe and the saved model-generated fixtures in both themes, check output normalization, and exercise the viewer in Electron. Browser coverage includes the real explanation page, legacy Mermaid, captions, playback, reduced motion, duplicate SVG IDs, cache reuse, errors and narrow layouts.

Open the development gallery:

```sh
npm run diagrams
npm run diagrams -- --generated
```

The gallery lives in test fixtures and is not reachable from the shipped application entry point.

Run the real explanation writer on synthetic code:

```sh
npm run eval:diagrams -- --live
npm run eval:diagrams -- --live --case=sequence
```

This explicitly calls the installed Codex provider with the app's default Codex model. It writes responses, rendered SVGs and results to a temporary directory. It does not fetch GitHub code. The evaluator checks compilation and caption coverage; it does not replace human review of accuracy and usefulness.

The first live pass rendered all three cases: late-response handling, optimistic document updates, and weighted batching. Inspection found a duplicated sequence and an inherited annotation that no longer applied. The revised instructions reduced the sequence from eight messages to four with success/conflict scenarios, and the algorithm used independent scenarios for different inputs. The latter explains both order preservation and the overweight-item progress exception. These examples establish useful behavior on a small synthetic sample, not reliable quality across arbitrary PRs.

When iterating, inspect the rendered result against the supplied code. Check the causal claim, frame order, inherited labels/annotations, failure paths, label readability and whether the diagram adds understanding. Keep accepted outputs as compiler/browser fixtures; do not treat “valid SVG” as sufficient evidence of a good explanation.
