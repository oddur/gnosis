# Architecture diagram tools for Gnosis

Research date: November 6, 2026. This review inspected source, instructions, example JSON, and checked-in screenshots. It did not run either project or benchmark rendering.

Sources are pinned to Floorplan `70be3f40f9c2e061290b76027f180d9ff892edd6` and Archify `a4065941f12be7967436261d9934784e381d423c`. Selected upstream materials are in the [reference pack](diagram-reference-pack/).

## Recommendation

Use Floorplan's responsibility-based boundaries and Archify's typed diagram structure as references for Gnosis. Both contain real rendering implementations. Neither makes source interpretation automatic or guarantees a correct explanation. [Floorplan boundaries][fp-boundaries] [Archify authoring][ar-authoring]

For PR explanations, choose the question before the visual form:

| Reader's question | Suggested form | Information to preserve |
| --- | --- | --- |
| Where does this change fit? | Architectural overview | The changed subsystem, its callers, stores, and relevant boundaries. |
| Which parts cooperate? | Component diagram | Responsibilities, interfaces, dependencies, and ownership. |
| What happens, and in what order? | Sequence diagram | Participants, messages, conditions, responses, and asynchronous work. |
| Why does this local mechanism work? | Custom SVG | The particular state, constraint, or causal relationship. |

These are recommendations for Gnosis, not upstream feature claims. A connected slice can include unchanged context. Consistent names and stable IDs can connect its overview, sequence, source links, and change annotations.

## Floorplan: verified implementation

Floorplan combines scanned imports and inferred HTTP matches with agent-authored boundaries, descriptions, explicit edges, and narrated flows. Its builder resolves file ownership through globs, then aggregates links into the graph. An import proves a dependency, not necessarily a runtime call. [Builder][fp-build] [Schema][fp-schema]

Its viewer supplies actual automatic layout: bundled ELK uses layered placement, rightward direction, and orthogonal routing. Incoming and outgoing connectors occupy separate outer layers. Card dimensions depend on content and degree. The viewer then draws SVG paths and HTML cards inside `foreignObject`. This is reusable implementation material, but it belongs to a whole-map application rather than a small renderer API. [Viewer][fp-viewer]

The strongest visual abstraction is responsibility before filesystem structure. Instructions recommend deployable or ownable parts at the top, then meaningful domains or layers. The suggested counts are authoring heuristics, not evidence of an optimal diagram size. [Boundary instructions][fp-boundaries]

Guided flows dim unrelated nodes, highlight two current participants, show a narrated step, and animate a dot along their connection. The checked-in screenshot demonstrates this presentation. [Flow implementation][fp-flow] [Screenshot][fp-image]

**Grounding limitation:** the flow viewer accepts a connection in either direction and animates it toward the next step. Without a connection, it draws a fallback path. The builder checks step references but does not establish a directed edge between each pair. Gnosis can borrow narrated highlighting while requiring a supported relationship before animation. [Flow implementation][fp-flow] [Builder][fp-build]

Recent-work data connects changed files or endpoints to the user's request through a short task summary and per-item notes. Removed files are absent from the map, so instructions place deletion information in the summary. This pattern is useful for change explanations, with explicit removal support added for PR review. [Recent-work schema][fp-schema]

## Archify: verified implementation

Archify includes separate typed renderers for architecture, sequence, and eight other diagram types. Architecture renders semantic components, boundaries, connections, and supplementary cards. Sequence renders participant headers, lifelines, messages, activation bars, and phase segments. These are actual SVG generators, not only prompts. [Architecture renderer][ar-render] [Sequence renderer][ar-sequence]

Layout has two distinct paths:

- **Native architecture:** the author supplies positions or grid cells. Code computes boundaries, routes connections, places labels, and diagnoses collisions. The router does not rearrange component boxes. [Renderer][ar-render] [Authoring defaults][ar-defaults]
- **Compact explainer architecture:** a compiler derives ranks from directed edges and emits grid positions. Cyclic leftovers receive deterministic placement. This supplies basic automatic placement, not just routing. [Explainer compiler][ar-compiler]
- **Sequence:** code fits participant columns and canvas dimensions. Message `y` positions, activation ranges, and segment ranges remain authored. Self-messages are explicitly unsupported. [Sequence renderer][ar-sequence] [Sequence contract][ar-sequence-doc]

The cache-miss example distinguishes requests, returns, security interactions, and asynchronous work. Its route screenshot highlights a selected path while preserving the surrounding sequence. These semantics are more valuable to Gnosis than the neon styling. The example is illustrative, not evidence of a real application's behavior. [Example JSON][ar-sequence-example] [Screenshot][ar-image]

