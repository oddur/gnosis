import type * as TreeSitter from 'web-tree-sitter';
import { classifyNoise, comparisonTexts, comparisonTrees, formattingEquivalent, type NoiseBlock } from './semantic-noise';
import {
  MIN_LINES,
  MOVE_GROUPS,
  changedRows,
  placeBefore,
  sideCandidates,
  treeTokens,
  type FilePrints,
  type SymbolPrint,
  type SymbolSides,
} from './moved-symbols';

/**
 * Enclosing definitions for diff hunks, from a tree-sitter parse (#393).
 *
 * Definitions come from each grammar's own tag query (`queries/tags.scm`, the one GitHub's code navigation uses),
 * with its `@reference.*` patterns dropped, and a few patterns of Gnosis's own for what tag queries leave out: Rust
 * `impl` blocks, TypeScript enums and namespaces, test calls (`describe`, `it`, `test`), and JSON and YAML keys.
 *
 * The module has no runtime import of web-tree-sitter: the worker (lib/syntax-scope.worker.ts) and the unit tests
 * pass the library in, so tests run the real WASM parser in Node.
 */

/** Every bundled grammar, in the order Settings lists them. */
export const SYNTAX_LANGUAGES = ['typescript', 'tsx', 'javascript', 'rust', 'go', 'python', 'java', 'csharp', 'json', 'yaml'] as const;
export type SyntaxLanguage = (typeof SYNTAX_LANGUAGES)[number];
export type DefinitionKind =
  | 'function'
  | 'method'
  | 'property'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'impl'
  | 'trait'
  | 'module'
  | 'type'
  | 'macro'
  | 'test'
  | 'key';

export interface SyntaxDefinition {
  kind: DefinitionKind;
  name: string;
  /** What a hunk header shows after "in", such as `resolvePaths()` or `impl StoreBridge`. */
  label: string;
  /**
   * The definition as one crumb of a hunk's breadcrumb: a short kind word in the language's own terms and the name,
   * such as `fn save`, `impl Bridge for Store`, `class Store`, `save()`, `describe "parser"` or `def load`.
   */
  crumb: string;
  /**
   * The language's kind word that starts `crumb`, such as `fn`, `class`, `impl`, `def` or `record struct`; the
   * breadcrumb tints it as the syntax theme tints keywords. Undefined for a crumb with no kind word, such as `save()`.
   */
  crumbKeyword?: string;
  /** First and last line, from 1, inclusive. Attributes, decorators and `export` belong to the definition. */
  start: number;
  end: number;
  /** Last line of the signature: the line where the body opens, or `start` for a definition without a body. */
  signatureEnd: number;
}

const EXTENSIONS: Record<string, SyntaxLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  rs: 'rust',
  go: 'go',
  py: 'python',
  pyi: 'python',
  java: 'java',
  cs: 'csharp',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
};
/** The grammar for a path, or undefined for a file Gnosis has no grammar for. */
export function syntaxLanguage(path: string): SyntaxLanguage | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name.endsWith('.d.ts')) return 'typescript';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1)] : undefined;
}

/** The files each language's query is built from: the grammar's tag queries, then Gnosis's own patterns. */
export const TAG_QUERIES: Record<SyntaxLanguage, string[]> = {
  // TypeScript's tag query adds to JavaScript's, as the grammar extends JavaScript's.
  typescript: ['javascript', 'typescript'],
  tsx: ['javascript', 'typescript'],
  javascript: ['javascript'],
  rust: ['rust'],
  go: ['go'],
  python: ['python'],
  java: ['java'],
  csharp: ['csharp'],
  json: [],
  yaml: [],
};

const TEST_CALLS = `(call_expression
  function: [(identifier) @_test (member_expression object: (identifier) @_test property: (property_identifier) @_modifier)]
  arguments: (arguments . [(string) (template_string)] @name . [(arrow_function) (function_expression)])
  (#match? @_test "^(describe|it|test|suite|context|bench)$")) @definition.test
`;
const SCRIPT_EXTRA = `${TEST_CALLS}
(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.method
`;
/** Patterns tag queries leave out. Captures follow the tag convention: `@definition.<kind>` and `@name`. */
export const EXTRA_QUERIES: Record<SyntaxLanguage, string> = {
  javascript: SCRIPT_EXTRA.replace(/\(public_field_definition/, '(field_definition').replace(
    'name: (property_identifier)',
    'property: (property_identifier)'
  ),
  typescript: `${SCRIPT_EXTRA}
(enum_declaration name: (identifier) @name) @definition.enum
(internal_module name: (_) @name) @definition.module
(class_declaration name: (type_identifier) @name) @definition.class
`,
  tsx: '',
  rust: `(impl_item) @definition.impl
`,
  go: '',
  python: '',
  java: `(enum_declaration name: (identifier) @name) @definition.enum
(constructor_declaration name: (identifier) @name) @definition.method
(record_declaration name: (identifier) @name) @definition.class
`,
  // The tag query names only single-word namespaces, and no structs, records, enums, constructors or properties.
  csharp: `(namespace_declaration name: (qualified_name) @name) @definition.module
(file_scoped_namespace_declaration name: (_) @name) @definition.module
(struct_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(constructor_declaration name: (identifier) @name) @definition.method
(property_declaration name: (identifier) @name) @definition.property
(local_function_statement name: (identifier) @name) @definition.function
`,
  json: `(pair key: (string (string_content) @name)) @definition.key
`,
  yaml: `(block_mapping_pair key: (flow_node) @name value: (_)) @definition.key
`,
};
EXTRA_QUERIES.tsx = EXTRA_QUERIES.typescript;

/**
 * The top-level patterns of a query that define something. Tag queries also find references, which a scope lookup
 * never uses and which cost most of the matching time.
 */
export function definitionPatterns(query: string): string {
  const forms: string[] = [];
  let depth = 0,
    start = -1,
    inString = false;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === ';') {
      const end = query.indexOf('\n', i);
      i = end < 0 ? query.length : end;
    } else if (c === '(' || c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        // A quantifier or capture right after the form belongs to it.
        let end = i + 1;
        const tail = /^[*+?]?(\s*@[\w.]+)*/.exec(query.slice(end));
        if (tail) end += tail[0].length;
        forms.push(query.slice(start, end));
        i = end - 1;
        start = -1;
      }
    }
  }
  return forms.filter((form) => /@definition\./.test(form)).join('\n\n');
}

