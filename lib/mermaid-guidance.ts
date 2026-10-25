/** Shared by whole-review and per-topic generation. */
export const MERMAID_DIRECTIVE = `MERMAID DIAGRAM (optional): Include only when it helps the reviewer understand a non-obvious flow, relationship, or constraint. Omit (null) when it repeats the prose or adds clutter.
- Show behavior and meaningful relationships, not a list of classes or obvious steps.
- Use sequenceDiagram for interactions, asynchronous calls, and event ordering; flowcharts for decisions and transitions; classDiagram for data relationships and type hierarchies.
- Choose the direction to suit the concept. Prefer flowchart LR for a short progression; use TD when a hierarchy or branching structure reads better vertically. Do not force every flow into a tall column or a long horizontal chain.
- Keep the diagram focused: 5–8 nodes maximum, short readable labels, and clearly labeled conditions on branches. Avoid long sentences in nodes. Group repetitive steps instead of drawing every call.
- Make the important paths and where they rejoin visible. Include failure or cleanup paths when they explain the changed behavior; never invent a path that the code does not establish.
- The diagram appears as a compact preview beside the explanation and can be expanded. Favor a balanced shape over a very tall or very wide layout. Leave colors, fonts, and backgrounds to the app's theme.
- Return Mermaid source in mermaidDiagram, without Markdown fences.`;
