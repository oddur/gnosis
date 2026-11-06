# Explorable diagram evaluation

This collection records live planner/writer output, browser renders, and educational review. The source examples come from Gnosis rather than fabricated PRs. `source.json` records the source bytes and revision for each case. The new gallery is available through `npm run diagrams:architecture`.

## What was compared

| Case | First pass | Refined pass | Lesson |
| --- | --- | --- | --- |
| Priority promotion | A dense responsibility map. Rendering initially rejected readable text before iframe resize settled. Educational repair exhausted its review budget; no accepted visual was returned. | Component map with retained references and a separate dispatch gate; accepted after repair. | A workflow arrow is not a reference edge. Include the actual enqueue call site before claiming how priority reaches pending work. |
| Cache clearing | Four-step sequence; accepted after a render retry. | One complete sequence; educational repair moved cleanup before caller delivery. | A complete still sequence can explain order more directly than repeatedly revealing the same actors. Preserve the difference between result delivery and cache ownership. |
| Explanation generation | No first-pass baseline. | Dataflow showing the separate prose and visual routes, renderer isolation, and educational review; accepted on its first pass. | Architecture is useful when responsibilities and alternative routes are the question. |

The first two cases are in `priority/` and `cache/`. The later run is in `refined/`. These are not a controlled benchmark: the priority case gained missing call-site evidence, and the iframe measurement fix changed validation between runs. Model acceptance is not proof of educational excellence or a broad quality claim.

The evaluator used the configured default Codex model, `gpt-6.1-sol`, through the local harness. It used the production planner, topic writer, rendered validator, and source-and-image critic. It retained raw candidates and contact sheets, including candidates that were repaired or not delivered. No private PR source is included.

## React Flow decision

Keep **custom SVG as the authored composition**. Attach a small semantic model for entities, relationships, and source references. Use React Flow for the expanded viewport and selection targets, preserving the SVG's exact geometry. This avoids choosing between a polished authored illustration and an explorable component map.

The experiment does not ask React Flow to invent layout or turn every entity into a standard card. Component shapes, boundaries, routes, sequence lanes, and animations remain model-authored SVG. The implementation uses the installed React Flow dependency; it does not embed either harvested tool's runtime.

See [the React Flow research](../react-flow-explanations.md) and [implementation guide](../../animated-svg-explanations.md).

## Issues found through evaluation

- Tall SVG validation ran before the iframe's new height reached its renderer. Waiting for layout removed false small-text failures. A tall-figure regression now covers this.
- Recreating controlled React Flow nodes without their known dimensions briefly hid hit targets. Explicit geometry removes that remeasurement.
- The existing expanded-stage height cap scaled the drawing independently of the selection overlays. A scoped override and an extent assertion keep them aligned.
- Resize originally retained a viewport that cropped the diagram on a narrow window. The canvas now refits on size changes, while selection preserves its viewport.
- Fading unrelated content reduced its readability too far. Focus now highlights direct connections and keeps contextual labels readable.

The browser interaction fixture is independently authored and is not presented as model-generated output. It covers pointer and keyboard selection, read-only behavior, stable positions, direct-connection inspection, code navigation, resizing, and light/dark themes. The previous SVG player has separate regression coverage.

## Review status

The independent finish reviewer inspected all 16 screenshots in `.impeccable/review/diagram-exploration/`. Coverage includes the three generated examples inline, expanded in light/dark themes, and selected, plus the authored interaction fixture at desktop and 620px narrow width. The initial material finding was that viewport controls could overlap authored diagram content. The controls now occupy a separate footer below the viewport. The reviewer confirmed that the fix resolved the finding and returned **pass; ship at the scope of the scored fix**.

Typecheck, scoped ESLint, and 15 focused unit tests passed. The final Docker diagram-exploration and existing SVG-player browser suites passed. The session verification log is `/tmp/gnosis-diagram-final-verification.log`; screenshots under the ignored review directory and this temporary log are local evidence. The source snapshots, generated candidates, and contact sheets in this collection are the retained research artifacts.

The initial three accepted examples were static. The later composition pass below adds a three-frame priority walkthrough. The finish review above applies to the earlier captures, not to a new claim of educational quality for later generated content. Existing meaningful-motion support remains covered by the SVG-player suite. The evaluation has no controlled benchmark or independent measurement of reviewer understanding, and the finish verdict does not remove those limitations.

## Open the examples

