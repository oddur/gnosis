# Gnosis design lessons

These are proposed adaptations of the [harvested references](README.md), not implemented generation behavior. The upstream files remain unchanged. This guide is newly written for Gnosis.

## Choose the level before the picture

The current Gnosis visual guidance spends much of its attention on constraints, values, and local mechanisms. Architecture and sequence diagrams are allowed, but the planner receives fewer concrete reasons to choose them. Change that emphasis.

First identify the missing understanding:

| Missing understanding | Useful form | What the picture should reveal |
| --- | --- | --- |
| Where this change fits | Architecture overview | The affected part of the system, its neighbors, and meaningful boundaries |
| Which part owns which job | Component diagram | Responsibilities, dependencies, and state ownership |
| How components cooperate | Sequence diagram | Trigger, participants, messages, consequential ordering, and outcome |
| How values travel or transform | Dataflow diagram | Producers, transformations, consumers, and persistence |
| Which states or decisions matter | State or decision diagram | Conditions, allowed transitions, and failure/recovery routes |
| Why a local algorithm behaves this way | Custom illustration | The specific transformation or constraint that is hard to infer from code |

This is a choice of teaching form, not a mandatory diagram sequence. A small local fix may need no architecture overview. A cross-component change should not be reduced to a local token animation when the missing information is ownership or interaction.

## Borrow from Floorplan

- **Name responsibilities.** Each component should be something an engineer would name in a whiteboard discussion. A directory, class, or function does not automatically deserve a box.
- **Separate meaning from identifiers.** Use a short role label, with the exact symbol or path available through a source action. Keep useful engineering terms such as queue, transaction, and cache; Gnosis is for engineers.
- **Show hierarchy on demand.** Start with the affected subsystem. Let the reader inspect its components without turning the initial picture into the entire repository graph.
- **Keep the map stable during a walkthrough.** Focus the current interaction while keeping enough surrounding context to preserve orientation.

Sources: [boundaries](floorplan/instructions/choosing-boundaries.md), [names](floorplan/instructions/writing-descriptions.md), and [schema](floorplan/instructions/schema.md). Do not adopt the source's numerical component quotas as Gnosis content targets.

## Borrow from Archify

- **Choose a semantic form.** Architecture, sequence, dataflow, and lifecycle have different visual grammars. Let structure guide geometry.
- **Trace a connected source slice.** Read the entry, relevant collaborators, and actual side effect. A function name or import alone does not prove a runtime call, write, or trust boundary.
- **Put conditions on the affected relationship.** A guarded operation must not appear as an unconditional arrow whose caveat is hidden elsewhere.
- **Make text point to the picture.** Use the same participant and operation names in the prose, diagram, and source navigation. Short steps can focus the relevant message or component.
- **Keep evidence attached to claims.** Tie important components and relationships to the inspected revision and source locations, not only to one source link for the whole frame.
- **Distinguish changed structure from moved geometry.** A layout adjustment is not an architectural change. Base/head comparison is useful when topology changes; it is secondary to explaining the resulting system.

Sources: [composition](archify/instructions/authoring-defaults.md), [repository authoring](archify/instructions/repository-authoring.md), [explainer authoring](archify/instructions/explainer-authoring.md), and the checkout platform [base](archify/examples/checkout-platform.base.architecture.json)/[head](archify/examples/checkout-platform.head.architecture.json) examples.

## Interaction that helps review

Use a readable, complete static view as the starting point. In an architecture view, select a component to reveal its responsibility and source; select an interaction to focus its participating components. In a sequence, step through messages while preserving participant positions and earlier causal context. Do not require playback to understand the outcome.

Animate an actual transfer, state transition, wait, or transformation when it clarifies order or causality. Highlighting can help locate the current step, but moving dots alone do not explain behavior. Do not imply measured timing or real execution when the diagram is illustrative.

Show changed elements explicitly and keep unchanged context quieter but readable. Use more than color to communicate this distinction. Expanding a diagram should preserve selection and step.

These interactions require host support. The current Gnosis SVG format supports frame-level source evidence and controlled motion, but not a general source-linked component/edge model. Prompt changes alone cannot deliver that interaction contract.

## Keep Gnosis constraints

- Source truth takes precedence over a tidy picture. Label unknowns or omit unsupported relationships.
- Gather additional context only where a missing relationship changes the explanation. Reuse cached source from the same revision.
- Preserve real boundaries and ownership, including asynchronous work and atomic operations.
- Keep labels readable in the actual explanation pane. The upstream full-page viewers and their font-size floors are not suitable defaults for Gnosis's narrower pane.
- Use concise prose for reasons and exceptions; do not repeat every arrow in a paragraph.
- Keep controls minimal, layouts stable, and motion optional. Do not import either tool's complete viewer into the explanation pane.
- Keep freeform SVG available for cases where a conventional diagram is the wrong explanation.

## Suggested implementation experiment

First revise the planning emphasis and evaluate the current SVG renderer on a cross-component change, a request/async sequence, and a local algorithm. Keep the source and model fixed when comparing old and new guidance. Do not require all three to produce the same visual form.

Judge whether the reader can identify the affected responsibilities, trace the changed interaction, explain the outcome, and reach supporting code without decoding extra prose. Also inspect readability, stable geometry, and whether the overview has omitted a behavior-changing condition.

If semantics are good but geometry or interaction remains unreliable, introduce a compact typed model for standard component and sequence diagrams. Let the model choose entities, relationships, evidence, and teaching focus; let a host renderer own common geometry and interactions. Retain custom SVG for specialized illustrations. That is a proposal, not a decision to adopt either upstream runtime.
