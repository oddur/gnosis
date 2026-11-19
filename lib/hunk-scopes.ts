import { gapContaining, type DiffGap, type GapPart } from './diff-gaps';
import {
  definitionChain,
  definitionReveal,
  enclosingDefinition,
  enclosingPoint,
  opensByDefault,
  type DefinitionKind,
  type DefinitionReveal,
  type SyntaxDefinition,
} from './syntax-scope';

/**
 * The enclosing definition of each hunk in Changes, and what "Show whole function" would reveal (#393). Added lines
 * look up the new file's definitions, and hunks that only delete look up the old file's, mapped to new line numbers
 * through the gaps: revealed lines always come from the after side.
 */
export interface HunkScope {
  definition: SyntaxDefinition;
  /** Which file's tree the definition came from. */
  side: 'after' | 'before';
  /** New lines still hidden that "Show whole function" reveals, or undefined when they all show. */
  reveal?: DefinitionReveal;
  /** The definition is short enough to show whole without being asked. */
  opens: boolean;
  /**
   * Every definition around the hunk, outermost first and ending with `definition`, each with what clicking its crumb
   * reveals (undefined when it all shows). Hunks that only delete use the old file's chain, in new line numbers.
   */
  chain: ScopeCrumb[];
  /** From the patch's hunk header, shown until the file's definitions arrive (`provisionalScopes`). */
  provisional?: boolean;
}
export interface ScopeCrumb {
  definition: SyntaxDefinition;
  reveal?: DefinitionReveal;
  /** The hunk header's text, not a parsed definition. */
  provisional?: boolean;
}

/** The longest header text a provisional crumb keeps; the bar clips it further to fit. */
const HEADER_TEXT_MAX = 160;
/**
 * The text after a hunk header's line numbers, as a crumb: GitHub puts the line before the hunk that git takes for its
 * enclosing function there, as in `@@ -1158,7 +1159,11 @@ public void SetChatQuestId(EntityId id) {`. Whitespace
 * collapses and a trailing `{` goes. Undefined for a header without text, or a line that is not a header.
 */
export function hunkHeaderText(header: string): string | undefined {
  const match = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/.exec(header);
  if (!match) return;
  const text = match[1].replace(/\s+/g, ' ').trim().replace(/\s*\{$/, '').trim();
  if (!text) return;
  return text.length > HEADER_TEXT_MAX ? `${text.slice(0, HEADER_TEXT_MAX - 1)}…` : text;
}
/** Each hunk header of a GitHub patch: where its new lines start, and its text. */
export function patchHeaders(patch: string): { newStart: number; text?: string }[] {
  const headers: { newStart: number; text?: string }[] = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('@@')) continue;
    const start = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!start) continue;
    // A side with no lines names the line before it, as `hunksFromDiff` reads it.
    const newStart = Number(start[1]) + (start[2] === '0' ? 1 : 0);
    headers.push({ newStart, text: hunkHeaderText(line) });
  }
  return headers;
}
/**
 * Where each changed hunk is, from the patch alone, until tree-sitter's definitions arrive: the text of the header
 * of the patch hunk that holds its first change, or the file alone when the header has none. A patch hunk that the
 * preview splits, or that a reveal merges, keeps its header's text for its first change. The text names the line
 * before the patch hunk, not a parsed definition, so nothing reveals from it.
 */
export function provisionalScopes(parts: GapPart[], patch: string | undefined): Map<string, HunkScope> {
  const scopes = new Map<string, HunkScope>();
  if (!patch) return scopes;
  const headers = patchHeaders(patch);
  if (!headers.length) return scopes;
  for (const part of parts) {
    if (part.kind !== 'hunk') continue;
    const { added, deleted, point } = changedLines(part);
    if (!added && !deleted) continue;
    const line = added?.[0] ?? point ?? part.hunk.newStart;
    let header: (typeof headers)[number] | undefined;
    for (const candidate of headers) if (candidate.newStart <= line) header = candidate;
    const text = (header ?? headers[0]).text;
    const definition: SyntaxDefinition = {
      kind: 'function',
      name: text ?? '',
      label: text ?? '',
      crumb: text ?? '',
      start: line,
      end: line,
      signatureEnd: line,
    };
    scopes.set(part.key, {
      definition,
      side: 'after',
      opens: false,
      chain: text ? [{ definition, provisional: true }] : [],
      provisional: true,
    });
  }
  return scopes;
}

/** The new line an old line maps to: through its gap, or through the hunk rows that show it. */
export function oldToNew(parts: GapPart[], gaps: DiffGap[], line: number): number | undefined {
  const gap = gapContaining(gaps, 'before', line);
  if (gap) return line - gap.oldOffset;
  for (const part of parts) {
    if (part.kind !== 'hunk') continue;
    let oldLine = part.hunk.oldStart,
      newLine = part.hunk.newStart;
    for (const row of part.hunk.rows) {
      if (row.type !== '+') {
        if (oldLine === line) return newLine;
        oldLine++;
      }
      if (row.type !== '-') newLine++;
    }
  }
  return undefined;
}

/** Changed lines of a hunk: added lines on the new side, deleted lines on the old side, and where deletions sat on
 * the new side. */
