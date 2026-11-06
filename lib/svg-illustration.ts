import type { MechanismEvidence } from './mechanism';
import { normalizeDiagramExploration, type DiagramExploration } from './diagram-exploration';

/** The visual grammar is authored, not selected from a renderer's node catalog. */
export interface SvgIllustration {
  version: 1;
  title: string;
  takeaway: string;
  assumptions: string;
  exploration?: DiagramExploration;
  plan: {
    question: string;
    visualApproach: string;
    whyThisForm: string;
    encodings: string;
    /** What movement explains; empty when a still picture suffices. */
    motion: string;
    /** Optional for saved v1 artifacts, required by current generation prompts. */
    prediction?: string;
    restingState?: string;
  };
  scenarios: {
    id: string;
    title: string;
    input: string;
    frames: { title: string; caption: string; svg: string; evidence?: MechanismEvidence }[];
  }[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= limit;

export function normalizeSvgIllustration(value: unknown): SvgIllustration | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    !text(value.title, 120) ||
    !text(value.takeaway, 300) ||
    !text(value.assumptions, 700) ||
    !object(value.plan)
  )
    return null;
  const p = value.plan;
  const exploration = value.exploration == null ? undefined : normalizeDiagramExploration(value.exploration);
  if (exploration === null) return null;
  if (
    !text(p.question, 300) ||
    !text(p.visualApproach, 500) ||
    !text(p.whyThisForm, 500) ||
    !text(p.encodings, 700) ||
    typeof p.motion !== 'string' ||
    p.motion.length > 500 ||
    (p.prediction !== undefined && !text(p.prediction, 500)) ||
    (p.restingState !== undefined && !text(p.restingState, 500))
  )
    return null;
  if (!Array.isArray(value.scenarios) || !value.scenarios.length || value.scenarios.length > 4) return null;
  const scenarios: SvgIllustration['scenarios'] = [];
  const ids = new Set<string>();
  let bytes = 0;
  for (const s of value.scenarios) {
    if (
      !object(s) ||
      !text(s.id, 40) ||
      ids.has(s.id) ||
      !text(s.title, 80) ||
      !text(s.input, 300) ||
      !Array.isArray(s.frames) ||
      !s.frames.length ||
      s.frames.length > 12
    )
      return null;
    ids.add(s.id);
    const frames: SvgIllustration['scenarios'][number]['frames'] = [];
    for (const f of s.frames) {
      if (
        !object(f) ||
        !text(f.title, 100) ||
        !text(f.caption, 350) ||
        !text(f.svg, 35000) ||
        !/^\s*<svg[\s>]/i.test(f.svg)
      )
        return null;
      bytes += f.svg.length;
      if (bytes > 180000) return null;
      let evidence: MechanismEvidence | undefined;
      if (f.evidence != null) {
        if (
          !object(f.evidence) ||
          !text(f.evidence.filePath, 500) ||
          !Number.isSafeInteger(f.evidence.startLine) ||
          Number(f.evidence.startLine) < 1
        )
          return null;
        evidence = { filePath: f.evidence.filePath, startLine: Number(f.evidence.startLine) };
      }
      frames.push({ title: f.title, caption: f.caption, svg: f.svg, ...(evidence ? { evidence } : {}) });
    }
    scenarios.push({ id: s.id, title: s.title, input: s.input, frames });
  }
  return {
    version: 1,
    title: value.title,
    takeaway: value.takeaway,
    assumptions: value.assumptions,
    ...(exploration ? { exploration } : {}),
    plan: {
      question: p.question,
      visualApproach: p.visualApproach,
      whyThisForm: p.whyThisForm,
      encodings: p.encodings,
      motion: p.motion,
      ...(typeof p.prediction === 'string' ? { prediction: p.prediction } : {}),
      ...(typeof p.restingState === 'string' ? { restingState: p.restingState } : {}),
    },
    scenarios,
  };
}

