import { parseConflicts, type ConflictBlock } from './conflict-blocks';
import type { ConflictProposal } from './conflict-resolution';
import { syntaxLanguage, type RangeUnit, type RangeUnits, type SyntaxLanguage } from './syntax-scope';

/**
 * Both sides added different definitions at the same place (#445, tier 3). Mergiraf leaves such a conflict open when
 * it can't tell the parent is unordered. When each side only inserted lines, at the same place, and changed none of
 * the ancestor's lines, the proposal is both insertions, the PR's first, each exactly as written. It is never Merged:
 * the checks (lib/conflict-verify.ts) put it in Check, with a note from the syntax nodes each side added (unionNote).
 */

const lines = (text: string) => text.split(/(?<=\n)/).filter(Boolean);
/** The ways `side` is `base` with lines inserted at one place: the place, and the inserted lines. */
function insertions(base: string[], side: string[]) {
  const found = new Map<number, string[]>();
  const extra = side.length - base.length;
  if (extra <= 0) return found;
  for (let at = 0; at <= base.length; at++) {
    if (at > 0 && side[at - 1] !== base[at - 1]) break;
    if (base.slice(at).every((line, i) => side[at + extra + i] === line)) found.set(at, side.slice(at, at + extra));
  }
  return found;
}
/**
 * The union of one conflict, when both sides only inserted lines at the same place: the ancestor's lines before it,
 * the PR's lines, main's lines, the ancestor's lines after it. Undefined when either side changed or removed an
 * ancestor line, when they inserted at different places, or when the place is ambiguous and the unions differ.
 */
export function unionOf(
  block: Pick<ConflictBlock, 'base' | 'ours' | 'theirs'>
): { text: string; before: number; ours: number; theirs: number } | undefined {
  if (block.base === undefined) return undefined;
  const [base, ours, theirs] = [block.base, block.ours, block.theirs].map(lines);
  // Each inserted line keeps its own line ending, so a side's last line must end in one.
  if (![block.ours, block.theirs].every((text) => text.endsWith('\n'))) return undefined;
  const [a, b] = [insertions(base, ours), insertions(base, theirs)];
  const texts = new Map<string, { before: number; ours: number; theirs: number }>();
  for (const [at, mine] of a) {
    const other = b.get(at);
    if (!other || !mine.some((l) => l.trim()) || !other.some((l) => l.trim())) continue;
    texts.set([...base.slice(0, at), ...mine, ...other, ...base.slice(at)].join(''), {
      before: at,
      ours: mine.length,
      theirs: other.length,
    });
  }
  if (texts.size !== 1) return undefined;
  const [[text, place]] = texts;
  return { text, ...place };
}

/**
 * Both sides may have made the same change in different layouts (#445 item 15): the same tokens, apart from line
 * breaks, quote marks and trailing commas. Only a candidate: the checks (lib/conflict-verify.ts) compare the two sides'
 * syntax trees, and Merge the PR's version only when they are the same program. Spacing inside a line must match, so a
 * space inside a string is a difference; so must a line's indentation outside brackets in Python and YAML.
 */
export function sameTokens(ours: string, theirs: string, indented: boolean) {
  const read = (text: string) => {
    const tokens: { text: string; before: string }[] = [];
    let space = '';
    for (const token of text.match(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu) ?? []) {
      if (/^\s/.test(token)) space += token;
      else {
        // A trailing comma is dropped; its spacing joins the closing bracket's.
        const last = tokens.at(-1);
        if (last?.text === ',' && /^[)\]}]$/.test(token)) {
          tokens.pop();
          space = last.before + space;
        }
        tokens.push({ text: token === '"' ? "'" : token, before: space });
        space = '';
      }
    }
    return { tokens, after: space };
  };
  const [a, b] = [read(ours), read(theirs)];
  if (a.tokens.length !== b.tokens.length || a.after !== b.after) return false;
  let depth = 0;
  return a.tokens.every((t, i) => {
    const other = b.tokens[i];
    // Line breaks may differ, except where they set a Python or YAML line's indentation.
    const wrapped = /\n/.test(t.before + other.before) && !(indented && depth === 0);
    depth += /^[([{]$/.test(t.text) ? 1 : /^[)\]}]$/.test(t.text) ? -1 : 0;
    return t.text === other.text && (t.before === other.before || wrapped);
  });
}