const KIND_BY_TYPE: Partial<Record<string, DefinitionKind>> = {
  struct_item: 'struct',
  union_item: 'struct',
  enum_item: 'enum',
  enum_declaration: 'enum',
  type_item: 'type',
  trait_item: 'trait',
  impl_item: 'impl',
  mod_item: 'module',
  module: 'module',
  internal_module: 'module',
  interface_declaration: 'interface',
  class: 'class',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  class_definition: 'class',
  record_declaration: 'class',
  macro_definition: 'macro',
  method_definition: 'method',
  method_declaration: 'method',
  method_signature: 'method',
  abstract_method_signature: 'method',
  constructor_declaration: 'method',
  public_field_definition: 'method',
  field_definition: 'method',
  struct_declaration: 'struct',
  namespace_declaration: 'module',
  file_scoped_namespace_declaration: 'module',
  property_declaration: 'property',
  local_function_statement: 'function',
  pair: 'key',
  block_mapping_pair: 'key',
};
const CAPTURE_KINDS: Partial<Record<string, DefinitionKind>> = {
  function: 'function',
  method: 'method',
  property: 'property',
  class: 'class',
  interface: 'interface',
  module: 'module',
  macro: 'macro',
  type: 'type',
  enum: 'enum',
  impl: 'impl',
  test: 'test',
  key: 'key',
};
/** Kinds that hold methods, for a method's `Owner.name()` label. */
const OWNERS = new Set<DefinitionKind>(['class', 'interface', 'struct', 'enum', 'impl', 'trait']);
/** Node types whose `body` field is not named `body`. */
const BODY_TYPES = new Set([
  'statement_block',
  'class_body',
  'declaration_list',
  'block',
  'field_declaration_list',
  'enum_variant_list',
  'interface_body',
  'object_type',
  'enum_body',
  'object',
  'block_node',
  'block_mapping',
  'accessor_list',
  'enum_member_declaration_list',
]);

type Node = TreeSitter.Node;
const line = (row: number) => row + 1;
/** A node's last line: a node that ends at the start of a line ends on the line before it. */
const lastLine = (node: Node) =>
  node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row
    ? node.endPosition.row
    : node.endPosition.row + 1;

/** The node a definition covers: an `export`, a `const` declaration, or the attributes and decorators above it. */
function outerNode(node: Node): { node: Node; first: Node } {
  let outer = node;
  const parent = node.parent;
  // `const f = () => {}`: the declarator's declaration, when it declares only this.
  if (
    node.type === 'variable_declarator' &&
    parent &&
    /^(lexical|variable)_declaration$/.test(parent.type) &&
    parent.namedChildCount === 1
  )
    outer = parent;
  if (outer.parent?.type === 'export_statement') outer = outer.parent;
  if (outer.parent?.type === 'decorated_definition') outer = outer.parent;
  // Rust attributes and Java annotations are siblings before the item.
  let first = outer;
  for (let previous = outer.previousNamedSibling; previous; previous = previous.previousNamedSibling) {
    if (previous.type !== 'attribute_item' && previous.type !== 'decorator') break;
    if (previous.endPosition.row < first.startPosition.row - 1) break;
    first = previous;
  }
  return { node: outer, first };
}

function bodyOf(node: Node): Node | undefined {
  const field = node.childForFieldName('body') ?? node.childForFieldName('value');
  if (field) {
    if (field.type === 'arrow_function' || field.type === 'function_expression') return bodyOf(field);
    return field;
  }
  if (node.type === 'variable_declarator' || node.type === 'lexical_declaration') return undefined;
  for (const child of node.namedChildren) if (BODY_TYPES.has(child.type)) return child;
  return undefined;
}

