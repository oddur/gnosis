# D2 explanation diagrams

New explanations use D2 with the local TALA engine. Saved Mermaid diagrams and Mermaid fences in PR descriptions still use Mermaid. Opening a saved explanation does not call a model or rewrite it. Richer guidance metadata requires a newly generated diagram or explanation.

A diagram primarily teaches how the change works: its trigger, data or state movement, decisions, invariant, and outcome. Before/after comparison supports that explanation when the contrast clarifies the mechanism. The viewer supports architecture containers, role icons, annotated sequences, concrete algorithm states, and before/after changes.

## Guided inspection

Named buttons and Previous/Next controls let readers inspect each step at their own pace. A fitted preview opens the shared pan-and-zoom viewer. The expanded viewer places the active explanation beside the diagram and below it at narrow widths. Additional tooltip notes remain collapsed under “More about this diagram.”

A focused step highlights exact nodes or connections on an existing board. Connection focus also highlights its endpoints. Other entities remain visible for context. Focus changes on one board preserve positions and zoom without another layout or compilation. In the expanded viewer, clicking an entity selects the first matching step. A node also matches a step focused on its incident connection. Keyboard users select steps through the named navigation buttons.

The explicit `kind` controls the navigation:

| Kind | Purpose | Navigation |
| --- | --- | --- |
| `walkthrough` | Execution or algorithm steps | Named, numbered steps with optional auto-play |
| `map` | Relationships and ownership | Named views without auto-play |
| `comparison` | Before/after or alternative outcomes | Named views without auto-play |
| Missing | Older saved diagrams | Named views without auto-play |

Auto-play starts only through “Auto-play steps” and advances every 6.5 seconds. Pause, manual navigation, dialog dismissal, source navigation, and a hidden window stop auto-play and flow animation. Reduced motion removes animation and transitions. The paused view contains the complete explanation. Native board changes fade in, but arbitrary layouts do not morph between states.

## Generation and saved metadata

The planner suggests a reviewer question and visual approach in `diagramBrief`. Each writer checks that suggestion against the actual source. Whole-review and topic writers share [the instructions](../lib/d2-guidance.ts) and [compiler-checked recipes](../lib/d2-recipes.ts).

The instructions ask the writer to:

- Explain ownership or execution boundaries with actual operations and payloads.
- Use one compact sequence with stable actors and messages for an execution walkthrough.
- Show concrete algorithm inputs, state values, decisions, and stopping conditions.
- Explain invariants, races, failure boundaries, and consequences in the active step.
- Ground claims and optional code evidence in the supplied source.
- Omit diagrams that repeat obvious code or add no understanding.

A saved `d2Diagram` contains D2 `source`, an optional `kind`, a `caption`, and optional `steps`. Each metadata step supports these fields:

| Field | Meaning |
| --- | --- |
| `board` | `overview`, `steps.<name>`, or `scenarios.<name>` |
| `title` | Name of the event or relationship |
| `change` | Concrete action or state transition at this step |
| `description` | Invariant, consequence, or reason that matters |
| `focus` | Exact D2 node or connection identifiers |
| `evidence` | Optional `{filePath, startLine}` anchor in the supplied diff |

For a stable walkthrough, metadata steps reuse `board: "overview"`. An initial Overview entry has `focus: []`. Later entries select exact identifiers such as `api`, `service.handler`, `(client -> api)[0]`, or `service.(handler -> jobs)[0]`. Connection indices start at zero for each source/target pair. Unknown focus identifiers do not hide the diagram.

Native D2 boards represent actual drawing changes: new labels or values, added or removed dependencies, or different algorithm states. Native `steps` inherit the previous board. Native `scenarios` inherit the overview and represent alternative outcomes or inputs. Named captions prevent reordered boards from receiving another board's explanation. Older positional captions remain readable.

The viewer supports only top-level steps/scenarios, with a limit of 12 compiled frames including the overview. Nested boards and layers produce a recoverable error. The metadata normalizer retains at most 12 step entries. Native boards alone do not establish an execution sequence or enable auto-play.

When adjacent views use different boards, “What changed in the drawing” lists changed labels and added or removed entities. Up to three differences appear expanded. Longer lists start collapsed. These differences come from compiled entity labels and identities. The viewer does not simulate an algorithm or derive runtime values beyond those labels.

“Show supporting code” appears only for an evidence anchor that resolves within the current slide's diff hunks. The link closes the diagram and opens the relevant code location. A path outside those hunks does not produce a link.

## Rendering and recovery

D2 0.9.0, including TALA, runs through the pinned `@d2lang/d2` 0.1.34 WASM worker. TALA lays out ordinary graphs. D2 uses its specialized sequence layout for sequences. Gnosis owns fonts, theme, and padding.

The renderer caches completed output by source and theme, separately from presentation metadata. Changes to focus or captions do not trigger compilation. Limits apply to entry count and SVG bytes. Revisiting a cached diagram can show it immediately. The cache lasts for the application session. The saved review retains source and metadata.

The normalizer handles malformed optional JSON at generation and display boundaries. Rendering errors leave the narrative and code available. Retry uses the local renderer without a model call. A deadline covers worker initialization, compilation, and rendering. An expired worker is discarded.

The renderer sanitizes SVG and gives each displayed copy distinct IDs. Icons come from the bundled role set. External resources are not allowed. License and source notices ship in `public/licenses/d2/`.

## Evaluation

Run the deterministic checks:

```sh
npm run test:diagrams
```

These checks compile prompt recipes and saved generated fixtures in both themes and exercise the viewer in Electron. Coverage includes named views, exact focus, stable zoom, native board differences, evidence links, manual navigation, auto-play, reduced motion, caching, errors, and narrow layouts. Legacy Mermaid retains its shared inspection viewer.

Open the development gallery:

```sh
npm run diagrams
npm run diagrams -- --generated
```

The gallery lives in test fixtures, outside the shipped application entry point.

Run the real explanation writer on synthetic code:

```sh
npm run eval:diagrams -- --live
npm run eval:diagrams -- --live --case=sequence
```

This command calls the installed Codex provider with the app's default Codex model. It writes responses, rendered SVGs, and results to a temporary directory. It does not fetch GitHub code. The evaluator checks compilation, caption coverage, and exact focus identifiers against compiled entities.

The guided-diagram finish pass generated and compiled a fresh synthetic sequence through the live writer. Its focus identifiers matched compiled entities. The accepted response remains in [the generated fixtures](../tests/fixtures/d2-generated.json). The finish pass reported 288 passing tests, the diagram browser suite, TypeScript, and targeted ESLint checks.

The independent finish reviewer returned SHIP. Captures in `.impeccable/review/d2-integration/` show the real explanation pane, expanded guidance, light and dark themes, and narrow layouts. These checks establish behavior on the tested fixtures. They do not establish explanation accuracy across arbitrary pull requests or exhaustive accessibility coverage.

When evaluating generated output, inspect the causal claim, step order, focus, inherited state, failure paths, readability, and usefulness against the supplied code. Keep accepted outputs as compiler and browser fixtures. Valid SVG alone does not establish a useful explanation.