/**
 * Each conflict that has no proposal gets the PR's version where both sides may have made the same change (sameTokens),
 * else the union of both sides' insertions, where there is one. Only in files with a grammar: without one, nothing can
 * tell whole definitions from lines whose order matters, or prove two layouts are the same code.
 */
export function withUnions(
  path: string,
  original: string,
  proposals: readonly (ConflictProposal | null)[] | undefined
): (ConflictProposal | null)[] | undefined {
  const language = syntaxLanguage(path);
  if (!language) return proposals ? [...proposals] : undefined;
  const indented = language === 'python' || language === 'yaml';
  const next = parseConflicts(original).flatMap((s): (ConflictProposal | null)[] => {
    if (s.kind !== 'conflict') return [];
    const own = proposals?.[s.index];
    if (own) return [own];
    const { base, ours, theirs } = s.block;
    if (base !== undefined && ours !== theirs && sameTokens(ours, theirs, indented))
      return [{ source: 'same', text: ours }];
    const union = unionOf(s.block);
    return [union ? { source: 'union', text: union.text } : null];
  });
  return next.some((p) => p?.source === 'union' || p?.source === 'same')
    ? next
    : proposals
      ? [...proposals]
      : undefined;
}

/** What each side added, in Gnosis's words. */
export type AddedKind = 'import' | 'definition' | 'field' | 'key' | 'member' | 'arm' | 'item';
const KIND_WORDS: Record<AddedKind, string> = {
  import: 'imports',
  definition: 'definitions',
  field: 'fields',
  key: 'keys',
  member: 'enum members',
  arm: 'cases',
  item: 'items',
};

/**
 * Node types by what they add, per language. A unit of any other type (a statement, an expression) is not a
 * definition, and the union stays in Check.
 */
const SCRIPT: Record<string, AddedKind> = {
  import_statement: 'import',
  function_declaration: 'definition',
  generator_function_declaration: 'definition',
  class_declaration: 'definition',
  abstract_class_declaration: 'definition',
  interface_declaration: 'definition',
  type_alias_declaration: 'definition',
  enum_declaration: 'definition',
  method_definition: 'definition',
  property_signature: 'field',
  public_field_definition: 'field',
  field_definition: 'field',
  pair: 'key',
  shorthand_property_identifier: 'key',
  enum_assignment: 'member',
  property_identifier: 'member',
  switch_case: 'arm',
  switch_default: 'arm',
};
const UNIT_KINDS: Record<SyntaxLanguage, Record<string, AddedKind>> = {
  typescript: SCRIPT,
  tsx: SCRIPT,
  javascript: SCRIPT,
  python: {
    import_statement: 'import',
    import_from_statement: 'import',
    function_definition: 'definition',
    class_definition: 'definition',
    decorated_definition: 'definition',
    pair: 'key',
    case_clause: 'arm',
  },
  go: {
    import_spec: 'import',
    import_declaration: 'import',
    function_declaration: 'definition',
    method_declaration: 'definition',
    type_declaration: 'definition',
    field_declaration: 'field',
    const_spec: 'member',
    expression_case: 'arm',
    default_case: 'arm',
    type_case: 'arm',
    keyed_element: 'key',
  },
  rust: {
    use_declaration: 'import',
    function_item: 'definition',
    struct_item: 'definition',
    enum_item: 'definition',
    impl_item: 'definition',
    trait_item: 'definition',
    type_item: 'definition',
    field_declaration: 'field',
    enum_variant: 'member',
    match_arm: 'arm',
  },
  java: {
    import_declaration: 'import',
    method_declaration: 'definition',
    constructor_declaration: 'definition',
    class_declaration: 'definition',
    interface_declaration: 'definition',
    record_declaration: 'definition',
    enum_declaration: 'definition',
    field_declaration: 'field',
    enum_constant: 'member',
    switch_block_statement_group: 'arm',
    switch_rule: 'arm',
  },
  csharp: {
    using_directive: 'import',
    method_declaration: 'definition',
    constructor_declaration: 'definition',
    class_declaration: 'definition',
    interface_declaration: 'definition',
    struct_declaration: 'definition',
    record_declaration: 'definition',
    enum_declaration: 'definition',
    field_declaration: 'field',
    property_declaration: 'field',
    enum_member_declaration: 'member',
    switch_section: 'arm',
    switch_expression_arm: 'arm',
  },
  json: { pair: 'key' },
  yaml: { block_mapping_pair: 'key', block_sequence_item: 'item' },
};
/** Parents whose children are items in order: arrays and lists. */
const LISTS = new Set([
  'array',
  'list',
  'array_expression',
  'array_initializer',
  'initializer_expression',
  'collection_expression',
  'literal_value',
  'block_sequence',
  'flow_sequence',
]);
/** Units that add nothing of their own: comments, and Rust attributes, which belong to the item after them. */
const NEUTRAL = new Set(['comment', 'line_comment', 'block_comment', 'attribute_item']);
/** Overloads are told apart by their parameter types. */
const OVERLOADS = new Set<SyntaxLanguage>(['java', 'csharp']);
/**
 * Kinds whose order can change what the program does: enum members (values and ordinals follow their order), cases (a
 * catch-all or a fall-through), list items, and imports in languages that run module code as they import.
 */
