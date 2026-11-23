import { parseConflicts, textLines as lines, type ConflictBlock } from './conflict-blocks';
import type { ConflictProposal } from './conflict-resolution';
import { syntaxLanguage, type RangeOwner, type RangeUnit, type RangeUnits, type SyntaxLanguage } from './syntax-scope';

/**
 * Both sides added different definitions at the same place (#445, tier 3). Mergiraf leaves such a conflict open when
 * it can't tell the parent is unordered. When each side only inserted lines, at the same place, and changed none of
 * the ancestor's lines, the proposal is both insertions, the PR's first, each exactly as written. It is never Merged:
 * the checks (lib/conflict-verify.ts) put it in Check, with a note from the syntax nodes each side added (unionNote).
 */

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
/**
 * In those languages, units that run code where they stand (#462): a class runs its body (Python) or its static
 * initializers (JavaScript, TypeScript) when it is defined, and a class field's initializer runs in field order.
 */
const RUNS_IN_ORDER = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'class_definition',
  'public_field_definition',
  'field_definition',
]);

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
  const kept = 'Proposal: keep both, the PR’s lines first.';
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
    (RUNS_ON_IMPORT.has(language) && real.some(({ unit }) => RUNS_IN_ORDER.has(unit.inner ?? unit.type))) ||
    real.some(({ unit }) => unit.decorated || unit.type === 'decorator');
  return ordered
    ? `Both sides added different ${what} here. ${kept} Check the order: it can matter here.`
    : `Both sides added different ${what} here. ${kept} Their order shouldn’t matter; check that both belong.`;
}

/** What an order-free unit is: both sides' units must all be one kind. */
type OrderKind = 'method' | 'member' | 'import' | 'variant' | 'field';
/**
 * One kind of order-free unit: the parent node that holds the units (and, where the parent type is ambiguous, the node
 * that holds it), the unit types, and, for a kind whose order can matter elsewhere, its proof (#481): given the units'
 * parent and every unit both sides added, true only when no order of them can change what the program does.
 */
interface OrderFree {
  parents: string[];
  containers?: string[];
  types: string[];
  kind: OrderKind;
  prove?: (units: RangeUnits, added: readonly RangeUnit[]) => boolean;
}
/**
 * Where order doesn't matter (#476), the provable core only: plain methods of a class, impl or interface body (Go:
 * methods with a receiver); TypeScript interface and type-literal members, which are types only; imports in Go, Rust,
 * Java and C#. Since #481, each with its own proof (docs/conflict-resolution.md): TypeScript `import type`, Rust enum
 * variants and struct fields. Nothing else: no other fields, enum members, functions, keys, cases, list items or
 * statements, no other JavaScript, TypeScript or Python imports.
 */
const SCRIPT_ORDER_FREE: OrderFree[] = [
  { parents: ['class_body'], types: ['method_definition'], kind: 'method' },
  { parents: ['program'], types: ['import_statement'], kind: 'import', prove: typeImports },
  { parents: ['interface_body', 'object_type'], types: ['method_signature', 'property_signature'], kind: 'member' },
];
const ORDER_FREE: Partial<Record<SyntaxLanguage, OrderFree[]>> = {
  typescript: SCRIPT_ORDER_FREE,
  tsx: SCRIPT_ORDER_FREE,
  javascript: [{ parents: ['class_body'], types: ['method_definition'], kind: 'method' }],
  python: [{ parents: ['block'], containers: ['class_definition'], types: ['function_definition'], kind: 'method' }],
  java: [
    { parents: ['class_body', 'interface_body'], types: ['method_declaration'], kind: 'method' },
    { parents: ['program'], types: ['import_declaration'], kind: 'import' },
  ],
  csharp: [
    { parents: ['declaration_list'], types: ['method_declaration'], kind: 'method' },
    { parents: ['compilation_unit', 'declaration_list'], types: ['using_directive'], kind: 'import' },
  ],
  go: [
    { parents: ['source_file'], types: ['method_declaration'], kind: 'method' },
    { parents: ['source_file'], types: ['import_declaration'], kind: 'import' },
    { parents: ['import_spec_list'], types: ['import_spec'], kind: 'import' },
  ],
  rust: [
    { parents: ['declaration_list'], containers: ['impl_item'], types: ['function_item'], kind: 'method' },
    { parents: ['source_file'], types: ['use_declaration'], kind: 'import' },
    { parents: ['declaration_list'], containers: ['mod_item'], types: ['use_declaration'], kind: 'import' },
    {
      parents: ['enum_variant_list'],
      containers: ['enum_item'],
      types: ['enum_variant'],
      kind: 'variant',
      prove: rustVariants,
    },
    {
      parents: ['field_declaration_list'],
      containers: ['struct_item'],
      types: ['field_declaration'],
      kind: 'field',
      prove: rustFields,
    },
  ],
};
/** A name that is only a name: no computed `[key]`, string or number key, no private `#name`. */
const PLAIN_NAMES = new Set(['identifier', 'property_identifier', 'field_identifier']);
const COMMENTS = new Set(['comment', 'line_comment', 'block_comment']);
/** Nodes that attach to the next declaration: a decorator, annotation or attribute just before the insertion. */
const ATTACHING = new Set(['decorator', 'annotation', 'marker_annotation', 'attribute_list', 'attribute_item']);
/**
 * Comments that apply to the next line or declaration, whichever side's comes first: compiler and linter directives
 * (`@ts-ignore`, `eslint-disable-next-line`, `nolint`, `noqa`, `type: ignore`, `go:` and `+build` lines), formatter
 * switches, and doc comments (`/**`, `///`), which JSDoc types and `@deprecated` ride on.
 */