/** Shared by planning, drawing, and the independent rendered critic. */
export const VISUAL_COMPREHENSION_DIRECTIVE = `PERCEPTUAL CLARITY
- Put the decisive relationship in the picture. For a quantitative constraint, consider a shared scale, extent, or visible remaining space so the reader can SEE the comparison without doing arithmetic. For a condition, make the relevant values and their roles immediately comparable. Choose an encoding appropriate to the source; these are reasoning principles, not required diagram templates.
- Keep short role labels and values, but test the picture without its captions: can a reader locate the relevant responsibilities and relationship, or the attempt, constraint, and consequence when explaining a local decision? A code listing or prose inside a rectangle fails this test. Do not make the reader reconstruct the mechanism from WHERE clauses, status codes, or dense sentences.
- Spatial order and movement must agree. Make origins, destinations and the active edge unambiguous. A moving object must not visually pass through unrelated objects or cross a boundary the mechanism forbids. Do not rely on a caption to correct a misleading route.
- Establish one focal operation before asking the reader to compare independent executions or exceptions. Separate cases when simultaneous movement divides attention; show cases together only when their aligned contrast is itself the lesson. Each case needs an obvious identity in the drawing, not only in assumptions. Avoid introducing the general rule and its exception as two unexplained parallel animations.
- Playback must earn its controls. Each step must expose a meaningful action, attempted action, transformation or constraint. A border change, new footer, or a revealed result sentence does not by itself justify a timeline. Use a legible static comparison when it teaches the decision directly; use animation when following the same entities makes the causal relationship clearer. Never imply that an atomic operation consists of separately observable checks and writes.`;

/** Shared editorial standard for the planner, SVG author, and rendered critic. */
export const DIAGRAM_COMPOSITION_DIRECTIVE = `DRAW THE CAUSAL STORY
- Answer one reader question. Identify the trigger, the important change or relationship, and its consequence. Choose a composition that makes that explanation visible. Do not turn the source into a component inventory or impose a three-step timeline on a static relationship.
- Choose the abstraction explicitly. A behavior diagram explains what each responsibility does and how an effect reaches the next one. A reference diagram explains exact calls, pointers, or ownership. Default to behavior when the question is how a change works. Do not mix a behavior walkthrough with an exhaustive reference map.
- Keep the causal chain complete. Preserve an intermediate responsibility when it explains how the effect propagates or prevents a false direct relationship. Name each connection by its meaning: what is inherited, consulted, transferred, or changed. In a behavior diagram, orient links along the effect being explained; do not reverse the reading path merely to reproduce pointer direction. A verified multi-hop influence can be shown as such; never label it as a direct reference, call, copied value, or pushed update. Put exact symbols and reference wiring in inspection unless that wiring is the lesson.
- Make space carry meaning. Use real ownership boundaries, collaboration lanes, or phase groups only when they help this source. Arrange the main explanation in a deliberate reading direction. Prefer short role names and action labels; keep values with their owners. A familiar engineering term can stay, but unexplained letters, formulas, and miniature implementation notes must not carry the story.
- Separate primary behavior from independent policy. Put retries, cancellation, capacity rules, and other side stories in inspection when they do not explain the depicted outcome. Keep a necessary qualification beside the affected action, using the shortest accurate condition. Do not draw a second subsystem just to enumerate its safeguards.
- In a walkthrough, retain the same participants and work items. Show the actual state change and how it matters next, not just a new border or caption. Keep earlier causes visible; do not imply an immediate side effect when the code only observes the change later. Static pictures remain preferable when movement adds no understanding.
- Give the reader a visual hierarchy: responsibilities first, the current action or decisive value next, supporting detail last. Use consistent shapes and line styles, restrained color with labels, and clear space around arrows. Fit labels inside their own shapes with padding; wrap or shorten them rather than shrinking type or crowding connections. No decorative grids, glow, or repeated context badges. The picture must explain its takeaway before clicking; inspection adds precision, not missing causality.`;

export const ARCHITECTURE_TEACHING_DIRECTIVE = `ORIENTATION BEFORE DETAIL
Choose the altitude before the visual form. Ask what the reviewer is missing:
- Where does this change fit? Show the affected architecture and its immediate neighbors.
- Who owns which responsibility or state? Show components and meaningful boundaries.
- How does an operation cross components? Show stable participants, ordered messages, conditions, and outcomes.
- Where do values go? Show actual producers, transformations, and consumers.
- Why does a local algorithm work? Use a custom spatial illustration of the transformation or constraint.
Choose the smallest connected slice that answers that question. A helper, variable, or imported library does not automatically deserve an actor. Keep useful unchanged context; omit independent side stories. Prefer architecture or sequence when the change crosses responsibilities, but do not invent an overview for a self-contained change. Usefulness determines the form and amount, not a quota.
Every relationship must follow inspected source: an import is not proof of a runtime call. Trace actual callers, readers, writers, conditions, and side effects. Never invent an edge to connect a walkthrough. Narrow the claim or name the unknown when context is absent.
Keep identities consistent across prose, diagrams, and source links. Mark the changed responsibility with text as well as emphasis when source establishes the change. Focus on how the resulting system works; before/after is useful when a relationship itself changes.
${DIAGRAM_COMPOSITION_DIRECTIVE}`;

