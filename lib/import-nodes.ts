import type * as TreeSitter from 'web-tree-sitter';
import type { SyntaxLanguage } from './syntax-scope';
import { DIRECTIVE } from './semantic-noise';

/**
 * Import statements from a file's syntax tree, for Reduce noise (lib/explanation-noise.ts). A line is part of an import
 * only when an import node covers it; a line in a string or a template literal never is.
 */
export interface ImportNode {
  /** 0-based rows, inclusive. */
  startRow: number;
  endRow: number;
  /** Nothing but whitespace before the node on its first row, and nothing but whitespace or a comment after it. */
  alone: boolean;
  /**
   * Never import-only: an import run for its side effects (`import 'x'`, Go `_` and `.`, a bare Python module import,
   * `from __future__`), a re-export (`pub use`), or one with a tool directive in or after it (`// eslint-disable-line`,
   * `// @ts-ignore`, `# noqa`): adding the line changes what a tool reports.
   */
  blocked: boolean;
  /** The import statement (or Go spec) as written. */
  text: string;
}

const IMPORT_TYPES: Partial<Record<SyntaxLanguage, ReadonlySet<string>>> = {
  typescript: new Set(['import_statement']),
  tsx: new Set(['import_statement']),
  javascript: new Set(['import_statement']),
  python: new Set(['import_statement', 'import_from_statement', 'future_import_statement']),
  go: new Set(['import_declaration', 'import_spec']),
  rust: new Set(['use_declaration', 'extern_crate_declaration']),
  java: new Set(['import_declaration']),
  csharp: new Set(['using_directive']),
};

function blocked(node: TreeSitter.Node, language: SyntaxLanguage): boolean {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      // `import 'x'` has no clause: it runs the module for its effects.
      return !node.children.some((child) => child.type === 'import_clause') && !/\bimport\s+type\b/.test(node.text);
    case 'python':
      return node.type !== 'import_from_statement' || /^from\s+__future__\b/.test(node.text);
    case 'go':
      return node.type === 'import_spec' && /^\s*[_.]\s/.test(node.text);
    case 'rust':
      return node.children.some((child) => child.type === 'visibility_modifier');
    default:
      return false;
  }
}