Run `npm run diagrams:architecture`, then open `http://127.0.0.1:5173/tests/fixtures/mechanisms.html?architecture`. Select a component and inspect its direct connections, then choose **Explore** to pan and zoom the same drawing. The gallery includes the pinned source used to generate each example. Run `npm run test:browser:docker -- --diagram-exploration` to repeat the exploration checks. See [the implementation guide](../../animated-svg-explanations.md) for live evaluation commands.


## Composition pass after comparing Archify

The planner, writer, and critic now share a composition standard: one question, deliberate reading direction, meaningful grouping, role labels before implementation details, and a picture that teaches before inspection. The planner also distinguishes conditions needed for a depicted claim from independent implementation concerns. Source checks remain strict when a simpler picture makes a false claim.

The `composition/` run uses the same model, source revision, full source snapshots, and questions as `refined/`. It is not a controlled prompt-only benchmark: the pipeline input uses selected source excerpts rather than the earlier full-file context, and generation is stochastic.

| Case | Observed result | Judgment |
| --- | --- | --- |
| Cache | One sequence separates the caller's retained promise, cleared cache state, active loader, and rejected storage. The optional newer-read branch moves to details. | Less competing information than the earlier P1/P2 sequence; some code terminology remains. Accepted by the rendered source critic. |
| Pipeline | A direct prose route leads to the completed slide; the optional visual route passes through an isolation boundary and critic, with a separate omit outcome. | Clearer primary path and less in-box prose. Accepted by the rendered source critic. |
| Priority | The first composition was repaired to show the client scope and retained parent chain; three frames show promotion and consultation at the next drain. | Faithful but still dense. This is the version kept in the gallery. |

A second priority run, `composition-focused/`, used the narrower planning rule. Its pending-to-active movement and ownership groups made the initial picture easier to read. However, both its initial and repaired drawings implied that the scheduler directly retained the scope changed by the shared reader. The actual client scope inherits through parent references. The critic rejected the final candidate, so its `result.json` contains no accepted visual. Its images and candidates remain available; the gallery restores the earlier accepted priority artifact from `composition/`.

The lessons are adopted in production prompts. This comparison supports an improvement in focus for two examples, not a claim that all generated diagrams now match Archify's showcase. The priority example still needs a composition that preserves the reference chain without making it the reader's entire task. No failing candidate was silently relabeled as accepted.

Final verification for the retained composition examples: 15 focused unit tests, TypeScript, scoped ESLint, and the Docker exploration browser suite passed. Browser captures cover the actual viewer in light/dark themes with selection and source navigation. The local run log is `/tmp/gnosis-composition-browser.log`.


## Causal-story iteration after screenshot feedback

The screenshot feedback identified a reference map competing with a behavior walkthrough. Production guidance now explicitly separates these abstractions, follows the direction of the effect in behavior diagrams, retains causal intermediaries, and moves independent policy into inspection. Literal-reference claims remain subject to exact source validation.

- `causal-story/priority`: generated from the same source and original question with the revised generic prompts. The critic accepted a single-frame map. It removed the retry loop and reduced detail, but the reading path still reversed to follow parent/reference arrows.
- `causal-path/priority`: a directed refinement using that previous illustration and saved editorial feedback. The plan narrowed to joining, inheritance through the client scope, and later scheduler observation. The resulting static diagram reads left to right: caller → shared work → client request → scheduler. It shows the unchanged client-local priority beside its inherited effective priority, labels parent-chain influence, and keeps active requests continuing. The source-and-image critic accepted it on the first pass.

The gallery now uses the spacing refinement `causal-fit/priority`. No SVG was edited by hand. This result is a directed refinement, not evidence that a generic prompt always produces it unaided. Compared with the reported three-frame diagram, it reduces competing policies and removes playback that no longer contributes to the explanation. Some source terminology remains useful in distinguishing local from effective priority. The declared abstractions and conditions, not visual simplicity alone, make the result valid.

A third run, `causal-fit/priority`, retained the accepted plan and refined label fit and connector clearance. The full-size viewer had exposed a scheduler label extending beyond its card. The model wrapped and shortened the labels, increased connector space, and preserved the same semantics. The source-and-image critic accepted this refinement on its first pass.

The evaluator now records prompt directives, exact input context, previous run, and editorial feedback. Rejected generations remain in their run folders and no longer overwrite accepted gallery entries. The earlier rejected scope-chain example remains available in `composition-focused/`.

The [expanded viewer capture](viewer/priority-dark.png) shows the retained example in Gnosis at 1280×900, captured by the Docker exploration browser check. It is a screenshot of the application, not a model-authored image.