export const VISUAL_PLANNING_DIRECTIVE = `VISUAL DESIGN DECISION
${ARCHITECTURE_TEACHING_DIRECTIVE}
First ask: what type of diagram or illustration would explain THIS mechanism best? Do this before choosing any shapes.
A diagramBrief must state the specific question, the insight, and a free-form visualApproach naming the abstraction (behavior or exact wiring), entry point, reading direction, meaningful groups, and decisive visual relationship. Explain WHY that composition fits this source and which details belong in inspection rather than the first view. Consider alternatives internally; choose the one that minimizes the reader's reasoning effort. The same visual shape is not a default for different mechanisms.
Reason from the code's difficult relationship. Decide what position, size, alignment, containment, connection, or movement should mean. These are design tools, not a catalog of required diagram types. You may combine techniques or invent a composition. Keep values with their owners; a variable does not automatically need its own actor or box.
Decide what unfamiliar outcome the reader should be able to predict after studying the visual. Plan BOTH its spatial meaning and its behavior: what should move, change, stop, or remain fixed, and what cause or constraint does that reveal? When understanding requires mentally simulating a transformation, ordering, or interaction, show that change with meaningful animation. A useful paused view and useful motion can coexist. Choose a static picture deliberately when relationships alone teach the rule; do not default to static just because a final result can be drawn. Omit the visual entirely when prose or code is clearer. Never decorate a list with boxes and arrows.
${VISUAL_COMPREHENSION_DIRECTIVE}
Your plan is provisional until checked against full source. Preserve constraints, ownership and atomicity. Do not imply facts that the source does not establish.`;

export const ILLUSTRATION_PLANNER_DIRECTIVE = `${VISUAL_PLANNING_DIRECTIVE}

DIAGRAM PLAN: Decide the understanding the reviewer needs BEFORE choosing a picture or walkthrough. The goal is HOW THE CHANGE WORKS, with less mental effort than prose/code alone.
For each topic, return diagramBrief: null when prose or inline code explains it more directly. Otherwise return a teaching contract:
- question: one specific question about the mechanism, constraint or failure that the visual will answer.
- takeaway: what the reviewer should be able to explain or predict afterward. State an observable consequence, not "understand the architecture".
- assumedKnowledge: basic engineering knowledge and concepts planned earlier that need no re-teaching. Do not assume familiarity with this repository's domain or internals.
- essentialConcepts: the minimal causal relationships that explain the answer, including the responsibility or state needed at each link. Each item must explain how the cause produces the consequence. Put independent source facts under omit, even when they matter elsewhere in the implementation.
- omit: independent behavior, incidental calls, fields, and background knowledge to leave in inspection, code, or another topic. A rule can matter to the implementation without belonging in this picture. Preserve a condition, owner, ordering, or atomicity boundary when it qualifies a claim actually depicted; do not expand the question to include every correctness concern in the source.
- visualApproach: give a concise composition brief, not a second source summary. Name the entry point, reading direction, meaningful groups, decisive relationship, and details reserved for inspection. Choose the simplest useful form AFTER the above: a static relationship, concrete state example, execution walkthrough or justified comparison. Explain why space or state makes this easier than prose. For cross-component changes, prefer a component map, architecture overview or sequence. For changing values, queues, ownership or consequential ordering, consider a purpose-designed SVG illustration whose spatial encoding exposes the relevant rule. Author static maps and sequence diagrams as custom SVG too; use meaningful animated SVG frames when following state or order aids understanding. D2 and the old mechanism format are for saved explanations only, not new generation. Choose from the reasoning needed, without a default composition. Explicitly consider whether following a transformation would reduce mental simulation. For a race, show the conflicting values or ownership unless the interleaving itself is the concept being taught.
- For branching behavior, plan a decision flow with named conditions and outcomes. When repeated outcomes represent the same behavior, combine them. If the content is a list or lookup table, plan concise Markdown instead. Return diagramBrief: null for that topic.
Coordinate teaching goals across the whole PR/stack. Assign a repeated concept to one topic; other topics should build on it. Plan orientation when the reviewer needs it to understand the affected components, and let later topics build on those identities. An overview is not mandatory for a local change. Before/after is secondary to explaining the current mechanism. There is no diagram, node or step quota: usefulness determines the amount.
The hunk index is incomplete evidence. Treat takeaways as proposals to verify, not established guarantees. The writer must revise or reject the brief when the actual source disagrees.`;

