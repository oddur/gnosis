# React Flow for generated explanations

Research date: November 6, 2026. This review inspected Gnosis, installed `@xyflow/react` 12.12.1, and official React Flow documentation. It did not benchmark or run a browser evaluation.

## Recommendation

Use React Flow as the interaction layer for generated component and architecture diagrams. Supply a semantic graph and stable geometry separately. Keep custom SVG for sequence diagrams and mechanisms whose meaning depends on authored geometry. React Flow does not provide automatic graph layout. [Installed package][package] [Official layout guide][layout-guide]

This split fits existing Gnosis code. `WorkflowGraph.tsx` supplies custom node cards and routed SVG edges to React Flow. A separate ELK module places nodes and computes orthogonal routes. The renderer preserves those routes through `BaseEdge`. [Workflow viewer][workflow] [Workflow layout][workflow-layout]

| Diagram need | Preferred approach | Reason |
| --- | --- | --- |
| Inspect components and their relationships | React Flow with custom nodes and edges | Pan, zoom, focus, selection, and source details fit the node/edge model. |
| Place an architectural graph | ELK or supplied geometry, then React Flow | Layout remains separate from interaction. |
| Explain request order across participants | Purpose-built SVG sequence layout | Lifelines, activation bars, and repeated messages need timeline geometry. |
| Explain a queue, race, coordinate transform, or other local mechanism | Authored SVG | Objects and space can carry meaning beyond graph connectivity. |

These are design recommendations, not capability limits. React Flow accepts custom SVG paths and can support specialized geometry. That flexibility does not remove the need to design that geometry. [Custom edges guide][custom-edges] [Installed edge implementation][runtime]

## What Gnosis already supplies

- Custom cards have ordinary buttons, keyboard focus handlers, semantic labels, and local detail actions. Handles are non-connectable. [Workflow viewer][workflow]
- The viewer disables dragging and connection editing. It uses custom routed edges rather than recalculating paths from endpoints. [Workflow viewer][workflow]
- Viewport state is retained per graph and topology. The readable viewport starts at zoom `1`, anchored on an entry or focused job. “Fit entire workflow” remains a separate action. [Workflow viewer][workflow] [Readable viewport][viewport]
- ELK receives node dimensions and ports together. It returns positions and full edge routes, with consistent coordinate rounding. [Workflow layout][workflow-layout]

Reuse these patterns rather than importing the CI viewer wholesale. CI jobs, rerun actions, status filters, and workflow navigation do not belong in generated explanations.

## Generation and geometry

The proposed artifact separates three concerns: meaning, geometry, and reader state. Meaning includes stable entity IDs, relationship direction, conditions, change status, and evidence references. Geometry includes node bounds, ports, edge paths, and label positions. Reader state includes focus, selection, active explanation step, and viewport.

Selection and explanation steps must not rerun layout. Otherwise, the reader loses the positions that identify the parts. A changed source artifact can generate new geometry, while a changed selection only changes emphasis and details. Existing Gnosis viewport keys and externally supplied routes provide useful precedents. [Workflow viewer][workflow] [Workflow layout][workflow-layout]

`BaseEdge` accepts an arbitrary SVG path and supplies an invisible interaction path, with a default width of 20 units. This supports precise routed geometry and generous pointer targets together. It does not establish that the edge represents a real call or dependency. [Installed runtime][runtime] [Installed edge types][edge-types]

For a narrow explanation pane, keep labels readable before fitting the whole diagram. A compact initial slice, readable zoom, and an explicit overview action provide better starting points than a miniature graph. Pan and zoom can expose additional context. They cannot repair an oversized or unclear explanation. Gnosis already makes this distinction in its readable viewport helper. [Readable viewport][viewport]

Keep prose beside or below the diagram available during exploration. In an embedded pane, wheel behavior needs evaluation against the surrounding document. The existing CI canvas enables `panOnScroll` and `preventScrolling`; those settings are not automatically suitable for an explanation inside scrolling prose. [Workflow viewer][workflow] [Installed component props][props]

## Selection, evidence, and motion

Selecting a component or relationship can reveal its role, the change, and exact source references. Selection must use stable semantic IDs, not SVG element order or labels. The host can use those IDs to connect overview nodes, sequence participants, explanatory steps, and diff locations.

Path highlighting must traverse authored directed relationships. It must not infer connectivity from nearby shapes. A selected path can receive a brief pulse or a numbered step, but animation must not imply measured timing or concurrency without evidence. Static labels and arrows must retain the complete explanation.

React Flow supplies rendering and interaction hooks. It does not supply repository grounding, claim validation, PR change semantics, or meaningful narration. Those remain Gnosis responsibilities. The earlier [tool comparison](architecture-diagram-tools.md) describes useful evidence and interaction patterns from Floorplan and Archify.

## Accessibility and read-only behavior

React Flow provides focusable nodes and edges, ARIA labels, keyboard instructions, and automatic panning to a focused node. Custom nodes still need meaningful controls and labels. The official guide cautions against a button role on a wrapper that contains interactive children. [Accessibility guide][accessibility] [Installed runtime][runtime]

The installed implementation matters: node Enter/Space selection requires `isSelectable`, and `disableKeyboardA11y` returns before keyboard selection or movement. Automatic focus panning also stops when keyboard accessibility is disabled. Do not disable all keyboard behavior merely to prevent editing. [Installed runtime][runtime]

For an explanation reader:

1. Disable dragging, connecting, reconnecting, and deletion. Set `deleteKeyCode={null}` explicitly.
2. Keep a deliberate keyboard inspection path: native buttons inside nodes, or focusable selectable wrappers with correctly wired inspection state.
3. Give each node and relationship a meaningful accessible name. Describe the relationship's action and direction.
4. Provide equivalent source access and explanation text outside the visual canvas.
5. Preserve visible focus and offer an explicit way to restore the readable viewport.
6. Honor reduced motion for authored animation and viewport transitions.

These are recommended integration rules. The package defaults include editable behavior, with `Backspace` as the deletion key. The existing workflow viewer disables element selection and uses inner buttons. That implementation does not automatically provide keyboard selection for a new diagram viewer. [Installed runtime][runtime] [Workflow viewer][workflow]

## Evaluation criteria

Before choosing React Flow for every generated figure, compare the same semantic example through both approaches. Use an architectural slice, a component relationship, and a sequence with a return or asynchronous message.

The evaluation needs to establish readable labels in the actual pane, stable geometry during selection, usable edge targets, and keyboard access to evidence. It must also establish predictable document scrolling, complete still-state meaning, and viewport recovery after resize. Browser checks belong in Docker under the repository's instructions. [Agent instructions][agents]

React Flow is already an MIT dependency, so this proposal needs no new canvas package. Layout quality and evidence quality remain separate work. [Installed package][package]

[package]: https://unpkg.com/@xyflow/react@12.12.1/package.json
[runtime]: https://unpkg.com/@xyflow/react@12.12.1/dist/esm/index.js
[props]: https://unpkg.com/@xyflow/react@12.12.1/dist/esm/types/component-props.d.ts
[edge-types]: https://unpkg.com/@xyflow/react@12.12.1/dist/esm/types/edges.d.ts
[layout-guide]: https://reactflow.dev/learn/layouting/layouting
[custom-edges]: https://reactflow.dev/learn/customization/custom-edges
[accessibility]: https://reactflow.dev/learn/advanced-use/accessibility
[workflow]: ../../components/WorkflowGraph.tsx
[workflow-layout]: ../../src/workflow-layout.ts
[viewport]: ../../lib/workflow-viewport.ts
[agents]: ../../AGENTS.md
