/** Declarative SVG scenes. Generated content is data, never executable markup. */
export interface MechanismEvidence {
  filePath: string;
  startLine: number;
}
export interface MechanismNode {
  id: string;
  label: string;
  kind: 'queue' | 'record' | 'actor';
  column: number;
  row: number;
}
export interface MechanismEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}
export interface MechanismState {
  id: string;
  value: string;
  items?: string[];
  tone?: 'neutral' | 'active' | 'success' | 'warning';
}
export interface MechanismEvent {
  title: string;
  caption: string;
  /** Complete snapshots make seeking independent of playback history. */
  states: MechanismState[];
  focus: string[];
  /** Transfer arrives before this event's state is applied. */
  transfer?: { edge: string; label: string };
  evidence?: MechanismEvidence;
}
export interface MechanismScene {
  version: 1;
  title: string;
  takeaway: string;
  /** State which inputs are illustrative and which behavior is source-backed. */
  assumptions: string;
  nodes: MechanismNode[];
  edges: MechanismEdge[];
  scenarios: { id: string; title: string; input: string; events: MechanismEvent[] }[];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= limit;
const id = (v: unknown): v is string => string(v, 40) && /^[a-zA-Z][\w-]*$/.test(v);
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;

/** Reject malformed scenes as a whole: trimming steps can change their meaning. */
export function normalizeMechanism(value: unknown): MechanismScene | null {
  if (
    !record(value) ||
    value.version !== 1 ||
    !string(value.title, 100) ||
    !string(value.takeaway, 240) ||
    !string(value.assumptions, 400)
  )
    return null;
  if (
    !list(value.nodes, 6) ||
    value.nodes.length < 2 ||
    !list(value.edges, 6) ||
    !list(value.scenarios, 4) ||
    !value.scenarios.length
  )
    return null;
  const ids = new Set<string>();
  const positions = new Set<string>();
  const nodes: MechanismNode[] = [];
  for (const n of value.nodes) {
    if (
      !record(n) ||
      !id(n.id) ||
      ids.has(n.id) ||
      !string(n.label, 40) ||
      !['queue', 'record', 'actor'].includes(String(n.kind)) ||
      !Number.isInteger(n.column) ||
      !Number.isInteger(n.row) ||
      Number(n.column) < 0 ||
      Number(n.column) > 2 ||
      Number(n.row) < 0 ||
      Number(n.row) > 1
    )
      return null;
    const position = `${Number(n.column)}:${Number(n.row)}`;
    if (positions.has(position)) return null;
    ids.add(n.id);
    positions.add(position);
    nodes.push({
      id: n.id,
      label: n.label,
      kind: n.kind as MechanismNode['kind'],
      column: Number(n.column),
      row: Number(n.row),
    });
  }
  const edgeIds = new Set<string>();
  const edges: MechanismEdge[] = [];
  for (const e of value.edges) {
    if (
      !record(e) ||
      !id(e.id) ||
      ids.has(e.id) ||
      edgeIds.has(e.id) ||
      !string(e.from, 40) ||
      !ids.has(e.from) ||
      !string(e.to, 40) ||
      !ids.has(e.to) ||
      e.from === e.to ||
      !string(e.label, 32)
    )
      return null;
    edgeIds.add(e.id);
    edges.push({ id: e.id, from: e.from, to: e.to, label: e.label });
  }
  const scenarios: MechanismScene['scenarios'] = [];
  const scenarioIds = new Set<string>();
  for (const s of value.scenarios) {
    if (
      !record(s) ||
      !id(s.id) ||
      scenarioIds.has(s.id) ||
      !string(s.title, 60) ||
      !string(s.input, 180) ||
      !list(s.events, 16) ||
      s.events.length < 2
    )
      return null;
    scenarioIds.add(s.id);
    const events: MechanismEvent[] = [];
    for (const [index, e] of s.events.entries()) {
      if (
        !record(e) ||
        !string(e.title, 80) ||
        !string(e.caption, 260) ||
        !list(e.states, 6) ||
        e.states.length !== nodes.length ||
        !list(e.focus, 12) ||
        !e.focus.every((f) => typeof f === 'string' && (ids.has(f) || edgeIds.has(f)))
      )
        return null;
      const states: MechanismState[] = [];
      const seen = new Set<string>();
      for (const state of e.states) {
        if (
          !record(state) ||
          typeof state.id !== 'string' ||
          !ids.has(state.id) ||
          seen.has(state.id) ||
          !string(state.value, 64) ||
          (state.tone !== undefined &&
            (typeof state.tone !== 'string' || !['neutral', 'active', 'success', 'warning'].includes(state.tone)))
        )
          return null;
        if (
          state.items !== undefined &&
          (!list(state.items, 4) ||
            !state.items.every((i) => string(i, 10)) ||
            nodes.find((n) => n.id === state.id)?.kind !== 'queue')
        )
          return null;
        seen.add(state.id);
        states.push({
          id: state.id,
          value: state.value,
          ...(state.items ? { items: state.items } : {}),
          ...(state.tone ? { tone: state.tone as MechanismState['tone'] } : {}),
        });
      }
      let transfer: MechanismEvent['transfer'];
      if (e.transfer != null) {
        if (
          !index ||
          !record(e.transfer) ||
          typeof e.transfer.edge !== 'string' ||
          !edgeIds.has(e.transfer.edge) ||
          !string(e.transfer.label, 20)
        )
          return null;
        transfer = { edge: e.transfer.edge, label: e.transfer.label };
      }
      let evidence: MechanismEvidence | undefined;
      if (e.evidence != null) {
        if (
          !record(e.evidence) ||
          !string(e.evidence.filePath, 500) ||
          !Number.isSafeInteger(e.evidence.startLine) ||
          Number(e.evidence.startLine) < 1
        )
          return null;
        evidence = { filePath: e.evidence.filePath, startLine: Number(e.evidence.startLine) };
      }
      events.push({
        title: e.title,
        caption: e.caption,
        states,
        focus: e.focus as string[],
        ...(transfer ? { transfer } : {}),
        ...(evidence ? { evidence } : {}),
      });
    }
    scenarios.push({ id: s.id, title: s.title, input: s.input, events });
  }
  return {
    version: 1,
    title: value.title,
    takeaway: value.takeaway,
    assumptions: value.assumptions,
    nodes,
    edges,
    scenarios,
  };
}

/** Each event occupies one teaching beat, not a claim about execution time. */
export function mechanismFrame(events: MechanismEvent[], position: number, reducedMotion = false) {
  const at = Math.max(0, Math.min(events.length - 1, Number.isFinite(position) ? position : 0));
  const previous = Math.floor(at);
  const next = Math.min(events.length - 1, Math.ceil(at));
  const progress = at - previous;
  // The first 65% moves the payload. The state then changes and holds for reading.
  const arrived = progress >= 0.65;
  const stateIndex = arrived ? next : previous;
  return {
    event: events[stateIndex],
    index: stateIndex,
    upcoming: events[next],
    progress: Math.min(1, progress / 0.65),
    transfer: !reducedMotion && next !== previous && !arrived ? events[next].transfer : undefined,
  };
}

export const MECHANISM_DIRECTIVE = `ANIMATED SVG MECHANISMS
Alongside optional d2Diagram, you can return mechanism: a declarative animated SVG scene. Choose ONE visual per topic. Use mechanism when ordering, queue contents, ownership, or changing values make the change easier to predict. Use D2 for a static relationship map. Use neither for lists, obvious code, or decorative summaries. Keep the existing teaching contract; focus on how the changed code works, not obligatory before/after.
Gnosis draws the scene, owns the clock, and validates it. Do not generate HTML, SVG, JavaScript, coordinates, or timers. All labels are plain text. Playback beats are not elapsed milliseconds.
Schema (mechanism may be null):
{
 "version":1,"title":"One question answered", "takeaway":"One concise observable consequence", "assumptions":"Identify illustrative inputs; no invented measurements or guarantees",
 "nodes":[{"id":"pending","label":"Pending queue","kind":"queue|record|actor","column":0,"row":0}],
 "edges":[{"id":"dispatch","from":"pending","to":"worker","label":"Dispatch"}],
 "scenarios":[{"id":"normal","title":"At capacity","input":"Weights [8,5,3], limit 12 (illustrative)","events":[
   {"title":"A meaningful event","caption":"One short causal sentence", "states":[{"id":"pending","value":"Waiting for capacity","items":["8","5","3"],"tone":"neutral|active|success|warning"}],"focus":["pending"],"transfer":null,"evidence":{"filePath":"exact path","startLine":1}}
 ]}]
}
Rules:
- 2–6 nodes on a fixed grid: column 0–2, row 0–1; unique occupied positions. Prefer 2–3 nodes in a single row. Label at most 40 characters. A node is a responsibility or stored state, never a sentence of prose. Keep total weight inside the batch node; keep a response/status inside its client node. Do not turn fields or return values into extra actors. Actor = participant; record = stored value; queue = ordered items.
- Up to 6 edges, unique IDs distinct from nodes, existing from/to IDs, no self edges; short verb/payload label (max 32). Connections must explain a real relationship, not link a list for decoration.
- 1–4 scenarios, each 2–16 meaningful events. Prefer one main case plus one revealing boundary case when supported. Each scenario has explicit illustrative input. Reuse exactly the same nodes and layout for every scenario and step.
- EVERY event contains a COMPLETE states array, once per node. value is at most 64 characters. Queue items: 0–4 short strings (at most 10 characters); do not silently omit queued items. Show smaller concrete inputs instead. Other node kinds have no items. Preserve object names across steps.
- First event is a useful starting snapshot with no transfer. Later events may use transfer:{"edge":"edge ID","label":"payload (max 20 chars)"}. The payload moves along that edge BEFORE the target state changes. The event's states represent the result AFTER arrival. Do not claim results before the decisive check runs.
- focus names relevant node or edge IDs. Changes and state values carry the meaning; color only reinforces it. Captions explain cause, not 'Step 2'. title max 80, caption max 260.
- Use the same values in inputs, states, captions, and takeaway. Derived results must follow the actual code. Distinguish an assumed sample from a source-backed rule. Never invent latency numbers, tests passing, ownership guarantees, or atomicity.
- evidence is an exact supplied source file and new-file line where available; otherwise null. Never invent line numbers. Keep important conditions and failure paths visible.
- The initial scene plus takeaway should already help while paused. Later steps add understanding. Do not add one frame per function call.
- Let the scene carry the concrete input cases. Keep narrative to the rationale or significance; do not repeat the scenarios and their values as a prose paragraph. Use short Markdown bullets if more than one point remains.
- Return d2Diagram:null when mechanism is present. Return mechanism:null when it offers no benefit. Do not repeat the same scene as an explainerIdea; expansion already provides playback and scenario exploration. Existing free-form explorations remain available when a real simulation needs arbitrary inputs beyond these source-grounded traces.`;
