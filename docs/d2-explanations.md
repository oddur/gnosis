# D2 explanation diagrams

New explanations use D2 with the local TALA engine. Saved Mermaid diagrams and Mermaid fences in PR descriptions still use Mermaid. Opening a saved explanation does not call a model or rewrite it. Saved D2 diagrams gain the current rendering behavior without regeneration. Improved generated prose and richer guidance metadata require a newly generated diagram or explanation.

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

Auto-play starts only through “Auto-play steps” and advances every 6.5 seconds. Pause, manual navigation, dialog dismissal, source navigation, and a hidden window stop auto-play and flow animation. Reduced motion removes animation and transitions. The paused view contains the complete explanation. Steps with the same layout keep the same canvas. A different graph fades in without motion between unrelated positions.

## Generation and saved metadata

The planner defines the teaching goal before choosing a visual form. Its optional `diagramBrief` contains:

- `question`: the specific question the diagram answers.
- `takeaway`: what the reviewer can explain or predict afterward.
- `assumedKnowledge`: concepts that need no further explanation.
- `essentialConcepts`: responsibilities, decisions, state, and boundaries needed for the answer.
- `omit`: incidental details left in code or another topic.
- `visualApproach`: the simplest useful form and its benefit over prose.

Writers check this proposal against the source and can revise or reject it. They also receive other topics' planned questions, takeaways, and concepts. This shared plan helps prevent repetition across parallel writers. It does not contain the other writers' completed explanations. Older text briefs remain supported. Malformed briefs become null without discarding the review.

A useful diagram reduces the reader's reasoning effort. Each step explains one meaningful decision or discovery, rather than one function call. The first view supplies a takeaway without extra clicks. Prose states the rationale, the diagram exposes a difficult relationship, and code supplies evidence. A static example can replace a walkthrough. The writer omits a diagram when its terminology and navigation require more effort than they save.

 Whole-review and topic writers share [the instructions](../lib/d2-guidance.ts) and [compiler-checked recipes](../lib/d2-recipes.ts).

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
| `title` | Short takeaway, such as “Capacity is full: C must wait” |
| `change` | Optional concrete value or action absent from the title and description; otherwise empty |
| `description` | One short sentence explaining the constraint or consequence |
| `focus` | Exact D2 node or connection identifiers |
| `evidence` | Optional `{filePath, startLine}` anchor in the supplied diff |

Each sentence adds information. The viewer suppresses exact duplicate title, change, and description text. Generation guidance also asks writers to avoid repeated ideas and keep label wording and units consistent across states.

For a stable walkthrough, metadata steps reuse `board: "overview"`. An optional Overview entry has `focus: []`. Explicit diagram kinds can start at the first useful focused step without an inserted overview. Entries select exact identifiers such as `api`, `service.handler`, `(client -> api)[0]`, or `service.(handler -> jobs)[0]`. Connection indices start at zero for each source/target pair. Unknown focus identifiers do not hide the diagram.

Native D2 boards represent actual drawing changes: new labels or values, added or removed dependencies, or different algorithm states. Native `steps` inherit the previous board. Native `scenarios` inherit the overview and represent alternative outcomes or inputs. Named captions prevent reordered boards from receiving another board's explanation. Older positional captions remain readable.

The viewer supports only top-level steps/scenarios, with a limit of 12 compiled frames including the overview. Nested boards and layers produce a recoverable error. The metadata normalizer retains at most 12 step entries. Native boards alone do not establish an execution sequence or enable auto-play.

When adjacent views use different boards, “Changes in this step” lists changed labels and added or removed entities. This list starts collapsed on each step. The comparison follows the authored view order, regardless of navigation direction. These differences come from compiled entity labels and identities. The viewer does not simulate an algorithm or derive runtime values beyond those labels.