/** Lint and type-check directives, beyond the comments the noise comparison counts as code (DIRECTIVE). */
const LINT = /\beslint\b|\bjshint\b|\bglobals?\s|@ts-|prettier-ignore|biome-ignore|\bnoqa\b|\bpylint\b|type:\s*ignore|\bnolint\b|\bistanbul\b|\bc8\b/i;
/** Whether any comment in `text` is a directive a tool reads. */
function directed(text: string, language: SyntaxLanguage): boolean {
  const comments = text.match(language === 'python' ? /#[^\n]*/g : /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? [];
  return comments.some((comment) => DIRECTIVE.test(comment.trim()) || LINT.test(comment));
}

/** Every import node of a parsed text, or undefined when the tree has errors. */
export function importNodes(tree: TreeSitter.Tree, language: SyntaxLanguage, text: string): ImportNode[] | undefined {
  const types = IMPORT_TYPES[language];
  if (!types || tree.rootNode.hasError) return types ? undefined : [];
  const lines = text.split('\n');
  const comment = language === 'python' ? /^\s*(#.*)?$/ : /^\s*(\/\/.*|\/\*.*)?$/;
  const nodes: ImportNode[] = [];
  const visit = (node: TreeSitter.Node) => {
    if (types.has(node.type)) {
      const start = node.startPosition,
        end = node.endPosition;
      // A Go spec is as alone as its declaration, which is read separately.
      const alone =
        node.type === 'import_spec' ||
        (!lines[start.row].slice(0, start.column).trim() && comment.test(lines[end.row]?.slice(end.column) ?? ''));
      const directive = directed(node.text + '\n' + (lines[end.row]?.slice(end.column) ?? ''), language);
      nodes.push({ startRow: start.row, endRow: end.row, alone, blocked: directive || blocked(node, language), text: node.text });
      // Go specs sit inside their declaration; other imports hold no imports.
      if (language !== 'go') return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return nodes;
}

export interface ImportBindings {
  /** The module or path named, or null when the statement names none (a Go declaration's parentheses). */
  module: string | null;
  /** Each local name and what it binds: `module#name`. */
  pairs: [local: string, source: string][];
}
/** A name and its optional `as` alias. Regex groups and split parts can be missing at run time. */
const aliased = (part: string): [name: string, local: string | undefined] => {
  const [name, local] = part.split(/\s+as\s+/) as [string, string | undefined];
  return [name, local];
};
const group = (match: RegExpExecArray, index: number): string | undefined => match[index] as string | undefined;
const unquote = (text: string) => /(['"`])([^'"`]*)\1/.exec(text)?.[2] ?? null;

/** Expands Rust `a::{b, c::{d as e}}` into paths with an optional alias. */
function rustPaths(tree: string, prefix = ''): [path: string, alias?: string][] {
  const result: [string, string?][] = [];
  let depth = 0,
    start = 0;
  const parts: string[] = [];
  for (let i = 0; i < tree.length; i++) {
    if (tree[i] === '{') depth++;
    else if (tree[i] === '}') depth--;
    else if (tree[i] === ',' && depth === 0) {
      parts.push(tree.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(tree.slice(start));
  for (const raw of parts.map((p) => p.trim()).filter(Boolean)) {
    const group = /^(.*?)::\{([\s\S]*)\}$/.exec(raw);
    if (group) {
      result.push(...rustPaths(group[2], prefix + group[1] + '::'));
      continue;
    }
    if (raw.startsWith('{') && raw.endsWith('}')) {
      result.push(...rustPaths(raw.slice(1, -1), prefix));
      continue;
    }
    const alias = /^(.*?)\s+as\s+(\w+)$/.exec(raw);
    const path = (alias ? alias[1] : raw).trim();
    result.push(path === 'self' ? [prefix.replace(/::$/, '')] : [prefix + path, alias?.[2]]);
  }
  return result;
}

/** What an import statement binds, read from its text. Unknown shapes bind nothing and name no module. */
export function importBindings(language: SyntaxLanguage, text: string): ImportBindings {
  const comments = language === 'python' ? /#[^\n]*/g : /\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g;
  const flat = text.replace(comments, ' ').replace(/\s+/g, ' ').trim();
  const pairs: [string, string][] = [];
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript': {
      const module = unquote(/from\s*(['"][^'"]*['"])\s*;?$/.exec(flat)?.[1] ?? flat);
      const clause = /^import\s+(?:type\s+)?(.*?)\s+from\s/.exec(flat)?.[1] ?? '';
      const named = /\{(.*)\}/.exec(clause)?.[1];
      const rest = clause.replace(/\{.*\}/, '').split(',').map((part) => part.trim()).filter(Boolean);
      for (const part of rest) {
        const ns = /^\*\s+as\s+(\w+)$/.exec(part);
        if (ns) pairs.push([ns[1], `${module}#*`]);
        else if (/^[\w$]+$/.test(part)) pairs.push([part, `${module}#default`]);
      }
      for (const part of (named ?? '').split(',').map((p) => p.trim().replace(/^type\s+/, '')).filter(Boolean)) {
        const [name, local] = aliased(part);
        pairs.push([(local ?? name).trim(), `${module}#${name.trim()}`]);
      }
      return { module, pairs };
    }
    case 'python': {
      const from = /^from\s+([\w.]+)\s+import\s+\(?(.*?)\)?$/.exec(flat);
      if (!from) {
        const modules = (/^import\s+(.*)$/.exec(flat)?.[1] ?? '').split(',').map((part) => part.trim());
        for (const part of modules) {
          const [name, local] = aliased(part);
          if (name) pairs.push([(local ?? name.split('.')[0]).trim(), name.trim()]);
        }
        return { module: modules[0]?.split(/\s/)[0] ?? null, pairs };
      }
      for (const part of from[2].split(',').map((p) => p.trim()).filter(Boolean)) {
        const [name, local] = aliased(part);
        pairs.push([(local ?? name).trim(), `${from[1]}#${name.trim()}`]);
      }
      return { module: from[1], pairs };
    }
    case 'go': {
      const spec = /^(?:([\w.]+)\s+)?"([^"]*)"$/.exec(flat.replace(/^import\s+/, ''));
      if (!spec) return { module: null, pairs };
      pairs.push([group(spec, 1) ?? spec[2].split('/').pop() ?? spec[2], spec[2]]);
      return { module: spec[2], pairs };
    }
    case 'rust': {
      const crate = /^extern crate (\w+)(?: as (\w+))?;$/.exec(flat);
      if (crate) return { module: crate[1], pairs: [[group(crate, 2) ?? crate[1], crate[1]]] };
      const body = /^use\s+(.*);$/.exec(flat)?.[1];
      if (!body) return { module: null, pairs };
      const paths = rustPaths(body.replace(/^::/, ''));
      for (const [path, alias] of paths) pairs.push([alias ?? path.split('::').pop() ?? path, path]);
      return { module: paths[0]?.[0].split('::')[0] ?? null, pairs };
    }
    case 'java': {
      const name = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;$/.exec(flat)?.[1];
      if (!name) return { module: null, pairs };
      return { module: name, pairs: [[name.split('.').pop() ?? name, name]] };
    }
    case 'csharp': {
      const using = /^(?:global\s+)?using\s+(?:static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;$/.exec(flat);
      if (!using) return { module: null, pairs };
      return { module: using[2], pairs: [[group(using, 1) ?? `${using[2]}.*`, using[2]]] };
    }
    default:
      return { module: null, pairs };
  }
}