export const SVG_ILLUSTRATION_DIRECTIVE = `PURPOSE-DESIGNED SVG ILLUSTRATIONS
${VISUAL_PLANNING_DIRECTIVE}
You can now author the actual SVG composition. You are NOT restricted to rectangular nodes, a grid, or an arrow diagram. The host controls playback, theming, safety, and transitions; you control visual reasoning and geometry.
First write the illustration's plan, then its SVG frames. When the supplied diagramBrief identifies a useful visual question supported by the source, deliver that illustration as svgIllustration. Revise the proposed composition when a clearer visual demands it. Omit a planned illustration only when source inspection shows its premise is wrong or the picture would add no understanding; prose describing the same behavior is not by itself a reason to skip the visual. Do not borrow the shape of unrelated examples. A useful visual lets the reader see the decisive relationship without first decoding paragraphs in boxes.
Return svgIllustration:null when no visual helps. Otherwise use:
{"version":1,"title":string,"takeaway":string,"assumptions":string,
 "plan":{"question":string,"visualApproach":string,"whyThisForm":string,"encodings":string,"motion":string,"prediction":string,"restingState":string},
 "scenarios":[{"id":string,"title":string,"input":string,"frames":[{"title":string,"caption":string,"svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 560 300\\">...</svg>","evidence":{"filePath":string,"startLine":number}|null}]}]}
- plan.question names the reader's question. visualApproach names YOUR chosen composition. whyThisForm explains why the spatial representation reduces reasoning effort. encodings states what position, size, color, boundaries, and connections actually mean. prediction states a concrete outcome the reader should be able to infer for a different source-supported input. motion is an explicit animation brief: identify what changes, what stays fixed, and the decisive cause/constraint the transition reveals; for a static picture state why motion would add no understanding. restingState states what evidence remains visible for inspection after motion stops. Do not output a chain of thought or alternative candidates.
- Design freely within a readable SVG canvas. Use geometry, proportion, ordering, negative space, paths, text, and containment to EXPOSE the rule. Related objects may differ in shape and size when that conveys meaning. Generic participants sending a token are useful only when that communication is itself the insight.
- Use one custom SVG illustration per topic, or none. Static maps, sequence diagrams, and animated walkthroughs all use svgIllustration. Do not generate D2 or the old mechanism format. Always set mechanism:null and d2Diagram:null; the legacy renderers remain for saved explanations only. When svgIllustration is present, set d2Diagram:null and explainerIdea:null. Do not repeat the illustration's input cases as narrative prose; narrative adds rationale only.
- Frames are complete SVG snapshots at meaningful moments, not one frame per call or line. A single-frame illustration is supported when the animation brief justifies it. Do not collapse a temporal explanation into only its final result. Preserve identity and enough visible history to relate the states. Choose small revealing cases; vary one causal condition when comparing outcomes rather than silently changing several inputs. Stop once the mechanism is clear; additional cases are optional. At most 4 scenarios and 12 frames each, total SVG markup below 180 KB, each frame below 35 KB. These are safety ceilings, not content targets.
- Every frame uses the SAME viewBox and stable background geometry across steps and scenarios. Keep the coordinate extent compact: width 300–900, height 140–600. It must work in a 440px-wide explanation pane without tiny text. Every label must render at least 12px high: font-size must be at least ceil(12 * max(viewBoxWidth / 440, viewBoxHeight / 480)), including secondary labels. For width 560 use at least 16, width 620 at least 17, width 800 at least 22. Increasing the viewBox without increasing text shrinks labels on screen; use fewer labels or a tighter canvas before scaling everything down. Avoid oversized headers; host supplies the title and caption.
- Use short labels, explicit units, and truthful proportions. If length encodes a value, label its scale and make lengths match values. If spacing is schematic, say so in assumptions. Never invent timings or performance measurements. Show the consequential predicate, boundary, or invariant, not plumbing. A paused frame must be useful.
- Give independently moving SVG groups a stable data-motion-id for the same logical object across frames. Wrap its shape and label together in <g data-motion-id="..." transform="translate(x y)">; keep the local geometry unchanged when moving. Do not nest keyed groups. Keep background geometry still. The host moves keyed groups between their saved positions; you must not output SMIL, CSS animations, JavaScript, timers, or event handlers. Use meaningful intermediate frames if arrival must precede a result. Values and outcomes change at frame boundaries, not at the end of movement: include an arrival frame before a separate result frame when that order matters. Entities that exchange positions can overlap on a straight path: use a separated intermediate route if their identity would become unreadable. A moving dot or changing highlight does not substitute for showing the mechanism. Avoid animating a background group simply because a label changed.
- Use only svg,g,path,rect,circle,ellipse,line,polyline,polygon,text,tspan,defs,marker,clipPath,linearGradient,radialGradient,stop,title,desc. No style elements, foreignObject, images, use, external URLs, scripts, HTML, or embedded controls. No inline style attributes. SVG presentation attributes (fill, stroke, transform, font-size, etc.) are supported.
- Colors: var(--ink), var(--muted), var(--paper), var(--line), var(--accent), var(--success), var(--warning), var(--danger). Use these theme tokens. Use ink or muted for neutral text, line for diagram strokes, and the accent/status tokens to reinforce meaning. Never rely on color alone. Fonts are system sans-serif; host owns the font family. Labels must remain inside viewBox with padding. Leave clearance between labels and unrelated marks; short captions belong outside SVG in caption, not a text wall within it.
- Evidence uses exact supplied source paths and new-file lines, or null if unavailable. Assumptions name illustrative inputs and any simplification. State changes, captions, and takeaway must agree with the source and each other.
- Before returning, check: can the reader SEE why the decisive outcome happens? Would a simpler visual explain it better? Does motion clarify cause rather than merely announce the next frame? Revise or omit accordingly.`;

