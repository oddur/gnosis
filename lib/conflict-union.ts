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
 * unionOf, where both sides also made one identical change just before their insertions: a trailing comma added to the
 * ancestor's last line there, as appending a key to a JSON object or a member to an enum needs. Undefined unless exactly
 * one such line makes the union.
 */
export function commaUnion(block: Pick<ConflictBlock, 'base' | 'ours' | 'theirs'>) {
  if (block.base === undefined) return undefined;
  const base = lines(block.base);
  const found = base.flatMap((line, k) => {
    if (/,\s*$/.test(line) || !line.trim()) return [];
    const comma = line.replace(/(\s*)$/, (end) => `,${end}`);
    const union = unionOf({ ...block, base: [...base.slice(0, k), comma, ...base.slice(k + 1)].join('') });
    return union && union.before === k + 1 ? [union] : [];
  });
  return found.length === 1 ? found[0] : undefined;
}

/** Tokens as the layout checks read them: runs of whitespace, words and numbers, and each other character. */
export const layoutTokens = (text: string) => text.match(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu) ?? [];

/**
 * Both sides may have made the same change in different layouts (#445 item 15): the same tokens, apart from line
 * breaks, quote marks and trailing commas. Only a candidate: the checks compare the two sides' syntax trees
 * (lib/conflict-verify.ts), and one they can't confirm is taken back (src/conflict-checks.ts). Spacing inside a line,
 * and everything inside a string or comment, must match; so must a line's indentation outside brackets in Python and
 * YAML.
 */