const DIRECTIVE =
  /@ts-|eslint-|prettier-ignore|biome-ignore|deno-lint|oxlint|nolint|noqa|type:\s*ignore|pyright:|pylint:|mypy:|pragma|rustfmt|clippy|NOSONAR|istanbul|c8 ignore|v8 ignore|noinspection|ReSharper|@formatter|^\/\/\s*(?:go:|\+build|#)|^\/\*\*|^\/\/\//i;
/** The units that aren't comments: comments ride along with the side that wrote them. */
const real = (units: readonly RangeUnit[]) => units.filter((u) => !COMMENTS.has(u.type));
/** A directive comment that applies to what follows it: just before the insertion, or last in a side's lines. */
function directed(side: RangeUnits) {
  const last = side.units.at(-1);
  const trailing = last && COMMENTS.has(last.type) ? [last.name] : [];
  return [...(side.comments ?? []), ...trailing].some((text) => DIRECTIVE.test(text.trim()));
}

/** What orderFree needs to know of the file: its path. */
export interface OrderContext {
  path: string;
}
/**
 * Both sides inserted these whole nodes at one place, and their order can't change what the program does (#476): every
 * node, on both sides, is one allowed kind of one parent (ORDER_FREE, or a known JSON file's keyed object), with that
 * kind's proof where it has one; none decorated, annotated or attributed; nothing that attaches to the next declaration
 * just before them, and no directive comment there or at the end of a side; each side adds at least one, and no name
 * (with its parameter types, for overloads) is added by both. Anything else, or any doubt, is false.
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
  if ([ours.before, theirs.before].some((type) => type !== undefined && ATTACHING.has(type))) return false;
  if (directed(ours) || directed(theirs)) return false;
  if (language === 'json') return keyedObject(ours, theirs, context.path);
  const allowed = (ORDER_FREE[language] ?? []).filter(
    (k) =>
      k.parents.includes(ours.parent) && (!k.containers || (ours.container && k.containers.includes(ours.container)))
  );
  const ruleOf = (u: RangeUnit) => allowed.find((k) => k.types.includes(u.type));
  const rules = new Set([...a, ...b].map(ruleOf));
  const [rule] = rules;
  if (rules.size !== 1 || !rule) return false;
  const { kind } = rule;
  // Python runs default values and annotations when it runs `def`, in order; a `__name` is mangled with its class.
  const python = (u: RangeUnit) =>
    language !== 'python' ||
    (!/[=:]/.test(u.signature ?? '') && !u.returns && !u.name.startsWith('__') && !/^_[\p{L}\p{N}_]*?__/u.test(u.name));
  // `global using`, `using static` and aliases change what names mean elsewhere.
  const using = (u: RangeUnit) =>
    u.type !== 'using_directive' || /^using\s+[\p{L}_][\p{L}\p{N}_.]*\s*;$/u.test(u.head ?? '');
  const fits = (u: RangeUnit) =>
    !u.decorated &&
    !u.annotated &&
    !u.inner &&
    !u.accessor &&
    (kind === 'import' || PLAIN_NAMES.has(u.nameKind ?? '')) &&
    python(u) &&
    using(u);
  if (![...a, ...b].every(fits) || (rule.prove && !rule.prove(ours, [...a, ...b]))) return false;
  // An import by its line; a method by its name, with its parameter types where overloads differ by them.
  const key = (u: RangeUnit) =>
    kind === 'import'
      ? (u.head ?? u.name)
      : OVERLOADS.has(language) && u.parameters !== undefined
        ? `${u.name}(${u.parameters})`
        : u.name;
  const mine = new Set(a.map(key));
  return !b.some((u) => mine.has(key(u)));
}

/**
 * TypeScript imports: an import runs its module, in order, and nothing in the syntax tree shows that a module has no
 * side effects, so a value import is never order-free. `import type …` is erased whole from the output (even with
 * `verbatimModuleSyntax`), so it runs nothing: both sides' imports must all be `import type`, binding different names.
 * `import { type A }` is not: it can leave `import {} from './a'`, which runs the module.
 */
function typeImports(_units: RangeUnits, added: readonly RangeUnit[]) {
  const binds = added.flatMap((u) => u.binds ?? []);
  return added.every((u) => u.typeOnly && u.binds?.length) && new Set(binds).size === binds.length;
}

/** Lint and documentation attributes, and `cfg`, which keeps or drops the whole item: none of them reads an order. */
const INERT_ATTRIBUTES = /^(?:allow|warn|deny|forbid|expect|cfg)\s*\(|^doc\b/;
const DERIVE = /^derive\s*\(([^()]*)\)$/;
/** A `use` of std, core or alloc, which the file can't have renamed (rustFile refuses `extern crate … as std`). */
const STD_USE = /^(?:pub(?:\([^)]*\))? )?use (?:::)?(?:std|core|alloc)::/;
/** `#[macro_use]` brings a crate's macros in under their own names; `extern crate x as std` makes `std::` mean x. */
const RENAMES_STD = /macro_use|extern crate .* as (?:std|core|alloc)\b/;
/** Rust's primitive types: a field of one has no drop glue, unless the file names something else after it. */
const PRIMITIVES = ['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize'].concat([
  'f32',
  'f64',
  'bool',
  'char',
  'str',
]);
const PRIMITIVE_WORD = new RegExp(`\\b(?:${PRIMITIVES.join('|')})\\b`);
/** Names that change what Rust code in the file means when the file declares them: the primitives and the std crates. */
const RESERVED = new Set([...PRIMITIVES, 'std', 'core', 'alloc']);
/** A word regex for each derive set, compiled once. */
const deriveWords = new WeakMap<ReadonlySet<string>, RegExp>();
/**
 * Every attribute on a Rust item and around it is inert or a `derive` of only these std derives, and nothing in the file
 * could put another macro under one of their names: a glob or a `use` naming one outside std, core and alloc, a
 * `macro_use`, an `extern crate … as std`, a type or module named like std, or a macro called where items go, which can
 * declare anything. A crate root's `#[macro_use] extern crate` is in another file: docs/conflict-resolution.md says so.
 */
function rustAttributes(owner: RangeOwner, derives: ReadonlySet<string>) {
  let named = deriveWords.get(derives);
  if (!named) deriveWords.set(derives, (named = new RegExp(`\\b(?:${[...derives].join('|')})\\b`)));
  const words = named;
  const derived = (text: string) => {
    const list = DERIVE.exec(text)?.[1];
    return list !== undefined && list.split(',').every((name) => !name.trim() || derives.has(name.trim()));
  };
  const safe = (text: string) =>
    !RENAMES_STD.test(text) &&
    (!/\*|\{/.test(text) || STD_USE.test(text)) &&
    (!words.test(text) || (STD_USE.test(text) && !/ as /.test(text)));
  const { file } = owner;
  return (
    !file.macros &&
    !file.types.some((name) => RESERVED.has(name)) &&
    owner.attributes.every((a) => INERT_ATTRIBUTES.test(a) || derived(a)) &&
    file.uses.every(safe)
  );
}
/** A Rust integer literal's value, `-` allowed; undefined for anything else (a constant, an expression). */
function rustInteger(text: string | undefined) {
  const match = /^(-\s*)?(0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*)(?:[iu](?:8|16|32|64|128|size))?$/i.exec(
    text?.trim() ?? ''
  );
  if (!match) return undefined;
  const digits = match[2].replace(/_/g, '');
  if (/^0[xob]$/i.test(digits)) return undefined;
  const value = BigInt(digits.toLowerCase());
  return match[1] ? -value : value;
}
/** Derives that never read a fieldless enum's variant order once each variant has its own value. */
const ENUM_DERIVES = new Set(['Debug', 'Clone', 'Copy', 'PartialEq', 'Eq', 'Hash']);
/**
 * Rust enum variants: a variant's order sets only its implicit discriminant (what `as` casts read) and what derives
 * that look at the order read (`PartialOrd`, `Ord`, serde's variant index). So every variant, old and new, is a unit
 * variant with an explicit integer discriminant, all different; nothing but lint, `doc` and `cfg` attributes and
 * ENUM_DERIVES sit on the enum or around it (rustAttributes), and no variant has an attribute (`#[default]`,
 * `#[serde(…)]`). Rust has no reflection over variants.
 */
function rustVariants(units: RangeUnits) {
  const owner = units.owner;
  if (!owner || !rustAttributes(owner, ENUM_DERIVES)) return false;
  const values = owner.members.map((m) => (m.fields || m.attributed ? undefined : rustInteger(m.value)));
  if (values.some((v) => v === undefined)) return false;
  return new Set(values.map(String)).size === values.length;
}
/** Derives that, on scalar fields, combine each field's result without an order: a copy, a default, `==` and `&&`. */
const STRUCT_DERIVES = new Set(['Clone', 'Copy', 'PartialEq', 'Eq', 'Default']);
/** Field types with no drop glue and nothing to run: Rust's scalars, and borrowed strings. */
const SCALAR = /^(?:[iu](?:8|16|32|64|128|size)|f32|f64|bool|char|&(?:'[\p{L}_][\p{L}\p{N}_]* )?str)$/u;
/**
 * Rust struct fields: their order is the drop order, what `Debug`, `PartialOrd`, `Ord`, `Hash` and serde read, and,
 * with `#[repr]`, the layout. So every field, old and new, is a named field of a primitive scalar type or `&str` (no
 * drop glue, nothing to run), with no attribute, in a struct without type parameters; no `use`, `extern crate`, type or
 * module in the file is named like a primitive; and nothing but lint, `doc` and `cfg` attributes and STRUCT_DERIVES sit
 * on the struct or around it (rustAttributes). Without `#[repr]` the layout is unspecified (rustc reorders fields;
 * `offset_of!` reads it), and struct literals and patterns name their fields.
 */
function rustFields(units: RangeUnits) {
  const owner = units.owner;
  return (
    !!owner &&
    !owner.generic &&
    rustAttributes(owner, STRUCT_DERIVES) &&
    !owner.file.uses.some((text) => PRIMITIVE_WORD.test(text)) &&
    owner.members.every((m) => !m.attributed && SCALAR.test(m.type ?? ''))
  );
}

/** A JSON string, read as JSON reads it; undefined for anything else. */
function jsonString(text: string | undefined) {
  if (text === undefined || !/^"(?:[^"\\]|\\.)*"$/.test(text.trim())) return undefined;
  try {
    return JSON.parse(text.trim()) as string;
  } catch {
    return undefined;
  }
}
/**
 * Known JSON files and the top-level objects in them whose keys are looked up by name only, never read in order: per
 * file name, the owning keys. package.json's dependency lists (#476), `peerDependenciesMeta` (per package) and
 * `engines` (per tool); a tsconfig or jsconfig's `compilerOptions` (per option) (#481).
 */
const KEYED_OBJECTS: [RegExp, ReadonlySet<string>][] = [
  [
    /(^|[\\/])package\.json$/,
    new Set([
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
      'peerDependenciesMeta',
      'engines',
    ]),
  ],
  [/(^|[\\/])(tsconfig(\.[\w-]+)?|jsconfig)\.json$/, new Set(['compilerOptions'])],
];
/**
 * A known file's keyed object (KEYED_OBJECTS): both sides added whole pairs to one of its top-level objects that are
 * read by key only, and every key in it, old and new, is different. No other JSON object: tools read keys in order
 * (`exports`, `scripts` globs, `moduleNameMapper`), or break ties by order (`compilerOptions.paths`).
 */
function keyedObject(ours: RangeUnits, theirs: RangeUnits, path: string) {
  const all = ours.all;
  const owners = KEYED_OBJECTS.find(([file]) => file.test(path))?.[1];
  if (!owners || ours.parent !== 'object' || !all) return false;
  if (![...ours.units, ...theirs.units, ...all].every((u) => u.type === 'pair')) return false;
  const owner = ours.path?.map(jsonString);
  if (owner?.length !== 1 || !owners.has(owner[0] ?? '')) return false;
  const keys = all.flatMap((u) => jsonString(u.name) ?? []);
  return keys.length === all.length && new Set(keys).size === keys.length;
}