/** The last line of the signature: the line the body opens on, or the line before a body that starts a line. */
function signatureEnd(node: Node, start: number): number {
  let target = node;
  if (
    node.type === 'export_statement' ||
    node.type === 'decorated_definition' ||
    /^(lexical|variable)_declaration$/.test(node.type)
  )
    target = node.namedChildren.find((child) => !/^(decorator|comment)$/.test(child.type)) ?? node;
  if (/^(lexical|variable)_declaration$/.test(target.type)) target = target.namedChildren[0] ?? target;
  const body = bodyOf(target);
  if (!body) return start;
  const opens =
    body.text.startsWith('{') || body.text.startsWith('[') || body.startPosition.row === target.startPosition.row;
  return Math.max(start, opens ? line(body.startPosition.row) : body.startPosition.row);
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** A type's name without its generic arguments, for a method's owner. */
const bare = (text: string) => text.replace(/<[\s\S]*$/, '').trim();

/** NUnit, Unity Test Framework, xUnit and MSTest attributes. */
const CSHARP_TEST = /^(Test|TestCase|TestCaseSource|UnityTest|Theory|Fact|TestMethod|DataTestMethod)(Attribute)?$/;
function isCSharpTest(node: Node) {
  return node.namedChildren.some(
    (child) =>
      child?.type === 'attribute_list' &&
      child.namedChildren.some((attribute) => {
        const name = attribute?.childForFieldName('name')?.text ?? '';
        return CSHARP_TEST.test(name.slice(name.lastIndexOf('.') + 1));
      })
  );
}
/** `record` or `record struct`: the words before a record's name. */
const recordKeyword = (node: Node) => {
  const name = node.childForFieldName('name');
  return squash(node.text.slice(0, name ? name.startIndex - node.startIndex : 0).replace(/\[[^\]]*\]/g, ''))
    .split(' ')
    .filter((word) => word === 'record' || word === 'struct' || word === 'class')
    .join(' ');
};

