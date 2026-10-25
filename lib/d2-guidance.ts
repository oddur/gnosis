/** Prototype prompt: native D2 syntax, TALA layout, offline icons, optional board walkthrough. */
export const D2_DIRECTIVE = `D2 DIAGRAM (optional): Use D2 with TALA to explain a non-obvious relationship, invariant, protocol, or architectural change. Usefulness is the barometer, not diagram count. Return null if a diagram adds no understanding.
- Return d2Diagram: {"source": string, "caption": string, "steps": [{"title": string, "description": string}]} or null. Source is valid D2 without Markdown fences. Do NOT generate Mermaid.
- Prefer architecture diagrams with nested containers for ownership/runtime/trust boundaries. TALA supports direction: right/down at each container. Label connections with what moves or what must hold. Use shape: cylinder for persistent data, queue/page/class/sql_table only when they clarify the concept. Keep labels short; choose a balanced layout.
- For interactions use shape: sequence_diagram. Declare all actors first, in reading order. Connections appear in source order. Notes use unconnected children of an actor: app.note: "Pin displayed SHA". Activation spans use actor child objects connected by messages. Use native sequence groups for meaningful phases, never invent events or guarantees.
- Icons are bundled and offline: icon: gnosis:user, gnosis:server, gnosis:database, gnosis:queue, gnosis:cloud, gnosis:shield, gnosis:code. Use them for semantic component roles, not decoration. Do not use external URLs, imports, custom images, HTML, links or data URIs.
- Explain subtle details with tooltip: "Why this boundary or invariant matters" on nodes/edges. These appear as readable annotations in the expanded viewer. Use the caption for the central takeaway. Avoid repeating obvious labels.
- Use style.animated: true on a few edges when direction/concurrency matters. Motion starts only when the reviewer chooses Play or Animate flow. The static diagram must remain understandable.
- For a meaningful walkthrough, use native steps: { board_name: { changes } } (each inherits the previous) or scenarios: { board_name: { changes } } (each inherits the root). Prefer scenarios for a sequence: retain all actors/messages and emphasize relevant edges with style.stroke-width: 4 so the layout stays stable. A connection override is (app -> api)[0].style.stroke-width: 4. Do not recreate the same edge accidentally.
- Supply steps metadata in the rendered order: root/overview first, then top-level steps, then top-level scenarios. Each needs a short title and an insightful description explaining causality, state, a failure condition, or a reviewer question. Three to five frames usually suffice; maximum 12. Omit steps metadata for a static diagram. Do not nest boards.
- Before/after architectural changes can use steps; delete a connection with (a -> b)[0]: null. Show new ownership and failure boundaries, not just new boxes.
- Use native D2 text, notes, containers and tooltips. Leave theme, padding, fonts and background to the app. Avoid explicit colors; use emphasis, edge weight, shape and grouping. Fit the concept into a laptop preview; split genuinely large concepts across slides instead of making a tall wall of nodes.
Example source:
direction: right
api: API { icon: gnosis:server }
jobs: Durable jobs { shape: cylinder; icon: gnosis:database; tooltip: "Persist before acknowledging so a crash cannot lose accepted work." }
worker: Worker { icon: gnosis:code }
api -> jobs: persist
jobs -> worker: claim { style.animated: true }
Always ground the diagram in the supplied code. Clearly distinguish existing behavior from proposed changes. Never imply atomicity, persistence, retries, ordering or authorization that the code does not establish.`;
