import { parseConflicts, type ConflictBlock } from './conflict-blocks';
import type { ConflictProposal } from './conflict-resolution';
import { syntaxLanguage, type RangeUnit, type RangeUnits, type SyntaxLanguage } from './syntax-scope';

/**
 * Both sides added different definitions at the same place (#445, tier 3). Mergiraf leaves such a conflict open when
 * it can't tell the parent is unordered. When each side only inserted lines, at the same place, and changed none of
 * the ancestor's lines, the proposal is both insertions, the PR's first, each exactly as written. The checks
 * (lib/conflict-verify.ts) read the inserted lines with tree-sitter: the proposal is Merged only when they are whole
 * units of a kind whose order cannot matter in that language (MERGE_IN_ANY_ORDER), with no name both sides added.
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
 * Each conflict that has no proposal gets the union of both sides' insertions, where there is one. Only in files with a
 * grammar: without one, nothing can tell whole definitions from lines whose order matters.
 */
export function withUnions(
  path: string,
  original: string,
  proposals: readonly (ConflictProposal | null)[] | undefined
): (ConflictProposal | null)[] | undefined {
  if (!syntaxLanguage(path)) return proposals ? [...proposals] : undefined;
  const next = parseConflicts(original).flatMap((s) => {
    if (s.kind !== 'conflict') return [];
    const union = proposals?.[s.index] ? undefined : unionOf(s.block);
    return [union ? { source: 'union' as const, text: union.text } : (proposals?.[s.index] ?? null)];
  });
  return next.some((p) => p?.source === 'union') ? next : proposals ? [...proposals] : undefined;
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
 * The allowlist for Merged: per language, the kinds whose order cannot change what the program does, or the unit types
 * within a kind where only some can. Everything else (enum members, whose values or ordinals may follow their order;
 * cases, where a catch-all or a fall-through makes order matter; items in a list; JavaScript, TypeScript and Python
 * imports, which run module code in order; Python definitions, which run in order) stays in Check.
 */
const MERGE_IN_ANY_ORDER: Record<SyntaxLanguage, Partial<Record<AddedKind, readonly string[] | true>>> = {
  // Function declarations are hoisted; methods without decorators; interface and type-literal fields.
  typescript: {
    definition: ['function_declaration', 'interface_declaration', 'type_alias_declaration', 'method_definition'],
    field: true,
    key: ['pair'],
  },
  tsx: {
    definition: ['function_declaration', 'interface_declaration', 'type_alias_declaration', 'method_definition'],
    field: true,
    key: ['pair'],
  },
  javascript: { definition: ['function_declaration', 'method_definition'], key: ['pair'] },
  // Functions only: a class body runs when it is defined. Class attributes are not told from other statements.
  python: { definition: ['function_definition'], key: ['pair'] },
  go: { import: true, definition: true, field: true },
  rust: { import: true, definition: true, field: true },
  java: { import: true, definition: ['method_declaration', 'constructor_declaration'], field: true },
  csharp: { import: true, definition: ['method_declaration', 'constructor_declaration'], field: true },
  json: { key: true },
  yaml: { key: true },
};

const kindOf = (language: SyntaxLanguage, parent: string, unit: RangeUnit): AddedKind | 'neutral' | undefined => {
  if (NEUTRAL.has(unit.type)) return 'neutral';
  if (LISTS.has(parent)) return 'item';
  // A unit inside `export` or a decorator is what it holds.
  return UNIT_KINDS[language][unit.inner ?? unit.type];
};

export interface UnionReading {
  /** Merged is allowed: every unit is of a kind whose order cannot matter here, and no name is added twice. */
  merge: boolean;
  /** Why the union is Merged or stays in Check, in one sentence or two. */
  note: string;
}
/**
 * Reads a union proposal from the whole nodes each side's inserted lines hold, in the result. Undefined units (a node
 * reaches past the inserted lines, or the result didn't parse) leave it in Check.
 */
export function readUnion(
  language: SyntaxLanguage,
  ours: RangeUnits | undefined,
  theirs: RangeUnits | undefined,
  /** How many definitions of each name the whole result has. */
  defined?: ReadonlyMap<string, number>
): UnionReading {
  const kept = 'Gnosis kept both, the PR’s lines first.';
  const unknown = { merge: false, note: `Both sides added lines here. ${kept} Check that both belong, in this order.` };
  if (!ours || !theirs) return unknown;
  const read = (side: RangeUnits) => side.units.map((unit) => ({ unit, kind: kindOf(language, side.parent, unit) }));
  const all = [...read(ours), ...read(theirs)];
  const real = all.filter((x) => x.kind !== 'neutral');
  if (!real.length || real.some((x) => !x.kind)) return unknown;
  const kinds = new Set(real.map((x) => x.kind as AddedKind));
  const what = kinds.size === 1 ? KIND_WORDS[[...kinds][0]] : 'definitions';
  const shown = (name: string) => (name.length > 40 ? `${name.slice(0, 39)}…` : name);
  const key = (u: RangeUnit) =>
    OVERLOADS.has(language) && u.parameters !== undefined ? `${u.name}(${u.parameters})` : u.name;
  const names = (side: RangeUnits) => new Set(side.units.filter((u) => !NEUTRAL.has(u.type)).map(key));
  const mine = names(ours);
  const same = [...names(theirs)].find((name) => mine.has(name));
  if (same) return { merge: false, note: `Both sides added ${shown(same)} here. Keep one, or check that both belong.` };
  // A definition the other side added elsewhere in the file, outside this conflict.
  const twice = OVERLOADS.has(language)
    ? undefined
    : real.find(({ unit, kind }) => kind === 'definition' && (defined?.get(unit.name) ?? 0) > 1);
  if (twice)
    return { merge: false, note: `${shown(twice.unit.name)} is defined twice in the result. Check which to keep.` };
  const allowed = MERGE_IN_ANY_ORDER[language];
  const ordered = real.find(({ unit, kind }) => {
    const rule = allowed[kind as AddedKind];
    return !(rule === true || rule?.includes(unit.inner ?? unit.type));
  });
  // A decorator runs in order and may register something.
  const decorated = real.some(({ unit }) => unit.decorated || unit.type === 'decorator');
  if (ordered || decorated)
    return {
      merge: false,
      note: `Both sides added different ${what} here. ${kept} Check the order: it can matter here.`,
    };
  return { merge: true, note: `Both sides added different ${what} here. ${kept} Their order doesn’t matter.` };
}
