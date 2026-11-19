import { hiddenBetween, shownLines, type DiffGap, type GapPart } from './diff-gaps';
import { hunkScopes } from './hunk-scopes';
import type { SyntaxDefinition } from './syntax-scope';

/**
 * Show scope: context that follows the code's structure. A hunk normally shows a fixed number of context lines; when
 * the definition around it (function, method, class, impl, test…) is short enough, it shows whole instead.
 *
 * The rule, for each changed hunk:
 * - Take the innermost definition around it (the hunk's breadcrumb, lib/hunk-scopes.ts).
 * - Reveal the whole definition when that costs at most `SCOPE_CONTEXT_BUDGET` lines above the hunks of it that show,
 *   and at most as many below them. Otherwise the hunk keeps its context and "Show whole function".
 * - Two hunks of one definition that both fit join into one view of it when the lines between them are
 *   `SCOPE_JOIN_LINES` or fewer, both of their budgets; a longer stretch between them keeps its gap bar.
 * - Then the next definition out, and the next, while each still fits: a short method in a short class shows the
 *   whole class. Walking out stops at the first definition that does not fit, so a scope is never shown around a
 *   level that was not.
 *
 * Costs are measured from what the diff shows before anything is revealed, so the plan does not change as the reader
 * reveals lines. A definition with a change the view leaves out (an Explanation topic's opaque gap) is not shown.
 */
export const SCOPE_CONTEXT_BUDGET = 10;
export const SCOPE_JOIN_LINES = 2 * SCOPE_CONTEXT_BUDGET;

/** A definition shown whole by the rule, in new line numbers, with the hidden spans that show it. */
export interface ShownScope {
  /** `start`-`end` key, the same in every plan of one file revision. */
  key: string;
  definition: SyntaxDefinition;
  /** New lines to reveal, each with some still hidden. */
  spans: [number, number][];
}

interface ChangedHunk {
  key: string;
  /** First and last new lines the hunk shows; `bottom < top` for a hunk without new lines. */
  top: number;
  bottom: number;
  chain: SyntaxDefinition[];
}

/**
 * The definitions to show whole in a file's diff. `parts` are its hunks and gaps before any reveal, `definitions`
 * both sides' trees (the old side's for hunks that only delete), as hunkScopes reads them.
 */
export function showScopePlan(
  parts: readonly GapPart[],
  gaps: readonly DiffGap[] | undefined,
  definitions: { after?: readonly SyntaxDefinition[]; before?: readonly SyntaxDefinition[] },
  budget = SCOPE_CONTEXT_BUDGET,
  join = 2 * budget
): ShownScope[] {
  if (!gaps || !definitions.after) return [];
  const list = parts as GapPart[];
  const scopes = hunkScopes(list, gaps as DiffGap[], definitions, shownLines(list).after);
  const hunks: ChangedHunk[] = [];
  for (const part of list) {
    if (part.kind !== 'hunk') continue;
    const scope = scopes.get(part.key);
    if (!scope) continue;
    const shown = part.hunk.rows.reduce((n, row) => n + (row.type === '-' ? 0 : 1), 0);
    hunks.push({
      key: part.key,
      top: part.hunk.newStart,
      bottom: part.hunk.newStart + shown - 1,
      chain: scope.chain.flatMap((crumb) => (crumb.provisional ? [] : [crumb.definition])),
    });
  }
  // Every changed hunk, including those outside every definition, bounds what a definition's hunks are.
  const changed: { top: number; bottom: number }[] = [];
  for (const part of list) {
    if (part.kind !== 'hunk' || !part.hunk.rows.some((row) => row.type !== ' ')) continue;
    const shown = part.hunk.rows.reduce((n, row) => n + (row.type === '-' ? 0 : 1), 0);
    changed.push({ top: part.hunk.newStart, bottom: part.hunk.newStart + shown - 1 });
  }
  const opaque = gaps.filter((gap) => gap.opaque);
  const fits = (definition: SyntaxDefinition) => {
    if (opaque.some((gap) => gap.newStart <= definition.end && (gap.newEnd ?? Infinity) >= definition.start)) return undefined;
    const inside = changed.filter((hunk) => hunk.top <= definition.end && Math.max(hunk.top, hunk.bottom) >= definition.start);
    if (!inside.length) return undefined;
    const top = Math.min(...inside.map((hunk) => hunk.top));
    const bottom = Math.max(...inside.map((hunk) => hunk.bottom));
    if (top - definition.start > budget || definition.end - bottom > budget) return undefined;
    return inside.sort((a, b) => a.top - b.top);
  };
  const chosen = new Map<string, { definition: SyntaxDefinition; inside: { top: number; bottom: number }[] }>();
  for (const hunk of hunks) {
    let best: { definition: SyntaxDefinition; inside: { top: number; bottom: number }[] } | undefined;
    for (const definition of [...hunk.chain].reverse()) {
      const inside = fits(definition);
      if (!inside) break;
      best = { definition, inside };
    }
    if (best) chosen.set(`${best.definition.start}-${best.definition.end}`, best);
  }
  // A definition inside another shown one adds nothing.
  const outer = [...chosen.values()].filter(
    ({ definition }) =>
      ![...chosen.values()].some(
        (other) =>
          other.definition !== definition &&
          other.definition.start <= definition.start &&
          other.definition.end >= definition.end &&
          (other.definition.start < definition.start || other.definition.end > definition.end)
      )
  );
  const plan: ShownScope[] = [];
  for (const { definition, inside } of outer.sort((a, b) => a.definition.start - b.definition.start)) {
    const spans: [number, number][] = [];
    const add = (start: number, end: number) => {
      if (start <= end && hiddenBetween(list, start, end)) spans.push([start, end]);
    };
    add(definition.start, inside[0].top - 1);
    for (let i = 1; i < inside.length; i++) {
      const start = Math.max(inside[i - 1].bottom, inside[i - 1].top - 1) + 1,
        end = inside[i].top - 1;
      if (end - start + 1 <= join) add(start, end);
    }
    add(Math.max(...inside.map((hunk) => hunk.bottom)) + 1, definition.end);
    if (spans.length) plan.push({ key: `${definition.start}-${definition.end}`, definition, spans });
  }
  return plan;
}

/** A shown definition as its gutter rail: its lines and its signature's, in new numbers. */
export interface ScopeRail {
  start: number;
  end: number;
  signatureEnd: number;
}
