import type { MechanismEvidence } from './mechanism';

/** The visual grammar is authored, not selected from a renderer's node catalog. */
export interface SvgIllustration {
  version: 1;
  title: string;
  takeaway: string;
  assumptions: string;
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
- Keep short role labels and values, but test the picture without its captions: can a reader locate the attempt, the constraint, and the consequence? A code listing or prose inside a rectangle fails this test. Do not make the reader reconstruct the mechanism from WHERE clauses, status codes, or dense sentences.
- Spatial order and movement must agree. Make origins, destinations and the active edge unambiguous. A moving object must not visually pass through unrelated objects or cross a boundary the mechanism forbids. Do not rely on a caption to correct a misleading route.
- Establish one focal operation before asking the reader to compare independent executions or exceptions. Separate cases when simultaneous movement divides attention; show cases together only when their aligned contrast is itself the lesson. Each case needs an obvious identity in the drawing, not only in assumptions. Avoid introducing the general rule and its exception as two unexplained parallel animations.
- Playback must earn its controls. Each step must expose a meaningful action, attempted action, transformation or constraint. A border change, new footer, or a revealed result sentence does not by itself justify a timeline. Use a legible static comparison when it teaches the decision directly; use animation when following the same entities makes the causal relationship clearer. Never imply that an atomic operation consists of separately observable checks and writes.`;

export const VISUAL_PLANNING_DIRECTIVE = `VISUAL DESIGN DECISION
First ask: what type of diagram or illustration would explain THIS mechanism best? Do this before choosing any shapes.
A diagramBrief must state the specific question, the insight, and a free-form visualApproach explaining which spatial relationship will make that insight visible and WHY that form fits this source. Consider alternatives internally; choose the one that minimizes the reader's reasoning effort. The same visual shape is not a default for different mechanisms.
Reason from the code's difficult relationship. Decide what position, size, alignment, containment, connection, or movement should mean. These are design tools, not a catalog of required diagram types. You may combine techniques or invent a composition. Keep values with their owners; a variable does not automatically need its own actor or box.
Decide what unfamiliar outcome the reader should be able to predict after studying the visual. Plan BOTH its spatial meaning and its behavior: what should move, change, stop, or remain fixed, and what cause or constraint does that reveal? When understanding requires mentally simulating a transformation, ordering, or interaction, show that change with meaningful animation. A useful paused view and useful motion can coexist. Choose a static picture deliberately when relationships alone teach the rule; do not default to static just because a final result can be drawn. Omit the visual entirely when prose or code is clearer. Never decorate a list with boxes and arrows.
${VISUAL_COMPREHENSION_DIRECTIVE}
Your plan is provisional until checked against full source. Preserve constraints, ownership and atomicity. Do not imply facts that the source does not establish.`;

export const SVG_ILLUSTRATION_DIRECTIVE = `PURPOSE-DESIGNED SVG ILLUSTRATIONS
${VISUAL_PLANNING_DIRECTIVE}
You can now author the actual SVG composition. You are NOT restricted to rectangular nodes, a grid, or an arrow diagram. The host controls playback, theming, safety, and transitions; you control visual reasoning and geometry.
First write the illustration's plan, then its SVG frames. Use the supplied diagramBrief as a proposal; change it when the source or a clearer visual demands it. Do not borrow the shape of unrelated examples. A useful visual lets the reader see the decisive relationship without first decoding paragraphs in boxes.
Return svgIllustration:null when no visual helps. Otherwise use:
{"version":1,"title":string,"takeaway":string,"assumptions":string,
 "plan":{"question":string,"visualApproach":string,"whyThisForm":string,"encodings":string,"motion":string,"prediction":string,"restingState":string},
 "scenarios":[{"id":string,"title":string,"input":string,"frames":[{"title":string,"caption":string,"svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 560 300\\">...</svg>","evidence":{"filePath":string,"startLine":number}|null}]}]}
- plan.question names the reader's question. visualApproach names YOUR chosen composition. whyThisForm explains why the spatial representation reduces reasoning effort. encodings states what position, size, color, boundaries, and connections actually mean. prediction states a concrete outcome the reader should be able to infer for a different source-supported input. motion is an explicit animation brief: identify what changes, what stays fixed, and the decisive cause/constraint the transition reveals; for a static picture state why motion would add no understanding. restingState states what evidence remains visible for inspection after motion stops. Do not output a chain of thought or alternative candidates.
- Design freely within a readable SVG canvas. Use geometry, proportion, ordering, negative space, paths, text, and containment to EXPOSE the rule. Related objects may differ in shape and size when that conveys meaning. Generic participants sending a token are useful only when that communication is itself the insight.
- Use one visual per topic: svgIllustration, static D2, or none. Set mechanism:null for new output: the old card renderer remains for saved explanations only. When svgIllustration is present, set d2Diagram:null and explainerIdea:null. Do not repeat the illustration's input cases as narrative prose; narrative adds rationale only.
- Frames are complete SVG snapshots at meaningful moments, not one frame per call or line. A single-frame illustration is supported when the animation brief justifies it. Do not collapse a temporal explanation into only its final result. Preserve identity and enough visible history to relate the states. Choose small revealing cases; vary one causal condition when comparing outcomes rather than silently changing several inputs. Stop once the mechanism is clear; additional cases are optional. At most 4 scenarios and 12 frames each, total SVG markup below 180 KB, each frame below 35 KB. These are safety ceilings, not content targets.
- Every frame uses the SAME viewBox and stable background geometry across steps and scenarios. Keep the coordinate extent compact: width 300–900, height 140–600. It must work in a 440px-wide explanation pane without tiny text. Every label must render at least 12px high: font-size must be at least ceil(12 * max(viewBoxWidth / 440, viewBoxHeight / 480)), including secondary labels. For width 560 use at least 16, width 620 at least 17, width 800 at least 22. Increasing the viewBox without increasing text shrinks labels on screen; use fewer labels or a tighter canvas before scaling everything down. Avoid oversized headers; host supplies the title and caption.
- Use short labels, explicit units, and truthful proportions. If length encodes a value, label its scale and make lengths match values. If spacing is schematic, say so in assumptions. Never invent timings or performance measurements. Show the consequential predicate, boundary, or invariant, not plumbing. A paused frame must be useful.
- Give independently moving SVG groups a stable data-motion-id for the same logical object across frames. Wrap its shape and label together in <g data-motion-id="..." transform="translate(x y)">; keep the local geometry unchanged when moving. Do not nest keyed groups. Keep background geometry still. The host moves keyed groups between their saved positions; you must not output SMIL, CSS animations, JavaScript, timers, or event handlers. Use meaningful intermediate frames if arrival must precede a result. Values and outcomes change at frame boundaries, not at the end of movement: include an arrival frame before a separate result frame when that order matters. Entities that exchange positions can overlap on a straight path: use a separated intermediate route if their identity would become unreadable. A moving dot or changing highlight does not substitute for showing the mechanism. Avoid animating a background group simply because a label changed.
- Use only svg,g,path,rect,circle,ellipse,line,polyline,polygon,text,tspan,defs,marker,clipPath,linearGradient,radialGradient,stop,title,desc. No style elements, foreignObject, images, use, external URLs, scripts, HTML, or embedded controls. No inline style attributes. SVG presentation attributes (fill, stroke, transform, font-size, etc.) are supported.
- Colors: var(--ink), var(--muted), var(--paper), var(--line), var(--accent), var(--success), var(--warning), var(--danger). Use these theme tokens. Use ink or muted for neutral text, line for diagram strokes, and the accent/status tokens to reinforce meaning. Never rely on color alone. Fonts are system sans-serif; host owns the font family. Labels must remain inside viewBox with padding. Leave clearance between labels and unrelated marks; short captions belong outside SVG in caption, not a text wall within it.
- Evidence uses exact supplied source paths and new-file lines, or null if unavailable. Assumptions name illustrative inputs and any simplification. State changes, captions, and takeaway must agree with the source and each other.
- Before returning, check: can the reader SEE why the decisive outcome happens? Would a simpler visual explain it better? Does motion clarify cause rather than merely announce the next frame? Revise or omit accordingly.`;