function isRustTest(first: Node, node: Node) {
  for (let at: Node | null = first; at && at !== node; at = at.nextNamedSibling)
    if (at.type === 'attribute_item' && /^#\[\s*(\w+::)*test\b/.test(at.text)) return true;
  return false;
}

/**
 * Every definition in a parsed file, outermost first. `query` is built by `definitionQuery` for the file's language.
 */
export function collectDefinitions(
  tree: TreeSitter.Tree,
  query: TreeSitter.Query,
  language: SyntaxLanguage,
  /**
   * Only definitions that reach these rows (0-based, end exclusive), and the ones around them: moved symbols ask for
   * the definitions their changed rows touch, so a large file's query stays short.
   */
  rows?: readonly (readonly [number, number])[]
): SyntaxDefinition[] {
  const found = new Map<number, { node: Node; first: Node; kind: DefinitionKind; name: string; rank: number }>();
  const matches = rows
    ? rows.flatMap(([start, end]) =>
        query.matches(tree.rootNode, { startPosition: { row: start, column: 0 }, endPosition: { row: end, column: 0 } })
      )
    : query.matches(tree.rootNode);
  for (const match of matches) {
    const definition = match.captures.find((capture) => capture.name.startsWith('definition.'));
    if (!definition) continue;
    const captured = CAPTURE_KINDS[definition.name.slice('definition.'.length)];
    if (!captured) continue;
    const nameNode = match.captures.find((capture) => capture.name === 'name')?.node;
    const { node, first } = outerNode(definition.node);
    let kind: DefinitionKind = KIND_BY_TYPE[definition.node.type] ?? captured;
    if (captured === 'test' || captured === 'method' || captured === 'impl') kind = captured;
    let name = nameNode?.text ?? '';
    if (language === 'rust' && definition.node.type === 'function_item' && isRustTest(first, node)) kind = 'test';
    if (language === 'go' && kind === 'function' && /^(Test|Benchmark|Fuzz)[A-Z_]/.test(name)) kind = 'test';
    if (language === 'python' && (kind === 'function' || kind === 'method') && /^test_?/.test(name)) kind = 'test';
    if (language === 'csharp' && kind === 'method' && isCSharpTest(definition.node)) kind = 'test';
    if (language === 'go' && definition.node.type === 'type_spec') {
      const type = definition.node.childForFieldName('type')?.type;
      kind = type === 'struct_type' ? 'struct' : type === 'interface_type' ? 'interface' : 'type';
    }
    if (language === 'python' && kind === 'function' && definition.node.parent?.parent?.type === 'class_definition')
      kind = 'method';
    if (language === 'python' && kind === 'function' && node.parent?.parent?.type === 'class_definition')
      kind = 'method';
    if (language === 'rust' && kind === 'function' && definition.node.parent?.type === 'declaration_list')
      kind = 'method';
    if (kind === 'impl') {
      const trait = definition.node.childForFieldName('trait')?.text;
      const type = definition.node.childForFieldName('type')?.text ?? '';
      name = trait ? `${squash(trait)} for ${squash(type)}` : squash(type);
    }
    if (kind === 'test' && nameNode) name = nameNode.text.replace(/^[`'"]|[`'"]$/g, '');
    if (kind === 'key' && language === 'json') name = nameNode?.text ?? '';
    // Gnosis's own patterns and the more specific kinds win over a tag query's broader capture of the same node.
    const rank = kind === 'test' ? 3 : kind === 'method' ? 2 : 1;
    const existing = found.get(node.id);
    if (!existing || existing.rank < rank) found.set(node.id, { node, first, kind, name, rank });
  }
  const sorted = [...found.values()]
    .map((entry) => {
      const start = line(entry.first.startPosition.row);
      // `namespace Foo;` covers the rest of the file, though the declarations after it are its siblings.
      const node = entry.node.type === 'file_scoped_namespace_declaration' ? tree.rootNode : entry.node;
      return { ...entry, start, end: Math.max(start, lastLine(node)) };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const result: SyntaxDefinition[] = [];
  for (const entry of sorted) {
    const owner =
      entry.kind === 'method' || entry.kind === 'property'
        ? [...sorted]
            .reverse()
            .find(
              (other) =>
                other !== entry && OWNERS.has(other.kind) && other.start <= entry.start && other.end >= entry.end
            )
        : undefined;
    // A Go method's owner is its receiver's type: `func (s *Store) Save()` is `Store.Save()`.
    const receiver =
      entry.kind === 'method' && language === 'go'
        ? /(\w+)(\[[^\]]*\])?\s*\)\s*$/.exec(entry.node.childForFieldName('receiver')?.text ?? '')?.[1]
        : undefined;
    const ownerName =
      receiver ??
      (owner
        ? bare(owner.kind === 'impl' ? (owner.node.childForFieldName('type')?.text ?? owner.name) : owner.name)
        : '');
    result.push({
      kind: entry.kind,
      name: entry.name,
      label: clip(definitionLabel(entry.kind, entry.name, language, entry.node, ownerName)),
      ...crumbOf(crumbLabel(entry.kind, entry.name, language, entry.node)),
      start: entry.start,
      end: entry.end,
      signatureEnd: Math.min(entry.end, signatureEnd(entry.node, line(entry.node.startPosition.row))),
    });
  }
  return result;
}

function definitionLabel(
  kind: DefinitionKind,
  name: string,
  language: SyntaxLanguage,
  node: Node,
  owner: string
): string {
  switch (kind) {
    case 'function':
      return `${name}()`;
    case 'method':
      return owner ? `${owner}.${name}()` : `${name}()`;
    case 'property':
      return owner ? `${owner}.${name}` : name;
    case 'test': {
      if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
        const callee =
          node.type === 'call_expression' ? squash(node.childForFieldName('function')?.text ?? 'test') : 'test';
        return `${callee}(${JSON.stringify(name)})`;
      }
      return `test ${name}()`;
    }
    case 'impl':
      return `impl ${name}`;
    case 'module':
      return `${language === 'rust' ? 'mod' : 'namespace'} ${name}`;
    case 'key':
      return language === 'json' ? JSON.stringify(name) : `${name}:`;
    default:
      return `${kind} ${name}`;
  }
}

/** The node a definition names, inside an `export`, a decorator or a `const` declaration. */
function innerNode(node: Node): Node {
  let inner = node;
  for (;;) {
    if (inner.type === 'export_statement' || inner.type === 'decorated_definition')
      inner = inner.childForFieldName('declaration') ?? inner.childForFieldName('definition') ?? inner.namedChildren.at(-1) ?? inner;
    else if (/^(lexical|variable)_declaration$/.test(inner.type) && inner.namedChildCount === 1) inner = inner.namedChildren[0] ?? inner;
    else return inner;
  }
}

/** A crumb as its kind word and the rest. */
type CrumbParts = [keyword: string | undefined, rest: string];
function crumbOf([keyword, rest]: CrumbParts): Pick<SyntaxDefinition, 'crumb' | 'crumbKeyword'> {
  const crumb = clip(keyword ? `${keyword} ${rest}` : rest, 48);
  return keyword ? { crumb, crumbKeyword: keyword } : { crumb };
}

function crumbLabel(kind: DefinitionKind, name: string, language: SyntaxLanguage, outer: Node): CrumbParts {
  const node = innerNode(outer);
  const script = language === 'typescript' || language === 'tsx' || language === 'javascript';
  if (kind === 'key') return [undefined, language === 'json' ? JSON.stringify(name) : `${name}:`];
  if (kind === 'test' && script) {
    const callee = node.type === 'call_expression' ? squash(node.childForFieldName('function')?.text ?? 'test') : 'test';
    return [undefined, `${clip(callee, 20)} ${JSON.stringify(name)}`];
  }
  switch (language) {
    case 'rust':
      if (kind === 'function' || kind === 'method' || kind === 'test') return ['fn', name];
      if (kind === 'module') return ['mod', name];
      if (kind === 'macro') return ['macro_rules!', name];
      return [kind, name];
    case 'go': {
      if (kind === 'method') {
        const receiver = squash(node.childForFieldName('receiver')?.text ?? '');
        return ['func', receiver ? `${receiver} ${name}` : name];
      }
      if (kind === 'function' || kind === 'test') return ['func', name];
      return ['type', name];
    }
    case 'python':
      return kind === 'class' ? ['class', name] : ['def', name];
    case 'java':
      return kind === 'method' ? [undefined, `${name}()`] : [kind, name];
    case 'csharp':
      if (kind === 'method' || kind === 'function' || kind === 'test') return [undefined, `${name}()`];
      if (kind === 'property') return [undefined, name];
      if (kind === 'module') return ['namespace', name];
      if (node.type === 'record_declaration') return [/^record\s+struct\b/.test(recordKeyword(node)) ? 'record struct' : 'record', name];
      return [kind, name];
    default:
      if (kind === 'method') return [undefined, `${name}()`];
      if (kind === 'function')
        return /^(function|generator_function)_declaration$/.test(node.type) ? ['function', `${name}()`] : [undefined, `${name}()`];
      if (kind === 'module') return ['namespace', name];
      return [kind, name];
  }
}

/** One syntax node a range of lines holds whole: its type, the declaration inside an `export` or decorator, a name. */
export interface RangeUnit {
  type: string;
  inner?: string;
  /** What tells two units apart: the name, else the node's text. */
  name: string;
  /** A method's parameter types, for overloads. */
  parameters?: string;
  /** A decorator runs with it. */
  decorated?: boolean;
  /** It carries an annotation or attribute (Java `@Override`, C# `[Test]`, Rust `#[...]`), which may run code or matter. */
  annotated?: boolean;
  /** The type of its name node: `property_identifier`, or `computed_property_name`, `string` and the like. */
  nameKind?: string;
  /** A getter or setter. */
  accessor?: boolean;
  /** Its parameter list's text, as written, and whether it declares a return type. */
  signature?: string;
  returns?: boolean;
  /** Its first line, spaces squashed: an import's whole text. */
  head?: string;
}
/** The whole nodes in some lines and the node that holds them. Undefined when a node reaches past the lines. */
export interface RangeUnits {
  parent: string;
  /** The node that holds `parent`: a Python method's `block` sits in a `class_definition`. */
  container?: string;
  units: RangeUnit[];
  /** Every named child of the parent, the units included, for a JSON object: its keys. */
  all?: RangeUnit[];
  /** The node just before the units, comments aside: a decorator or attribute there attaches to what follows it. */
  before?: string;
  /** For a JSON object: the keys of the pairs that hold it, from the document's top. */
  path?: string[];
}
/** Lines [start, end] (1-based, inclusive) as whole nodes of one parent (lib/conflict-union.ts). */
export function rangeUnits(tree: TreeSitter.Tree, start: number, end: number): RangeUnits | undefined {
  const inside = (n: Node) => line(n.startPosition.row) >= start && lastLine(n) <= end;
  const overlaps = (n: Node) => line(n.startPosition.row) <= end && lastLine(n) >= start;
  let node = tree.rootNode;
  for (;;) {
    const hit = node.children.filter(overlaps);
    if (hit.length === 1 && !inside(hit[0])) {
      node = hit[0];
      continue;
    }
    if (!hit.length || hit.some((c) => !inside(c))) return undefined;
    const unitOf = (c: Node): RangeUnit => {
      const inner =
        c.type === 'export_statement' || c.type === 'decorated_definition'
          ? (c.childForFieldName('declaration') ?? c.childForFieldName('definition') ?? undefined)
          : undefined;
      const target = inner ?? c;
      const named = target.childForFieldName('name') ?? target.childForFieldName('key');
      const parameters = target.childForFieldName('parameters');
      const decorated =
        c.type === 'decorated_definition' || [c, target].some((n) => n.children.some((x) => x.type === 'decorator'));
      const marks = (n: Node) => ['annotation', 'marker_annotation', 'attribute_list', 'attribute_item'].includes(n.type);
      const annotated = [c, target].some((n) =>
        n.children.some((x) => marks(x) || (x.type === 'modifiers' && x.children.some(marks)))
      );
      const accessor = target.children.some((x) => !x.isNamed && (x.type === 'get' || x.type === 'set'));
      return {
        type: c.type,
        ...(inner ? { inner: inner.type } : {}),
        name: named ? named.text : squash(c.text),
        ...(named ? { nameKind: named.type } : {}),
        ...(accessor ? { accessor } : {}),
        ...(parameters ? { signature: parameters.text } : {}),
        ...(target.childForFieldName('return_type') ? { returns: true } : {}),
        ...(parameters
          ? {
              parameters: parameters.namedChildren
                .map((p) => squash(p.childForFieldName('type')?.text ?? p.text))
                .join(', '),
            }
          : {}),
        ...(decorated ? { decorated } : {}),
        ...(annotated ? { annotated } : {}),
        head: squash(c.text.split('\n')[0]),
      };
    };
    const units: RangeUnit[] = [];
    for (const c of hit) {
      if (!c.isNamed) {
        if (c.type !== ',' && c.type !== ';') return undefined;
        continue;
      }
      units.push(unitOf(c));
    }
    // An object's keys are read whole, and its place in its document.
    const whole = node.type === 'object';
    let previous = hit[0].previousNamedSibling;
    while (previous && /comment/.test(previous.type)) previous = previous.previousNamedSibling;
    const path: string[] = [];
    if (node.type === 'object')
      for (let at: Node | null = node.parent; at; at = at.parent)
        if (at.type === 'pair') path.unshift(at.childForFieldName('key')?.text ?? '');
    return {
      parent: node.type,
      ...(node.parent ? { container: node.parent.type } : {}),
      units,
      ...(whole ? { all: node.namedChildren.map(unitOf) } : {}),
      ...(previous ? { before: previous.type } : {}),
      ...(node.type === 'object' ? { path } : {}),
    };
  }
}
/**
 * Lines (1-based, inclusive) of a tree's ERROR nodes, outermost only, and of the node each MISSING token is missing
 * from: a `}` missing at the end of the file belongs to the block it would close.
 */
export function errorLines(tree: TreeSitter.Tree): [number, number][] {
  const found: [number, number][] = [];
  const walk = (n: Node) => {
    if (n.isError || n.isMissing) {
      const at = n.isMissing ? (n.parent ?? n) : n;
      found.push([line(at.startPosition.row), Math.max(line(at.startPosition.row), lastLine(at))]);
      return;
    }
    for (const c of n.children) if (c.hasError || c.isMissing) walk(c);
  };
  if (tree.rootNode.hasError) walk(tree.rootNode);
  return found;
}

/** The query for a language: the definition patterns of its tag queries, then Gnosis's own. */
export function definitionQuery(language: SyntaxLanguage, tags: (name: string) => string): string {
  return [...TAG_QUERIES[language].map((name) => definitionPatterns(tags(name))), EXTRA_QUERIES[language]].join('\n\n');
}

// ── Lookups ─────────────────────────────────────────────────────────────────

/**
 * The smallest definition around lines `start`–`end`. A definition that the lines cover entirely, such as a function a
 * hunk adds, is the change itself: the definition around it is the scope.
 */
export function enclosingDefinition(
  definitions: readonly SyntaxDefinition[],
  start: number,
  end: number
): SyntaxDefinition | undefined {
  let best: SyntaxDefinition | undefined;
  for (const definition of definitions) {
    if (definition.start > start || definition.end < end) continue;
    if (definition.start >= start && definition.end <= end) continue;
    if (!best || definition.end - definition.start < best.end - best.start) best = definition;
  }
  return best;
}

/**
 * Every definition around `inner`, outermost first, ending with `inner` itself: the breadcrumb of a hunk whose
 * innermost scope is `inner`, such as `mod api › impl Client › fn list`. A definition with the same lines as the one
 * inside it adds nothing and is left out.
 */
export function definitionChain(definitions: readonly SyntaxDefinition[], inner: SyntaxDefinition): SyntaxDefinition[] {
  const around = definitions
    .filter((d) => d !== inner && d.start <= inner.start && d.end >= inner.end && (d.start < inner.start || d.end > inner.end))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const chain: SyntaxDefinition[] = [];
  for (const definition of around) {
    const last = chain.at(-1);
    if (last && last.start === definition.start && last.end === definition.end) chain[chain.length - 1] = definition;
    else chain.push(definition);
  }
  return [...chain, inner];
}

/**
 * The definition around a point between two lines, for lines deleted from a file whose old side is not loaded:
 * deleted lines sat between new lines `line - 1` and `line`, so their scope holds both.
 */
export const enclosingPoint = (definitions: readonly SyntaxDefinition[], line: number) =>
  enclosingDefinition(definitions, Math.max(1, line - 1), line);

/** "Show whole function" shows at most this many lines of a definition; longer ones show their signature. */
export const WHOLE_DEFINITION_LINES = 150;

export const definitionLines = (definition: Pick<SyntaxDefinition, 'start' | 'end'>) =>
  definition.end - definition.start + 1;

/**
 * What "Show whole function" reveals around a hunk: the whole definition, or, past `cap` lines, its signature and the
 * hunk. Lines are on one side; `start` and `end` already include the hunk.
 */
export type DefinitionReveal =
  | { kind: 'whole'; start: number; end: number }
  | { kind: 'signature'; start: number; end: number };
export function definitionReveal(definition: SyntaxDefinition, cap = WHOLE_DEFINITION_LINES): DefinitionReveal {
  if (definitionLines(definition) <= cap) return { kind: 'whole', start: definition.start, end: definition.end };
  return {
    kind: 'signature',
    start: definition.start,
    end: Math.max(definition.start, Math.min(definition.signatureEnd, definition.start + 9)),
  };
}

// ── Engine ──────────────────────────────────────────────────────────────────

/** Files larger than this are not parsed: their scopes are not worth a worker's time and memory. */
export const SYNTAX_MAX_CHARACTERS = 1_000_000;

export interface SyntaxEngineFiles {
  /** The runtime's own `web-tree-sitter.wasm`. */
  runtime: () => Promise<Uint8Array>;
  grammar: (language: SyntaxLanguage) => Promise<Uint8Array>;
  /** A grammar package's `tags.scm`, by the names in TAG_QUERIES. */
  tags: (name: string) => Promise<string>;
}
export interface DefinitionsResult {
  definitions: SyntaxDefinition[];
  /** The tree holds an ERROR or MISSING node: the text does not parse cleanly. */
  errors: boolean;
  /** Where: the lines of each outermost ERROR or MISSING node. */
  errorLines?: [number, number][];
  /** The whole nodes in each range asked for (`definitions`' `ranges`). */
  units?: (RangeUnits | undefined)[];
  /** Milliseconds parsing and querying; `load` is grammar loading, when this call loaded it. */
  parse: number;
  query: number;
  load?: number;
}

/** What the conflict checks read from one text (lib/conflict-verify.ts). */
export type SyntaxCheck = Pick<DefinitionsResult, 'definitions' | 'errors' | 'errorLines' | 'units'>;

/**
 * Loads grammars on demand and finds a file's definitions. Each language's grammar and query load once; trees are
 * deleted as soon as their definitions are read, so WASM memory holds no files.
 */
export function createSyntaxEngine(ts: typeof TreeSitter, files: SyntaxEngineFiles) {
  let ready: Promise<void> | undefined;
  const languages = new Map<SyntaxLanguage, Promise<{ language: TreeSitter.Language; query: TreeSitter.Query }>>();
  let parser: TreeSitter.Parser | undefined;
  let parses = 0;
  const parse = (text: string, previous?: TreeSitter.Tree | null) => {
    parses++;
    return parser?.parse(text, previous) ?? null;
  };
  const init = () => {
    if (!ready) {
      const starting = files
        .runtime()
        .then((wasmBinary) =>
          ts.Parser.init({ wasmBinary: wasmBinary as unknown as ArrayBuffer, locateFile: (name: string) => name })
        )
        .then(() => {
          parser = new ts.Parser();
        });
      // A runtime that failed to start is tried again on the next call, as a grammar that failed to load is.
      starting.catch(() => {
        if (ready === starting) ready = undefined;
      });
      ready = starting;
    }
    return ready;
  };
  const load = (id: SyntaxLanguage) => {
    let pending = languages.get(id);
    if (!pending) {
      pending = (async () => {
        await init();
        const language = await ts.Language.load(await files.grammar(id));
        const sources = new Map<string, string>();
        for (const name of TAG_QUERIES[id]) sources.set(name, await files.tags(name));
        const query = new ts.Query(
          language,
          definitionQuery(id, (name) => sources.get(name) ?? '')
        );
        return { language, query };
      })();
      pending.catch(() => languages.delete(id));
      languages.set(id, pending);
    }
    return pending;
  };
  const api = {
    /** Loads a grammar and its query ahead of the first parse that needs it. */
    warm: (id: SyntaxLanguage) => load(id).then(() => undefined),
    async definitions(
      id: SyntaxLanguage,
      text: string,
      /** Line ranges (1-based, inclusive) to read as whole nodes (rangeUnits). */
      ranges?: readonly (readonly [number, number])[]
    ): Promise<DefinitionsResult> {
      const loading = !languages.has(id);
      const t0 = performance.now();
      const { language, query } = await load(id);
      const t1 = performance.now();
      if (!parser) throw Error('The parser did not start');
      parser.setLanguage(language);
      const tree = parse(text);
      if (!tree) throw Error('The file did not parse');
      const t2 = performance.now();
      try {
        const definitions = collectDefinitions(tree, query, id);
        return {
          definitions,
          errors: tree.rootNode.hasError,
          ...(tree.rootNode.hasError ? { errorLines: errorLines(tree) } : {}),
          ...(ranges ? { units: ranges.map(([start, end]) => rangeUnits(tree, start, end)) } : {}),
          parse: t2 - t1,
          query: performance.now() - t2,
          ...(loading ? { load: t1 - t0 } : {}),
        };
      } finally {
        tree.delete();
      }
    },
    /** Whether two versions of a file are the same program, formatting aside (lib/semantic-noise.ts). */
    async equivalent(id: SyntaxLanguage, before: string, after: string): Promise<boolean> {
      const { language } = await load(id);
      if (!parser) throw Error('The parser did not start');
      parser.setLanguage(language);
      return formattingEquivalent({ parse: (text, previous) => parse(text, previous) }, id, before, after);
    },
    /**
     * Formatting-only and comment-only changes (lib/semantic-noise.ts): each change block of `hunks`, from the new
     * side's text. Both sides are parsed here and deleted before this returns.
     */
    async noise(
      id: SyntaxLanguage,
      after: string,
      hunks: Parameters<typeof classifyNoise>[3],
      /** Also fingerprint the file's moved-symbol candidates, from the same two trees (lib/moved-symbols.ts). */
      withSymbols = false
    ): Promise<NoiseResult> {
      const loading = !languages.has(id);
      const t0 = performance.now();
      const { language, query } = await load(id);
      const t1 = performance.now();
      if (!parser) throw Error('The parser did not start');
      parser.setLanguage(language);
      let symbols: FilePrints | undefined;
      let symbolsError: string | undefined;
      const blocks = classifyNoise(
        { parse: (text, previous) => parse(text, previous) },
        id,
        after,
        hunks,
        withSymbols
          ? (texts, beforeTree, afterTree) => {
              try {
                if (!beforeTree || !afterTree) throw Error('The file did not parse');
                const sides = symbolSidesOf(texts);
                const before = sideCandidatesOf(beforeTree, sides.before, query, id),
                  now = sideCandidatesOf(afterTree, sides.after, query, id);
                const found: FilePrints = { before: placeBefore(before.prints, sides.at), after: now.prints };
                if (before.capped || now.capped) found.capped = true;
                symbols = found;
              } catch (error) {
                // Only the symbols fail: the comparison's blocks are returned all the same.
                symbolsError = error instanceof Error ? error.message : String(error);
              }
            }
          : undefined
      );
      // No change blocks: nothing parsed, and nothing moved.
      if (withSymbols && !symbols && !blocks.length) symbols = { before: [], after: [] };
      if (withSymbols && !symbols) symbolsError ??= 'The file does not match its diff';
      return { blocks, symbols, symbolsError, classify: performance.now() - t1, ...(loading ? { load: t1 - t0 } : {}) };
    },
    /**
     * Moved and renamed symbols (lib/moved-symbols.ts): the fingerprints of a file's candidates, the definitions most
     * of whose lines its diff removes or adds. An added or deleted file is its one side, parsed once. A modified file
     * comes as its new side and hunks, and is read by the noise comparison's two trees (`noise` with symbols): its
     * old side is the new one with the hunks undone, parsed incrementally from the new tree.
     */
    async symbols(id: SyntaxLanguage, input: SymbolsInput): Promise<SymbolsResult> {
      const loading = !languages.has(id);
      const t0 = performance.now();
      const { language, query } = await load(id);
      const t1 = performance.now();
      if (!parser) throw Error('The parser did not start');
      parser.setLanguage(language);
      if (input.mode === 'modified') {
        const texts = comparisonTexts(input.text, input.hunks);
        if (!texts) throw Error('The file does not match its diff');
        const prints: FilePrints = { before: [], after: [] };
        if (texts.blocks.length) {
          // The old tree comes from the new one, edited and parsed incrementally, as for the noise comparison.
          const { oldTree, newTree } = comparisonTrees({ parse: (text, previous) => parse(text, previous) }, texts);
          try {
            if (!oldTree || !newTree) throw Error('The file did not parse');
            const sides = symbolSidesOf(texts);
            const before = sideCandidatesOf(oldTree, sides.before, query, id),
              now = sideCandidatesOf(newTree, sides.after, query, id);
            prints.before = placeBefore(before.prints, sides.at);
            prints.after = now.prints;
            if (before.capped || now.capped) prints.capped = true;
          } finally {
            oldTree?.delete();
            newTree?.delete();
          }
        }
        return { prints, ms: performance.now() - t1, ...(loading ? { load: t1 - t0 } : {}) };
      }
      const side = { text: input.text, changed: new Uint8Array(input.text.split('\n').length + 1).fill(1) };
      const tree = parse(side.text);
      if (!tree) throw Error('The file did not parse');
      try {
        const found = sideCandidatesOf(tree, side, query, id);
        const prints: FilePrints =
          input.mode === 'added' ? { before: [], after: found.prints } : { before: found.prints, after: [] };
        if (found.capped) prints.capped = true;
        return { prints, ms: performance.now() - t1, ...(loading ? { load: t1 - t0 } : {}) };
      } finally {
        tree.delete();
      }
    },
    /** Parses so far, for the cost checks: definitions, noise comparisons and moved symbols together. */
    parses: () => parses,
  };
  return api;
}

/** A side's moved-symbol candidates from its tree: none read unless some definition could be one. */
function sideCandidatesOf(
  tree: TreeSitter.Tree,
  side: { text: string; changed: Uint8Array } | undefined,
  query: TreeSitter.Query,
  id: SyntaxLanguage
): { prints: SymbolPrint[]; capped: boolean } {
  if (!side || !side.changed.some((row) => row)) return { prints: [], capped: false };
  // A candidate's declaration row is changed: only definitions reaching changed rows are asked for.
  const rows: [number, number][] = [];
  side.changed.forEach((changed, row) => {
    if (!changed) return;
    const last = rows.at(-1);
    if (last && row - last[1] <= 2) last[1] = row + 1;
    else rows.push([row, row + 1]);
  });
  const definitions = collectDefinitions(tree, query, id, rows.length <= 400 ? rows : undefined);
  // Most files change no whole definition: their tokens are never read.
  const worth = definitions.some((d) => {
    if (!MOVE_GROUPS[d.kind] || d.end - d.start + 1 < MIN_LINES) return false;
    // A candidate's declaration changes too: a class whose header stays is no candidate, however many rows it holds.
    let declared = false;
    for (let r = d.start - 1; r < d.signatureEnd && !declared; r++) declared = !!side.changed[r];
    if (!declared) return false;
    let touched = 0;
    for (let r = d.start - 1; r < d.end; r++) touched += side.changed[r] ?? 0;
    return touched >= MIN_LINES;
  });
  return worth ? sideCandidates(definitions, treeTokens(tree, side.text), side.changed) : { prints: [], capped: false };
}

export type SymbolsInput =
  | { mode: 'modified'; text: string; hunks: Parameters<typeof classifyNoise>[3] }
  | { mode: 'added' | 'deleted'; text: string };
export interface SymbolsResult {
  prints: FilePrints;
  /** Milliseconds parsing both sides and fingerprinting them; `load` is grammar loading, when this call loaded it. */
  ms: number;
  load?: number;
}

/** A modified file's sides for its symbols, from the comparison's two texts (comparisonTexts). */
function symbolSidesOf(texts: NonNullable<ReturnType<typeof comparisonTexts>>): SymbolSides & { before: { text: string; changed: Uint8Array }; after: { text: string; changed: Uint8Array } } {
  const rows = (text: string) => text.split('\n').length;
  const { blocks } = texts;
  const afterChanged = changedRows(rows(texts.after), blocks.map((b) => ({ row: b.newRow, count: b.newCount })));
  const afterLines = texts.after.split('\n');
  // A new line that only separates changes (blank, or punctuation alone) or is itself changed belongs to the same
  // change region: a removed block and an added one parted by blank context lines are one edit in place.
  const joins = (line: number) => line >= 1 && line <= afterLines.length && (!!afterChanged[line - 1] || !/[\p{L}\p{N}_$]/u.test(afterLines[line - 1]));
  const place = (row: number): [number, number] => {
    let offset = 0;
    for (const block of blocks) {
      if (row < block.oldRow) break;
      if (row < block.oldRow + block.oldCount) return [block.newRow + 1, block.newRow + Math.max(1, block.newCount)];
      offset += block.newCount - block.oldCount;
    }
    return [row + offset + 1, row + offset + 1];
  };
  return {
    before: { text: texts.before, changed: changedRows(rows(texts.before), blocks.map((b) => ({ row: b.oldRow, count: b.oldCount }))) },
    after: { text: texts.after, changed: afterChanged },
    at: (row) => {
      let [first, last] = place(row);
      while (joins(first - 1)) first--;
      // A deleted block sits before `last`: the line it sits before may itself join the region.
      if (!joins(last)) return [first, last];
      while (joins(last + 1)) last++;
      return [first, last];
    },
  };
}
export interface NoiseResult {
  blocks: NoiseBlock[];
  /** The file's moved-symbol candidates, when asked for and the hunks match the text. */
  symbols?: FilePrints;
  /** Why the candidates were asked for and not found; the blocks stand regardless. */
  symbolsError?: string;
  /** Milliseconds parsing both sides and comparing them; `load` is grammar loading, when this call loaded it. */
  classify: number;
  load?: number;
}