The viewer implements directed shortest paths and upstream/downstream reachability from explicit semantic edge attributes. Its path overlay follows existing geometry. Motion has Live/Still controls and reduced-motion handling. Sequence rendering marks chronological choreography separately. These mechanisms can support meaningful exploration, but graph reachability alone does not prove runtime impact or breakage. [Route implementation][ar-route] [Reachability implementation][ar-reach] [Motion implementation][ar-motion] [Viewer contract][ar-viewer-doc]

Archify also includes a useful PR-oriented comparator. It requires stable component and connection IDs. It distinguishes semantic, topology, evidence, and geometry changes, including `moved` and `rerouted` statuses. Thus, a layout adjustment need not appear as an architectural change. [Architecture delta][ar-delta]

Repository evidence checks require a full commit SHA and matching repository identity. They check cited files and line ranges against committed Git objects. The authoring instructions separately require tracing ownership, calls, writes, branches, and uncertainty. The code checks reference validity, not whether the cited text logically proves the claim. [Evidence implementation][ar-evidence] [Repository authoring][ar-authoring]

Evidence attaches to primary elements, such as components or participants, rather than individual connections or messages. Gnosis can improve this model with claim-level references on relationships and conditions. [Repository authoring][ar-authoring]

## Claims, reuse, and limits

Floorplan's README promises a whole-app map with plain-English names and connections. Archify's README promises interactive visuals and source-backed explainers. The inspected implementations support substantial parts of these descriptions. This review does not establish extraction coverage, visual quality across repositories, runtime performance, or factual accuracy. [Floorplan README][fp-readme] [Archify README][ar-readme]

**Practical reuse:** Floorplan supplies ELK integration and hierarchical graph projection. Archify supplies typed SVG renderers, routing, label placement, geometry diagnostics, evidence checks, and semantic interaction metadata. Both need adaptation for Gnosis's artifact model and host controls. A full viewer embed is unnecessary for adopting these ideas. [Floorplan viewer][fp-viewer] [Architecture renderer][ar-render] [Explainer compiler][ar-compiler]

Recommended generation contract:

1. Select overview, component, sequence, or local mechanism from the reader's question.
2. Identify a connected slice around the change, including enough unchanged context to explain it.
3. Record stable entities, relationships, conditions, and source references before geometry.
4. Use typed layout for standard diagrams and custom SVG for mechanisms that need specific visual treatment.
5. Make interaction reveal evidence, isolate a path, compare revisions, or advance an explanation step.
6. Animate only supported meaning. Preserve the complete explanation in a still frame.

These recommendations combine the inspected patterns. They do not require adopting either upstream application or its visual style.

## Licenses

Floorplan uses MIT. Its bundled ELK license is EPL-2.0, and bundled fonts carry separate notices. Copying the viewer does not make every bundled asset MIT. [Floorplan license][fp-license] [ELK license][fp-elk-license]

The inspected Archify revision uses Apache-2.0. Its NOTICE preserves historical MIT grants through an earlier commit and identifies third-party exceptions. Current files do not become MIT merely because `LICENSE-MIT` remains present. Reuse needs the applicable license and attribution notices, including notices embedded in generated artifacts. [Archify license][ar-license] [NOTICE][ar-notice]

[fp-boundaries]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/skills/floorplan/references/choosing-boundaries.md
[fp-build]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/skills/floorplan/scripts/build.mjs#L130-L240
[fp-schema]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/skills/floorplan/references/schema.md
[fp-viewer]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/skills/floorplan/assets/viewer.html#L1003-L1249
[fp-flow]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/skills/floorplan/assets/viewer.html#L1851-L1894
[fp-image]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/docs/images/flow.png
[fp-readme]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/README.md
[fp-license]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/LICENSE
[fp-elk-license]: https://github.com/haydenschmitty/floorplan/blob/70be3f40f9c2e061290b76027f180d9ff892edd6/skills/floorplan/assets/vendor/elkjs-LICENSE.md
[ar-authoring]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/references/repository-authoring.md
[ar-defaults]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/references/authoring-defaults.md
[ar-render]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/renderers/architecture/render-architecture.mjs
[ar-compiler]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/explainer/diagrams.mjs#L80-L250
[ar-sequence]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/renderers/sequence/render-sequence.mjs
[ar-sequence-doc]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/renderers/sequence/README.md
[ar-sequence-example]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/examples/cache-miss-request.sequence.json
[ar-image]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/docs/assets/archify-demo-route.png
[ar-route]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/assets/template.html#L13122-L13152
[ar-reach]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/assets/template.html#L8388-L8462
[ar-motion]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/assets/template.html#L7461-L8118
[ar-viewer-doc]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/references/viewer-runtime.md
[ar-delta]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/delta/architecture-delta.mjs
[ar-evidence]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/renderers/shared/repository-evidence.mjs#L155-L372
[ar-readme]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/README.md
[ar-license]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/LICENSE
[ar-notice]: https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/NOTICE