Inserted or replaced words and values receive a persistent underline in the SVG and one 450ms opacity pulse. This treatment preserves compiled coordinates, font metrics, and line breaks. Reduced motion removes the pulse but keeps the underline. Removed text remains available in the collapsed change list. Unsupported SVG labels, including labels drawn as paths, retain the entity outline without guaranteed marks on individual words or values.

“Show supporting code” appears only for an evidence anchor that resolves within the current slide's diff hunks. The link closes the diagram and opens the relevant code location. A path outside those hunks does not produce a link.

## Rendering and recovery

D2 0.9.0, including TALA, runs through the pinned `@d2lang/d2` 0.1.34 WASM worker. TALA lays out ordinary graphs. D2 uses its specialized sequence layout for sequences. Gnosis owns fonts, theme, and padding.

Native steps and scenarios with the same graph share node positions, node sizes, and connection routes. The renderer reserves space for their largest labels before it shows the first frame. Each frame keeps its own text, highlights, and notes. Font sizes stay the same across all boards. Both SVG viewports use shared bounds, so label and stroke changes do not change the fitted scale.

This also applies to saved explanations without regeneration. Added or removed entities, changed connections, and changed shape structures retain separate layouts. If the compiler rejects a sizing constraint, the renderer keeps the original diagram. The extra layout pass runs in the D2 worker and uses the existing timeout and cache.

The renderer caches completed output by source and theme, separately from presentation metadata. Changes to focus or captions do not trigger compilation or rewrite D2 source. Limits apply to entry count and SVG bytes. Revisiting a cached diagram can show it immediately. The cache lasts for the application session. The saved review retains source and metadata.

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

Run the real planner and writer on synthetic code:

```sh
npm run eval:diagrams -- --live
npm run eval:diagrams -- --live --case=sequence
```

This command calls the installed Codex provider with the app's default Codex model. It writes plans, responses, rendered SVGs, and results to a temporary directory. It does not fetch GitHub code. The evaluator checks compilation, caption coverage, and exact focus identifiers against compiled entities. It also checks that a wording-only change omits a diagram. Other cases allow omission when prose explains the mechanism better.

Each case records comprehension questions for human assessment. Check whether the output explains the mechanism, preserves its important constraint, and supports the expected prediction. Also check the abstraction level, repeated content, and effort required to read it. Compilation alone does not establish those qualities.

The guided-diagram finish pass generated and compiled a fresh synthetic sequence through the live writer. Its focus identifiers matched compiled entities. The accepted response remains in [the generated fixtures](../tests/fixtures/d2-generated.json). The finish pass reported 288 passing tests, the diagram browser suite, TypeScript, and targeted ESLint checks.

The independent finish reviewer returned SHIP. Captures in `.impeccable/review/d2-integration/` show the real explanation pane, expanded guidance, light and dark themes, and narrow layouts. These checks establish behavior on the tested fixtures. They do not establish explanation accuracy across arbitrary pull requests or exhaustive accessibility coverage.

The later step-insights refinement passed 11 diagram unit tests, the Electron D2 browser suite, TypeScript, and targeted ESLint checks. Browser checks cover changed values, collapsed details, stable coordinates and zoom, reduced motion, and caption changes without compilation. Its independent finish reviewer returned SHIP with no material fixes. The `step-insights-*.png` captures in the same directory cover light, dark, expanded, and narrow views of the tested fixture. These results do not establish the quality of arbitrary model output.

When evaluating generated output, inspect the causal claim, step order, focus, inherited state, failure paths, readability, and usefulness against the supplied code. Keep accepted outputs as compiler and browser fixtures. Valid SVG alone does not establish a useful explanation.

The teaching-goal evaluation produced plans with explicit questions, assumptions, and omissions. Its first version-check diagram still repeated a full exchange for two clients. This result led to stronger decision/state guidance and a compact, compiler-checked recipe. Follow-up live samples timed out, so output quality after that refinement remains unverified. Deterministic tests check the contract and rendering behavior, not comprehension across arbitrary changes.