const ORDERED = new Set<AddedKind>(['member', 'arm', 'item']);
const RUNS_ON_IMPORT = new Set<SyntaxLanguage>(['typescript', 'tsx', 'javascript', 'python']);

const kindOf = (language: SyntaxLanguage, parent: string, unit: RangeUnit): AddedKind | 'neutral' | undefined => {
  if (NEUTRAL.has(unit.type)) return 'neutral';
  if (LISTS.has(parent)) return 'item';
  // A unit inside `export` or a decorator is what it holds.
  return UNIT_KINDS[language][unit.inner ?? unit.type];
};

/**
 * Why to check a union, from the whole nodes each side's inserted lines hold in the result. A union is never Merged:
 * names, attributes and comments that belong to one side's item can't be proved apart from the other side's, so it is a
 * ready proposal in Check. Undefined units (a node reaches past the inserted lines, or the result didn't parse) get the
 * plainest note.
 */
export function unionNote(language: SyntaxLanguage, ours: RangeUnits | undefined, theirs: RangeUnits | undefined) {
  const kept = 'Gnosis kept both, the PR’s lines first.';
  const unknown = `Both sides added lines here. ${kept} Check that both belong, in this order.`;
  if (!ours || !theirs) return unknown;
  const read = (side: RangeUnits) => side.units.map((unit) => ({ unit, kind: kindOf(language, side.parent, unit) }));
  const real = [...read(ours), ...read(theirs)].filter((x) => x.kind !== 'neutral');
  if (!real.length || real.some((x) => !x.kind)) return unknown;
  const kinds = new Set(real.map((x) => x.kind as AddedKind));
  const what = kinds.size === 1 ? KIND_WORDS[[...kinds][0]] : 'definitions';
  const key = (u: RangeUnit) =>
    OVERLOADS.has(language) && u.parameters !== undefined ? `${u.name}(${u.parameters})` : u.name;
  const names = (side: RangeUnits) => new Set(side.units.filter((u) => !NEUTRAL.has(u.type)).map(key));
  const mine = names(ours);
  const same = [...names(theirs)].find((name) => mine.has(name));
  if (same)
    return `Both sides added ${same.length > 40 ? `${same.slice(0, 39)}…` : same} here. Keep one, or check that both belong.`;
  const ordered =
    [...kinds].some((kind) => ORDERED.has(kind)) ||
    (kinds.has('import') && RUNS_ON_IMPORT.has(language)) ||
    real.some(({ unit }) => unit.decorated || unit.type === 'decorator');
  return ordered
    ? `Both sides added different ${what} here. ${kept} Check the order: it can matter here.`
    : `Both sides added different ${what} here. ${kept} Their order shouldn’t matter; check that both belong.`;
}