/** Optional semantics let the host explore the authored drawing without replacing its geometry. */
export const SVG_EXPLORATION_DIRECTIVE = `EXPLORABLE DIAGRAMS
For component, architecture, sequence or dataflow diagrams, add optional exploration metadata to svgIllustration. Keep custom SVG as the actual composition. The host will let readers select its entities, inspect direct relationships, and open supporting source. No separate node layout or coordinates are needed.
"exploration": {"kind":"architecture"|"component"|"sequence"|"dataflow",
 "entities":[{"id":"cache","label":"Snapshot cache","summary":"Owns the last complete snapshot.","change":"changed"|"context","evidence":{"filePath":"src/cache.ts","startLine":42}|null}],
 "relationships":[{"id":"read-cache","from":"service","to":"cache","label":"Read snapshot","summary":"Reads the saved revision before requesting remote data.","evidence":{"filePath":"src/service.ts","startLine":51}|null}]}
This is a shape example, not source facts. Use identities, labels and responsibilities from the actual source. IDs start with a letter and contain only letters, digits, underscores or hyphens (max 60). Entity and relationship IDs share one unique namespace. Endpoints must refer to existing entities. Maximum 24 entities and 48 relationships are safety ceilings, not targets. Omit exploration for a local illustration that has no useful component identities.
Wrap each complete selectable participant or component (shape plus label) in <g data-entity-id="cache">. Wrap each corresponding drawn connection and label in <g data-relationship-id="read-cache">. Every declared ID must have exactly one matching group in EVERY frame; keep the whole diagram visible and focus steps through emphasis rather than deleting participants or messages. Do not nest selectable groups. Groups may contain ordinary nested geometry. Place real boundaries around their members, outside selectable groups. Participants keep the same positions across frames. Sequence message order follows a clear time direction; distinguish requests, responses and asynchronous work without pretending animation duration is execution time.
Write brief responsibilities and relationship explanations, not duplicate captions. Evidence must resolve to supplied source at the displayed revision; use null when unavailable. A relationship needs its own evidence when a component citation does not establish the call or condition. The reviewer can explore the picture without starting any new generation or network request.
The SVG must remain understandable before selection. Mark changed components with short visible text as well as accent color. The change:"context" field is metadata; do not print "Context" repeatedly on the diagram. Use clear responsibility labels in the drawing and exact symbols in the source/details. Avoid a large in-picture title, invented metrics, neon glows, decorative grids, and tiny annotations. The host already supplies a title, explanation and controls.`;