function changedLines(part: Extract<GapPart, { kind: 'hunk' }>) {
  let oldLine = part.hunk.oldStart,
    newLine = part.hunk.newStart;
  let added: [number, number] | undefined, deleted: [number, number] | undefined, point: number | undefined;
  for (const row of part.hunk.rows) {
    if (row.type === '+') added = added ? [added[0], newLine] : [newLine, newLine];
    if (row.type === '-') {
      deleted = deleted ? [deleted[0], oldLine] : [oldLine, oldLine];
      point ??= newLine;
    }
    if (row.type !== '+') oldLine++;
    if (row.type !== '-') newLine++;
  }
  return { added, deleted, point };
}

/**
 * The scope of every hunk part that changes lines, by part key. `shown` holds the new lines on screen, so a reveal
 * covers only what is still hidden. Without the new side's definitions there are no scopes: revealing needs the new
 * text anyway.
 */
export function hunkScopes(
  parts: GapPart[],
  gaps: DiffGap[] | undefined,
  definitions: { after?: readonly SyntaxDefinition[]; before?: readonly SyntaxDefinition[] },
  shown: ReadonlyMap<number, string>
): Map<string, HunkScope> {
  const scopes = new Map<string, HunkScope>();
  if (!definitions.after || !gaps) return scopes;
  for (const part of parts) {
    if (part.kind !== 'hunk') continue;
    const { added, deleted, point } = changedLines(part);
    let definition: SyntaxDefinition | undefined;
    let chain: SyntaxDefinition[] = [];
    let side: HunkScope['side'] = 'after';
    // Added lines use the new tree; deleted lines without the old tree use the point where they sat.
    if (added || !deleted || !definitions.before) {
      definition = added
        ? enclosingDefinition(definitions.after, added[0], added[1])
        : point !== undefined
          ? enclosingPoint(definitions.after, point)
          : undefined;
      if (definition) chain = definitionChain(definitions.after, definition);
    } else {
      const old = enclosingDefinition(definitions.before, deleted[0], deleted[1]);
      // Old definitions in new line numbers: revealed lines come from the after side.
      const mapped = (d: SyntaxDefinition): SyntaxDefinition | undefined => {
        const start = oldToNew(parts, gaps, d.start),
          end = oldToNew(parts, gaps, d.end),
          signatureEnd = oldToNew(parts, gaps, d.signatureEnd);
        return start === undefined || end === undefined
          ? undefined
          : { ...d, start, end: Math.max(start, end), signatureEnd: Math.max(start, signatureEnd ?? start) };
      };
      definition = old && mapped(old);
      if (old && definition) {
        side = 'before';
        const inner = definition;
        chain = [...definitionChain(definitions.before, old).slice(0, -1).flatMap((d) => mapped(d) ?? []), inner];
      }
    }
    if (!definition) continue;
    const crumb = (d: SyntaxDefinition): ScopeCrumb => {
      const plan = definitionReveal(d);
      for (let line = plan.start; line <= plan.end; line++) if (!shown.has(line)) return { definition: d, reveal: plan };
      return { definition: d };
    };
    const crumbs = chain.map(crumb);
    scopes.set(part.key, {
      definition,
      side,
      reveal: crumbs.at(-1)?.reveal,
      opens: opensByDefault(definition),
      chain: crumbs,
    });
  }
  return scopes;
}

const NOUNS: Partial<Record<DefinitionKind, string>> = {
  function: 'function',
  method: 'function',
  property: 'property',
  test: 'test',
  class: 'class',
  struct: 'struct',
  enum: 'enum',
  impl: 'impl block',
  trait: 'trait',
  interface: 'interface',
  module: 'module',
  key: 'entry',
};
/** The action's text, such as "Show whole function". */
export const revealLabel = (scope: Pick<HunkScope, 'definition' | 'reveal'>) =>
  scope.reveal?.kind === 'signature'
    ? `Show ${NOUNS[scope.definition.kind] ?? 'definition'} signature`
    : `Show whole ${NOUNS[scope.definition.kind] ?? 'definition'}`;

/** A definition in words, for the breadcrumb's accessible label: "impl GameplayClient", "function list_grants". */
export function spokenDefinition(definition: SyntaxDefinition): string {
  if (definition.kind === 'key') return `key ${definition.name}`;
  if (definition.kind === 'test') return `test ${definition.name}`;
  if (definition.kind === 'impl') return `impl ${definition.name}`;
  return `${NOUNS[definition.kind] ?? definition.kind} ${definition.name}`;
}
/** A line on one side of a diff: deleted lines are on the old side, in old numbers. */
export interface LinePoint {
  side: 'after' | 'before';
  line: number;
}
/**
 * The definitions around one line, outermost first, for a pinned hunk header that follows the reader: empty outside
 * every definition, undefined without that side's definitions.
 */
export function chainAt(
  definitions: { after?: readonly SyntaxDefinition[]; before?: readonly SyntaxDefinition[] },
  point: LinePoint
): SyntaxDefinition[] | undefined {
  const list = point.side === 'before' ? definitions.before : definitions.after;
  if (!list) return undefined;
  const inner = enclosingDefinition(list, point.line, point.line);
  return inner ? definitionChain(list, inner) : [];
}

/** The whole breadcrumb in words: "In build_api_routes.rs, impl GameplayClient, function list_badge_grants". */
export const spokenChain = (file: string, chain: readonly ScopeCrumb[]) =>
  [`In ${file}`, ...chain.map((crumb) => (crumb.provisional ? crumb.definition.crumb : spokenDefinition(crumb.definition)))].join(', ');

/** A pinned breadcrumb's crumb, as a button's name (#417): "Go to class ProductionProcessRunner". */
export const jumpLabel = (definition: SyntaxDefinition) => `Go to ${spokenDefinition(definition)}`;