export function sameTokens(ours: string, theirs: string, indented: boolean) {
  const read = (text: string) => {
    /** `raw`: inside a string or comment, where brackets, commas and spacing are content. */
    const tokens: { text: string; before: string; raw: boolean }[] = [];
    let space = '';
    let open: string | undefined; // the string's quote, or `//`, `#` or `/*`
    let escaped = false;
    for (const token of layoutTokens(text)) {
      const raw = open !== undefined;
      const blank = /^\s/.test(token);
      if (blank && !raw) {
        space += token;
        continue;
      }
      const last = tokens.at(-1);
      if (!raw && last?.text === ',' && !last.raw && /^[)\]}]$/.test(token)) {
        // A trailing comma is dropped; its spacing joins the closing bracket's.
        tokens.pop();
        space = last.before + space;
      }
      const quote = (!raw && `'"\``.includes(token)) || (raw && token === open && !escaped);
      tokens.push({ text: quote && token === '"' ? "'" : token, before: space, raw });
      const adjacent = !space;
      space = '';
      if (!raw) {
        if (quote) open = token;
        else if (token === '#') open = '#';
        else if ((token === '/' || token === '*') && last?.text === '/' && !last.raw && adjacent)
          open = token === '/' ? '//' : '/*';
      } else if (open === '//' || open === '#') {
        if (blank && token.includes('\n')) open = undefined;
      } else if (open === '/*') {
        if (token === '/' && last?.text === '*' && adjacent) open = undefined;
      } else if (quote) open = undefined;
      escaped = raw && token === '\\' && !escaped;
    }
    return { tokens, after: space };
  };
  const [a, b] = [read(ours), read(theirs)];
  if (a.tokens.length !== b.tokens.length || a.after !== b.after) return false;
  let depth = 0;
  return a.tokens.every((t, i) => {
    const other = b.tokens[i];
    // Line breaks may differ between code tokens, except where they set a Python or YAML line's indentation.
    const wrapped = !t.raw && /\n/.test(t.before + other.before) && !(indented && depth === 0);
    if (!t.raw) depth += /^[([{]$/.test(t.text) ? 1 : /^[)\]}]$/.test(t.text) ? -1 : 0;
    return t.text === other.text && t.raw === other.raw && (t.before === other.before || wrapped);
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

/**
 * Where order doesn't matter (#476), as an allowlist: per language, the parent node that holds the units (and, where
 * the parent type is ambiguous, the node that holds it) and the unit types. Methods of a class, impl, trait or interface
 * body; TypeScript interface and type-literal members, which are types only; imports in Go, Rust, Java and C#; Go and
 * Rust top-level functions. No fields of any kind (layout, derived ordering, serialization and initializers follow their
 * order), no enum members here (explicitEnum), no cases, list items or statements, no JavaScript, TypeScript or Python
 * imports (they run module code in order). When unsure, a kind is left out.
 */
const SCRIPT_ORDER_FREE = [
  { parents: ['class_body'], types: ['method_definition'] },
  { parents: ['interface_body', 'object_type'], types: ['method_signature', 'property_signature'] },
];
const ORDER_FREE: Partial<Record<SyntaxLanguage, { parents: string[]; containers?: string[]; types: string[] }[]>> = {
  typescript: SCRIPT_ORDER_FREE,
  tsx: SCRIPT_ORDER_FREE,
  javascript: [{ parents: ['class_body'], types: ['method_definition'] }],
  python: [{ parents: ['block'], containers: ['class_definition'], types: ['function_definition'] }],
  java: [
    { parents: ['class_body', 'interface_body'], types: ['method_declaration', 'constructor_declaration'] },
    { parents: ['program'], types: ['import_declaration'] },
  ],
  csharp: [
    { parents: ['declaration_list'], types: ['method_declaration', 'constructor_declaration'] },
    { parents: ['compilation_unit', 'declaration_list'], types: ['using_directive'] },
  ],
  go: [
    { parents: ['source_file'], types: ['function_declaration', 'method_declaration', 'import_declaration'] },
    { parents: ['import_spec_list'], types: ['import_spec'] },
  ],
  rust: [
    { parents: ['declaration_list'], containers: ['impl_item', 'trait_item', 'mod_item'], types: ['function_item'] },
    { parents: ['source_file'], types: ['function_item', 'use_declaration'] },
    { parents: ['declaration_list'], containers: ['mod_item'], types: ['use_declaration'] },
  ],
};
const IMPORTS = new Set(['import_declaration', 'import_spec', 'use_declaration', 'using_directive']);
/** A name that is only a name: no computed `[key]`, string or number key, no private `#name`. */
const PLAIN_NAMES = new Set(['identifier', 'property_identifier', 'field_identifier']);
const COMMENTS = new Set(['comment', 'line_comment', 'block_comment']);
/** The units that aren't comments: comments ride along with the side that wrote them. */
const real = (units: readonly RangeUnit[]) => units.filter((u) => !COMMENTS.has(u.type));

/** What orderFree needs to know of the file: its path and the result's text. */
export interface OrderContext {
  path: string;
  text: string;
}
/**
 * Both sides inserted these whole nodes at one place, and their order can't change what the program does (#476): each
 * side's nodes are allowed kinds of one parent (ORDER_FREE, jsonKeys, explicitEnum), none decorated or annotated, each
 * side adds at least one, and no name (with its parameter types, for overloads) is added by both. Anything else, or any
 * doubt, is false.
 */
export function orderFree(
  language: SyntaxLanguage,
  ours: RangeUnits | undefined,
  theirs: RangeUnits | undefined,
  context: OrderContext
) {
  if (!ours || !theirs || ours.parent !== theirs.parent || ours.container !== theirs.container) return false;
  const [a, b] = [real(ours.units), real(theirs.units)];
  if (!a.length || !b.length) return false;
  if (language === 'json') return jsonKeys(ours, theirs, context.path);
  const members = ENUMS[language];
  if (members && ours.parent === members.parent) return explicitEnum(members, ours);
  const allowed = (ORDER_FREE[language] ?? []).filter(
    (k) =>
      k.parents.includes(ours.parent) && (!k.containers || (ours.container && k.containers.includes(ours.container)))
  );
  // Python evaluates default values and annotations when it runs `def`, in order, unless annotations are postponed.
  const postponed = language === 'python' && /^from __future__ import annotations\b/m.test(context.text);
  const evaluated = (u: RangeUnit) =>
    language === 'python' &&
    (/=/.test(u.signature ?? '') || (!postponed && (/:/.test(u.signature ?? '') || !!u.returns)));
  const fits = (u: RangeUnit) =>
    !u.decorated &&
    !u.annotated &&
    !u.inner &&
    !u.accessor &&
    !evaluated(u) &&
    !(language === 'go' && u.name === 'init') &&
    (IMPORTS.has(u.type) || PLAIN_NAMES.has(u.nameKind ?? '')) &&
    allowed.some((k) => k.types.includes(u.type));
  if (![...a, ...b].every(fits)) return false;
  const key = (u: RangeUnit) =>
    OVERLOADS.has(language) && u.parameters !== undefined ? `${u.name}(${u.parameters})` : u.name;
  const mine = new Set(a.map(key));
  return !b.some((u) => mine.has(key(u)));
}

/** A JSON key or enum value, read as the language reads it; undefined for anything but a plain literal. */
function literal(text: string | undefined) {
  if (text === undefined) return undefined;
  const t = text.trim();
  const number = /^(-?)(0x[\da-f_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*)$/i.exec(t);
  if (number) {
    const n = BigInt(number[2].replace(/_/g, ''));
    return `n:${number[1] ? -n : n}`;
  }
  const quoted = /^(["'])((?:[^"'\\]|\\.)*)\1$/.exec(t);
  if (!quoted) return undefined;
  try {
    return `s:${JSON.parse(`"${quoted[2].replace(/"/g, '\\"')}"`) as string}`;
  } catch {
    return undefined;
  }
}
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** The package.json objects whose keys are names only: dependency lists and scripts, at the top of the file. */
const PACKAGE_MAPS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'scripts',
]);
/**
 * JSON object keys (#476): both sides added whole pairs to one object, and every key in that object, old and new, is
 * different. In a package.json, only in its dependency lists and scripts: elsewhere (`exports`, `imports`,
 * `typesVersions`, `browser`, ...) tools read keys in order.
 */
function jsonKeys(ours: RangeUnits, theirs: RangeUnits, path: string) {
  const all = ours.all;
  if (ours.parent !== 'object' || !all) return false;
  if (![...ours.units, ...theirs.units, ...all].every((u) => u.type === 'pair')) return false;
  if (/(^|[\\/])package\.json$/.test(path)) {
    const owner = ours.path?.map((key) => literal(key));
    if (owner?.length !== 1 || !PACKAGE_MAPS.has(owner[0]?.slice(2) ?? '') || !owner[0]?.startsWith('s:')) return false;
  }
  const keys = all.flatMap((u) => literal(u.name) ?? []);
  return keys.length === all.length && unique(keys);
}

/**
 * Enums whose members each carry their value: the parent node, the member node type, and the value node types allowed,
 * per language. C# and Rust: integer literals only (no chars, strings or expressions); TypeScript: numbers and strings.
 */
const ENUMS: Partial<Record<SyntaxLanguage, { parent: string; member: string; values: string[] }>> = {
  typescript: { parent: 'enum_body', member: 'enum_assignment', values: ['number', 'string'] },
  tsx: { parent: 'enum_body', member: 'enum_assignment', values: ['number', 'string'] },
  csharp: { parent: 'enum_member_declaration_list', member: 'enum_member_declaration', values: ['integer_literal'] },
  rust: { parent: 'enum_variant_list', member: 'enum_variant', values: ['integer_literal'] },
};
/**
 * Enum members (#476): every member of the enum, old and new, has an explicit literal value of an allowed kind and no
 * fields or attributes, and no name or value is there twice. Then the members' order can't change any value. An enum
 * with one implicit value is not order-free: the values after it follow their place.
 */
function explicitEnum(spec: { member: string; values: string[] }, ours: RangeUnits) {
  const all = real(ours.all ?? []);
  const fits = (u: RangeUnit) =>
    u.type === spec.member &&
    !u.annotated &&
    !u.decorated &&
    !u.body &&
    spec.values.includes(u.valueKind ?? '') &&
    literal(u.value) !== undefined;
  if (!all.length || !all.every(fits)) return false;
  return unique(all.map((u) => u.name)) && unique(all.map((u) => literal(u.value) ?? ''));
}
