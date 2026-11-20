// The conflict permutation matrix: every pattern in tests/fixtures/conflicts/MATRIX.md, rendered in each language it
// applies to, with seeded variation (position, indentation, line endings, nesting, file size). Deterministic: the same
// seed gives the same cases. Nothing here is committed as fixtures except a small sample (`--write-sample`).
//
//   npm run conflict-lab -- --matrix [--variants 4] [--seed 1] [--only add-import]
//   node scripts/conflict-lab-generate.mjs --list                 patterns and languages
//   node scripts/conflict-lab-generate.mjs --write-sample <dir>   writes a few cases as fixture directories
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- the model a pattern describes
// Items: fn { name, params, body, doc }, const { name, value }, group { items } (no blank lines between),
// enum { name, members: [[name, value]] }, struct { name, fields }, switch { name, arms: [[label, value]] },
// obj { name, entries: [[key, value]] }, list { name, values }.
// Statements: ['let', name, expr] | ['ret', expr] | ['if', cond, expr] (if cond, return expr).
// Expressions: a string in the shared syntax (`value + 1`), or { call, args, multiline } (a call to a sibling).
const fn = (name, body = stdBody(), extra = {}) => ({ t: 'fn', name, params: ['value'], body, ...extra });
const stdBody = (a = 'value + 1', b = 'total * 2', c = 'scaled - 3') => [
  ['let', 'total', a],
  ['let', 'scaled', b],
  ['ret', c],
];
const constGroup = (pairs) => ({ t: 'group', items: pairs.map(([name, value]) => ({ t: 'const', name, value })) });

// ---------------------------------------------------------------- languages
const CODE = ['ts', 'tsx', 'js', 'py', 'cs', 'go', 'rs', 'java'];
const EXT = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  py: 'py',
  cs: 'cs',
  go: 'go',
  rs: 'rs',
  java: 'java',
  json: 'json',
  yaml: 'yml',
  css: 'css',
};
const LANGUAGE = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  py: 'python',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  java: 'java',
  json: 'json',
  yaml: 'yaml',
  css: 'css',
};
const DOC = {
  ts: (t) => `/** ${t} */`,
  tsx: (t) => `/** ${t} */`,
  js: (t) => `/** ${t} */`,
  java: (t) => `/** ${t} */`,
  cs: (t) => `/// ${t}`,
  rs: (t) => `/// ${t}`,
  go: (t) => `// ${t}`,
};
const TRAILING_CALL_COMMA = new Set(['ts', 'tsx', 'js', 'py', 'go', 'rs']);

/** Renders a model as a file in one language. `ind` is the indent unit; `nest` is top, class or nested. */
function render(lang, model, { ind, nest }) {
  const I = (d) => ind.repeat(d);
  const items = model.items;
  const out = [];
  const hasType = (...t) =>
    items.some((i) => t.includes(i.t) || (i.t === 'group' && i.items.some((x) => t.includes(x.t))));
  // ---- data languages
  if (lang === 'json') {
    const value = (v) => (typeof v === 'number' ? String(v) : JSON.stringify(v));
    const member = (item, d) => {
      if (item.t === 'const') return [`${I(d)}"${item.name}": ${value(item.value)}`];
      if (item.t === 'group')
        return item.items.flatMap((x, k) =>
          member(x, d).map((l, j, a) => (j === a.length - 1 && k < item.items.length - 1 ? l + ',' : l))
        );
      const entries =
        item.t === 'list' ? item.values.map((v) => [null, v]) : item.t === 'enum' ? item.members : item.entries;
      const [open, close] = item.t === 'list' ? ['[', ']'] : ['{', '}'];
      return [
        `${I(d)}"${item.name}": ${open}`,
        ...entries.map(
          ([k, v], j) => `${I(d + 1)}${k === null ? '' : `"${k}": `}${value(v)}${j < entries.length - 1 ? ',' : ''}`
        ),
        `${I(d)}${close}`,
      ];
    };
    const wraps = nest === 'top' ? [] : nest === 'class' ? ['config'] : ['config', 'section'];
    out.push('{');
    wraps.forEach((w, k) => out.push(`${I(k + 1)}"${w}": {`));
    const d = wraps.length + 1;
    items.forEach((item, k) => {
      const lines = member(item, d);
      if (k < items.length - 1) lines[lines.length - 1] += ',';
      out.push(...lines);
    });
    for (let k = wraps.length; k > 0; k--) out.push(`${I(k)}}`);
    out.push('}');
    return out.join('\n') + '\n';
  }
  if (lang === 'yaml') {
    const wraps = nest === 'top' ? [] : nest === 'class' ? ['config'] : ['config', 'section'];
    wraps.forEach((w, k) => out.push(`${I(k)}${w}:`));
    const d = wraps.length;
    const member = (item) => {
      if (item.t === 'const') return [`${I(d)}${item.name}: ${item.value}`];
      if (item.t === 'group') return item.items.flatMap(member);
      if (item.t === 'list') return [`${I(d)}${item.name}:`, ...item.values.map((v) => `${I(d + 1)}- ${v}`)];
      const entries = item.t === 'enum' ? item.members : item.entries;
      return [`${I(d)}${item.name}:`, ...entries.map(([k, v]) => `${I(d + 1)}${k}: ${v}`)];
    };
    for (const item of items) out.push(...member(item));
    return out.join('\n') + '\n';
  }
  if (lang === 'css') {
    const wraps =
      nest === 'top' ? [] : nest === 'class' ? ['@media screen'] : ['@media screen', '@supports (display: grid)'];
    wraps.forEach((w, k) => out.push(`${I(k)}${w} {`));
    const d = wraps.length;
    const rule = (sel, decls) => [`${I(d)}${sel} {`, ...decls.map(([p, v]) => `${I(d + 1)}${p}: ${v};`), `${I(d)}}`];
    items.forEach((item, k) => {
      if (k) out.push('');
      if (item.t === 'group')
        out.push(
          ...rule(
            ':root',
            item.items.map((c) => [`--${c.name}`, `${c.value}px`])
          )
        );
      else if (item.t === 'const') out.push(...rule(':root', [[`--${item.name}`, `${item.value}px`]]));
      else if (item.t === 'obj' || item.t === 'enum')
        out.push(
          ...rule(
            `.${item.name}`,
            (item.entries ?? item.members).map(([p, v]) => [p, `${v}px`])
          )
        );
      else if (item.t === 'fn')
        out.push(
          ...rule(
            `.${item.name}`,
            item.body.map((s, j) => [`margin-${['top', 'right', 'bottom', 'left'][j % 4]}`, `${digits(s)}px`])
          )
        );
    });
    for (let k = wraps.length - 1; k >= 0; k--) out.push(`${I(k)}}`);
    return out.join('\n') + '\n';
  }
  // ---- code languages: where items live, and whether they are class members
  let depth = 0;
  let member = false; // methods with a receiver: this., self., s.
  let staticMembers = false;
  const open = [];
  const close = [];
  const header = [];
  const imports = model.imports ?? [];
  const typesInside = hasType('enum', 'struct');
  /** Opens a container: its first lines at the current depth, its closing line, and one level deeper inside. */
  const wrap = (first, last, asMember = member) => {
    open.push(...first.map((l) => (l ? `${I(depth)}${l}` : l)));
    close.unshift(`${I(depth)}${last}`);
    depth++;
    member = asMember;
  };
  if (lang === 'ts' || lang === 'tsx' || lang === 'js') {
    header.push(...imports.map((m) => `import { ${m} } from './${m}';`));
    // A TS enum or interface cannot live in a class, so those nest in namespaces.
    const useNamespace = typesInside && lang !== 'js';
    if (nest === 'nested' && lang !== 'js') wrap(['export namespace Lab {'], '}');
    if (nest !== 'top' && useNamespace && nest === 'class') wrap(['export namespace Lab {'], '}');
    if (nest !== 'top' && !useNamespace) wrap(['export class Service {'], '}', true);
  } else if (lang === 'py') {
    header.push(...imports.map((m) => `import ${m}`));
    if (hasType('enum')) header.push('from enum import Enum');
    if (hasType('struct')) header.push('from dataclasses import dataclass');
    if (nest === 'nested') wrap(['class Outer:'], '');
    if (nest !== 'top') wrap(['class Service:'], '', true);
    close.length = 0;
  } else if (lang === 'cs') {
    header.push(...imports.map((m) => `using Lab.${cap(m)};`));
    if (nest === 'top') {
      wrap(['public static class Lab', '{'], '}');
      staticMembers = true;
    } else {
      wrap(['namespace Lab', '{'], '}');
      wrap(['public class Service', '{'], '}');
      if (nest === 'nested') wrap(['public class Inner', '{'], '}');
    }
  } else if (lang === 'java') {
    header.push('package lab;', ...(imports.length ? [''] : []), ...imports.map((m) => `import lab.${m}.${cap(m)};`));
    wrap(['public class Lab {'], '}');
    staticMembers = nest === 'top';
    if (nest !== 'top') wrap(['static class Service {'], '}');
    if (nest === 'nested') wrap(['class Inner {'], '}');
  } else if (lang === 'go') {
    // Go has no classes: "class" and "nested" put the functions on a receiver type.
    header.push('package lab');
    if (imports.length) header.push('', 'import (', ...imports.map((m) => `${I(1)}"lab/${m}"`), ')');
    if (nest !== 'top') {
      header.push('', 'type Service struct{}');
      member = true;
    }
  } else if (lang === 'rs') {
    header.push(...imports.map((m) => `use crate::${m};`));
    // Enums and structs cannot live in an impl block, so those nest in modules.
    if (nest === 'nested') wrap(['pub mod inner {'], '}');
    if (nest === 'class' && typesInside) wrap(['pub mod inner {'], '}');
    if (nest !== 'top' && !typesInside) wrap(['pub struct Service;', '', 'impl Service {'], '}', true);
  }
  const call = (name) =>
    member ? ({ ts: 'this.', tsx: 'this.', js: 'this.', py: 'self.', rs: 'self.', go: 's.' }[lang] ?? '') + name : name;
  const expr = (e, d) => {
    if (typeof e === 'string') return e.replace(/\b([a-z]\w*)\(/g, (m, n) => (n === 'combine' ? m : `${call(n)}(`));
    const callee = e.call === 'combine' ? 'combine' : call(e.call);
    if (!e.multiline) return `${callee}(${e.args.join(', ')})`;
    const comma = TRAILING_CALL_COMMA.has(lang) ? ',' : '';
    return `${callee}(\n${e.args.map((a, k) => `${I(d + 1)}${a}${k < e.args.length - 1 ? ',' : comma}`).join('\n')}\n${I(d)})`;
  };
  const semi = lang === 'py' || lang === 'go' ? '' : ';';
  const stmt = (s, d) => {
    const [k, a, b] = s;
    if (k === 'let') {
      const kw = { ts: 'const ', tsx: 'const ', js: 'const ', py: '', cs: 'var ', java: 'var ', go: '', rs: 'let ' }[
        lang
      ];
      return [`${I(d)}${kw}${a} ${lang === 'go' ? ':=' : '='} ${expr(b, d)}${semi}`];
    }
    if (k === 'ret') return [`${I(d)}return ${expr(a, d)}${semi}`];
    if (k === 'if') {
      if (lang === 'py') return [`${I(d)}if ${a}:`, `${I(d + 1)}return ${expr(b, d + 1)}`];
      if (lang === 'go') return [`${I(d)}if ${a} {`, `${I(d + 1)}return ${expr(b, d + 1)}`, `${I(d)}}`];
      if (lang === 'rs') return [`${I(d)}if ${a} {`, `${I(d + 1)}return ${expr(b, d + 1)};`, `${I(d)}}`];
      return [`${I(d)}if (${a}) return ${expr(b, d)};`];
    }
    throw new Error(`statement ${k}`);
  };
  const T = { ts: ': number', tsx: ': number', js: '', py: '', cs: 'int ', java: 'int ', go: ' int', rs: ': i64' }[
    lang
  ];
  const param = (p) => (lang === 'cs' || lang === 'java' ? `int ${p}` : lang === 'go' ? `${p} int` : `${p}${T}`);
  const signature = (item, d) => {
    const params = item.params.map(param);
    const st = staticMembers ? 'static ' : '';
    switch (lang) {
      case 'ts':
      case 'tsx':
      case 'js':
        return `${I(d)}${member ? '' : 'export function '}${item.name}(${params.join(', ')})${lang === 'js' ? '' : ': number'} {`;
      case 'py':
        return `${I(d)}def ${item.name}(${[...(member ? ['self'] : []), ...params].join(', ')}):`;
      case 'cs':
        return `${I(d)}public ${st}int ${item.name}(${params.join(', ')})`;
      case 'java':
        return `${I(d)}${st}int ${item.name}(${params.join(', ')}) {`;
      case 'go':
        return `${I(d)}func ${member ? '(s *Service) ' : ''}${item.name}(${params.join(', ')}) int {`;
      case 'rs':
        return `${I(d)}pub fn ${item.name}(${[...(member ? ['&self'] : []), ...params].join(', ')}) -> i64 {`;
    }
  };
  const block = (d, inner) => {
    if (lang === 'py') return inner;
    if (lang === 'cs') return [`${I(d)}{`, ...inner, `${I(d)}}`];
    return [...inner, `${I(d)}}`];
  };
  const renderItem = (item, d) => {
    switch (item.t) {
      case 'group':
        return item.items.flatMap((x) => renderItem(x, d));
      case 'fn': {
        const doc = item.doc && lang !== 'py' ? [`${I(d)}${DOC[lang](item.doc)}`] : [];
        const pyDoc = item.doc && lang === 'py' ? [`${I(d + 1)}"""${item.doc}"""`] : [];
        return [...doc, signature(item, d), ...block(d, [...pyDoc, ...item.body.flatMap((s) => stmt(s, d + 1))])];
      }
      case 'const':
        return [
          {
            ts: member
              ? `${I(d)}static readonly ${item.name} = ${item.value};`
              : `${I(d)}export const ${item.name} = ${item.value};`,
            js: member
              ? `${I(d)}static ${item.name} = ${item.value};`
              : `${I(d)}export const ${item.name} = ${item.value};`,
            py: `${I(d)}${item.name} = ${item.value}`,
            cs: `${I(d)}public const int ${item.name} = ${item.value};`,
            java: `${I(d)}static final int ${item.name} = ${item.value};`,
            go: `${I(d)}const ${item.name} = ${item.value}`,
            rs: `${I(d)}pub const ${item.name}: i64 = ${item.value};`,
          }[lang === 'tsx' ? 'ts' : lang],
        ];
      case 'enum': {
        const m = item.members;
        if (lang === 'py') return [`${I(d)}class ${item.name}(Enum):`, ...m.map(([k, v]) => `${I(d + 1)}${k} = ${v}`)];
        if (lang === 'go') return [`${I(d)}const (`, ...m.map(([k, v]) => `${I(d + 1)}${k} = ${v}`), `${I(d)})`];
        if (lang === 'java')
          return [
            `${I(d)}enum ${item.name} {`,
            ...m.map(([k, v]) => `${I(d + 1)}${k}(${v}),`),
            `${I(d + 1)};`,
            `${I(d + 1)}final int v;`,
            `${I(d + 1)}${item.name}(int v) { this.v = v; }`,
            `${I(d)}}`,
          ];
        if (lang === 'js')
          return [
            `${I(d)}${member ? 'static ' : 'export const '}${item.name} = Object.freeze({`,
            ...m.map(([k, v]) => `${I(d + 1)}${k}: ${v},`),
            `${I(d)}});`,
          ];
        const head = {
          ts: `export enum ${item.name} {`,
          tsx: `export enum ${item.name} {`,
          cs: `public enum ${item.name}`,
          rs: `pub enum ${item.name} {`,
        }[lang];
        const body = m.map(([k, v]) => `${I(d + 1)}${k} = ${v},`);
        return lang === 'cs'
          ? [`${I(d)}${head}`, `${I(d)}{`, ...body, `${I(d)}}`]
          : [`${I(d)}${head}`, ...body, `${I(d)}}`];
      }
      case 'struct': {
        const f = item.fields;
        if (lang === 'py')
          return [`${I(d)}@dataclass`, `${I(d)}class ${item.name}:`, ...f.map((x) => `${I(d + 1)}${x}: int = 0`)];
        if (lang === 'go')
          return [`${I(d)}type ${item.name} struct {`, ...f.map((x) => `${I(d + 1)}${cap(x)} int`), `${I(d)}}`];
        if (lang === 'rs')
          return [`${I(d)}pub struct ${item.name} {`, ...f.map((x) => `${I(d + 1)}pub ${x}: i64,`), `${I(d)}}`];
        if (lang === 'cs')
          return [
            `${I(d)}public class ${item.name}`,
            `${I(d)}{`,
            ...f.map((x) => `${I(d + 1)}public int ${x};`),
            `${I(d)}}`,
          ];
        if (lang === 'java')
          return [`${I(d)}static class ${item.name} {`, ...f.map((x) => `${I(d + 1)}int ${x};`), `${I(d)}}`];
        return [`${I(d)}export interface ${item.name} {`, ...f.map((x) => `${I(d + 1)}${x}: number;`), `${I(d)}}`];
      }
      case 'obj': {
        const e = item.entries;
        if (lang === 'py')
          return [`${I(d)}${item.name} = {`, ...e.map(([k, v]) => `${I(d + 1)}"${k}": ${v},`), `${I(d)}}`];
        const head = member ? `static ${item.name} = {` : `export const ${item.name} = {`;
        return [`${I(d)}${head}`, ...e.map(([k, v]) => `${I(d + 1)}${k}: ${v},`), `${I(d)}};`];
      }
      case 'list': {
        const v = item.values.map(
          (x) => `${I(d + 1)}${lang === 'ts' || lang === 'tsx' || lang === 'js' ? `'${x}'` : `"${x}"`},`
        );
        const head = {
          ts: member ? `static ${item.name} = [` : `export const ${item.name} = [`,
          js: member ? `static ${item.name} = [` : `export const ${item.name} = [`,
          py: `${item.name} = [`,
          cs: `public static readonly string[] ${item.name} =`,
          java: `static final String[] ${item.name} = {`,
          go: `var ${item.name} = []string{`,
          rs: `pub const ${item.name}: &[&str] = &[`,
        }[lang === 'tsx' ? 'ts' : lang];
        const end = { ts: '];', js: '];', py: ']', cs: '};', java: '};', go: '}', rs: '];' }[
          lang === 'tsx' ? 'ts' : lang
        ];
        return lang === 'cs'
          ? [`${I(d)}${head}`, `${I(d)}{`, ...v, `${I(d)}${end}`]
          : [`${I(d)}${head}`, ...v, `${I(d)}${end}`];
      }
      case 'switch': {
        const sig = signature({ name: item.name, params: ['k'] }, d);
        const arms = item.arms;
        let inner;
        if (lang === 'rs')
          inner = [
            `${I(d + 1)}match k {`,
            ...arms.map(([l, v]) => `${I(d + 2)}${l} => ${v},`),
            `${I(d + 2)}_ => 0,`,
            `${I(d + 1)}}`,
          ];
        else if (lang === 'py')
          inner = [
            `${I(d + 1)}match k:`,
            ...arms.flatMap(([l, v]) => [`${I(d + 2)}case ${l}:`, `${I(d + 3)}return ${v}`]),
            `${I(d + 2)}case _:`,
            `${I(d + 3)}return 0`,
          ];
        else if (lang === 'go')
          inner = [
            `${I(d + 1)}switch k {`,
            ...arms.flatMap(([l, v]) => [`${I(d + 1)}case ${l}:`, `${I(d + 2)}return ${v}`]),
            `${I(d + 1)}}`,
            `${I(d + 1)}return 0`,
          ];
        else
          inner = [
            `${I(d + 1)}switch (k) {`,
            ...arms.flatMap(([l, v]) => [`${I(d + 2)}case ${l}:`, `${I(d + 3)}return ${v};`]),
            `${I(d + 2)}default:`,
            `${I(d + 3)}return 0;`,
            `${I(d + 1)}}`,
          ];
        return [sig, ...block(d, inner)];
      }
    }
    throw new Error(`item ${item.t} in ${lang}`);
  };
  out.push(...header);
  if (header.length) out.push('');
  out.push(...open);
  items.forEach((item, k) => {
    if (k) out.push('');
    out.push(...renderItem(item, depth));
  });
  out.push(...close);
  return out.join('\n') + '\n';
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
/** A CSS value for a statement: the numbers in it, so two different bodies give two different rules. */
const digits = (s) => (JSON.stringify(s).match(/\d+/g) ?? ['0']).join('');

// ---------------------------------------------------------------- the patterns (MATRIX.md describes each)
const both = (a, b) => [a, b];
/**
 * Each pattern returns the subject items of base, ours and theirs, the acceptable results (null: no single right
 * result), and optional import lists. `auto` patterns should be resolved automatically; the others must not be Merged.
 */
export const PATTERNS = {
  'add-function': {
    auto: true,
    langs: [...CODE, 'css'],
    what: 'Both sides add a different function (or method, or CSS rule) in the same spot.',
    make: () => ({
      base: [fn('alpha'), fn('omega')],
      ours: [fn('alpha'), fn('beta', stdBody('value + 2')), fn('omega')],
      theirs: [fn('alpha'), fn('gamma', stdBody('value + 3')), fn('omega')],
      accept: both(
        [fn('alpha'), fn('beta', stdBody('value + 2')), fn('gamma', stdBody('value + 3')), fn('omega')],
        [fn('alpha'), fn('gamma', stdBody('value + 3')), fn('beta', stdBody('value + 2')), fn('omega')]
      ),
    }),
  },
  'add-import': {
    auto: true,
    langs: CODE,
    position: false,
    what: 'Both sides add a different import at the end of the import block.',
    make: () => ({
      imports: {
        base: ['alpha', 'beta'],
        ours: ['alpha', 'beta', 'gamma'],
        theirs: ['alpha', 'beta', 'delta'],
        accept: both(['alpha', 'beta', 'gamma', 'delta'], ['alpha', 'beta', 'delta', 'gamma']),
      },
      base: [fn('alpha')],
      ours: [fn('alpha')],
      theirs: [fn('alpha')],
    }),
  },
  'add-enum-member': {
    auto: true,
    langs: ['ts', 'tsx', 'js', 'py', 'cs', 'go', 'rs', 'java', 'json', 'yaml'],
    what: 'Both sides add a different member at the end of the same enum.',
    make: () => {
      const e = (...m) => ({ t: 'enum', name: 'Color', members: [['RED', 1], ['GREEN', 2], ...m] });
      return {
        base: [e()],
        ours: [e(['BLUE', 3])],
        theirs: [e(['YELLOW', 4])],
        accept: both([e(['BLUE', 3], ['YELLOW', 4])], [e(['YELLOW', 4], ['BLUE', 3])]),
      };
    },
  },
  'add-object-key': {
    auto: true,
    langs: ['ts', 'tsx', 'js', 'py', 'json', 'yaml', 'css'],
    what: 'Both sides add a different key at the end of the same object literal (a declaration, in CSS).',
    make: () => {
      const o = (...e) => ({ t: 'obj', name: 'settings', entries: [['retries', 1], ['timeout', 2], ...e] });
      return {
        base: [o()],
        ours: [o(['verbose', 3])],
        theirs: [o(['color', 4])],
        accept: both([o(['verbose', 3], ['color', 4])], [o(['color', 4], ['verbose', 3])]),
      };
    },
  },
  'add-array-item': {
    auto: true,
    langs: ['ts', 'tsx', 'js', 'py', 'cs', 'go', 'rs', 'java', 'json', 'yaml'],
    what: 'Both sides append a different item to the same array literal.',
    make: () => {
      const l = (...v) => ({ t: 'list', name: 'names', values: ['alpha', 'beta', ...v] });
      return {
        base: [l()],
        ours: [l('gamma')],
        theirs: [l('delta')],
        accept: both([l('gamma', 'delta')], [l('delta', 'gamma')]),
      };
    },
  },
  'add-struct-field': {
    auto: true,
    langs: ['ts', 'tsx', 'py', 'cs', 'go', 'rs', 'java'],
    what: 'Both sides add a different field at the end of the same struct, class or interface.',
    make: () => {
      const s = (...f) => ({ t: 'struct', name: 'Options', fields: ['width', 'height', ...f] });
      return {
        base: [s()],
        ours: [s('depth')],
        theirs: [s('weight')],
        accept: both([s('depth', 'weight')], [s('weight', 'depth')]),
      };
    },
  },
  'add-match-arm': {
    auto: true,
    langs: ['ts', 'tsx', 'js', 'py', 'cs', 'go', 'rs', 'java'],
    what: 'Both sides add a different case to the same switch or match.',
    make: () => {
      const s = (...a) => ({ t: 'switch', name: 'code', arms: [[1, 10], [2, 20], ...a] });
      return {
        base: [s()],
        ours: [s([3, 30])],
        theirs: [s([4, 40])],
        accept: both([s([3, 30], [4, 40])], [s([4, 40], [3, 30])]),
      };
    },
  },
  'edit-adjacent-statements': {
    auto: true,
    langs: CODE,
    what: 'Both sides edit different, adjacent statements of one function.',
    make: () => ({
      base: [fn('alpha')],
      ours: [fn('alpha', stdBody('value + 10'))],
      theirs: [fn('alpha', stdBody('value + 1', 'total * 3'))],
      accept: [[fn('alpha', stdBody('value + 10', 'total * 3'))]],
    }),
  },
  'edit-signature-vs-body': {
    auto: true,
    langs: CODE,
    what: 'One side adds a parameter to a function; the other edits the first statement of its body.',
    make: () => {
      const sig = (body) => ({ ...fn('alpha', body), params: ['value', 'scale'] });
      return {
        base: [fn('alpha')],
        ours: [sig(stdBody())],
        theirs: [fn('alpha', stdBody('value + 10'))],
        accept: [[sig(stdBody('value + 10'))]],
      };
    },
  },
  'edit-doc-vs-body': {
    auto: true,
    langs: CODE,
    what: 'One side edits a function’s doc comment; the other edits its body.',
    make: () => {
      const d = (doc, body) => fn('alpha', body, { doc });
      return {
        base: [d('Computes a total.', stdBody())],
        ours: [d('Computes the scaled total.', stdBody())],
        theirs: [d('Computes a total.', stdBody('value + 10'))],
        accept: [[d('Computes the scaled total.', stdBody('value + 10'))]],
      };
    },
  },
  'move-vs-edit': {
    auto: true,
    langs: CODE,
    what: 'One side moves a function below its neighbours; the other edits the function.',
    make: () => ({
      base: [fn('alpha'), fn('beta'), fn('gamma')],
      ours: [fn('beta'), fn('gamma'), fn('alpha')],
      theirs: [fn('alpha', stdBody('value + 10')), fn('beta'), fn('gamma')],
      accept: [[fn('beta'), fn('gamma'), fn('alpha', stdBody('value + 10'))]],
    }),
  },
  'rename-vs-edit': {
    auto: true,
    langs: CODE,
    what: 'One side renames a function and its caller; the other edits the function’s first statement.',
    make: () => {
      const caller = (n) => fn('caller', [['ret', `${n}(value)`]]);
      return {
        base: [fn('alpha'), caller('alpha')],
        ours: [fn('alphaRenamed'), caller('alphaRenamed')],
        theirs: [fn('alpha', stdBody('value + 10')), caller('alpha')],
        accept: [[fn('alphaRenamed', stdBody('value + 10')), caller('alphaRenamed')]],
      };
    },
  },
  'reformat-vs-edit': {
    auto: true,
    langs: CODE,
    what: 'One side only reformats a call over several lines; the other changes one argument in it.',
    make: () => {
      const f = (multiline, last) =>
        fn('alpha', [
          ['let', 'total', 'value + 1'],
          ['ret', { call: 'combine', args: ['value', 'total', 'value * 2', last], multiline }],
        ]);
      return { base: [f(false, '4')], ours: [f(true, '4')], theirs: [f(false, '5')], accept: [[f(true, '5')]] };
    },
  },
  'reorder-vs-edit': {
    auto: true,
    langs: CODE,
    what: 'One side swaps two functions; the other edits one of them.',
    make: () => ({
      base: [fn('alpha'), fn('beta')],
      ours: [fn('beta'), fn('alpha')],
      theirs: [fn('alpha', stdBody('value + 10')), fn('beta')],
      accept: [[fn('beta'), fn('alpha', stdBody('value + 10'))]],
    }),
  },
  'identical-change': {
    auto: true,
    langs: [...CODE, 'json', 'yaml', 'css'],
    what: 'Both sides make the same change.',
    make: () => {
      const g = (a) =>
        constGroup([
          ['FIRST', a],
          ['SECOND', 2],
        ]);
      return { base: [g(1)], ours: [g(10)], theirs: [g(10)], accept: [[g(10)]] };
    },
  },
  'adjacent-lines': {
    auto: true,
    langs: [...CODE, 'json', 'yaml', 'css'],
    what: 'Each side edits a different one of two adjacent lines (constants, keys or declarations).',
    make: () => {
      const g = (a, b) =>
        constGroup([
          ['FIRST', a],
          ['SECOND', b],
          ['THIRD', 3],
        ]);
      return { base: [g(1, 2)], ours: [g(10, 2)], theirs: [g(1, 20)], accept: [[g(10, 20)]] };
    },
  },
  'blank-line-split': {
    auto: true,
    langs: [...CODE, 'json', 'yaml', 'css'],
    what: 'One side edits the line before a blank line; the other edits the line after it.',
    make: () => {
      const g = (b, c) => [
        constGroup([
          ['FIRST', 1],
          ['SECOND', b],
        ]),
        constGroup([
          ['THIRD', c],
          ['FOURTH', 4],
        ]),
      ];
      return { base: g(2, 3), ours: g(20, 3), theirs: g(2, 30), accept: [g(20, 30)] };
    },
  },
  // ---- must not be Merged
  'same-line-different': {
    auto: false,
    langs: CODE,
    what: 'Both sides change the same statement differently.',
    make: () => ({
      base: [fn('alpha')],
      ours: [fn('alpha', stdBody('value + 10'))],
      theirs: [fn('alpha', stdBody('value + 20'))],
    }),
  },
  'delete-vs-edit': {
    auto: false,
    langs: CODE,
    what: 'One side deletes a function; the other edits it.',
    make: () => ({
      base: [fn('alpha'), fn('beta')],
      ours: [fn('beta')],
      theirs: [fn('alpha', stdBody('value + 10')), fn('beta')],
    }),
  },
  'rename-vs-new-use': {
    auto: false,
    langs: CODE,
    what: 'One side renames a function; the other adds new code, next to it, that calls the old name.',
    make: () => ({
      base: [fn('alpha')],
      ours: [fn('alphaRenamed')],
      theirs: [fn('helper', [['ret', 'alpha(value) + 1']]), fn('alpha')],
    }),
  },
  'param-rename-vs-use': {
    auto: false,
    langs: CODE,
    what: 'One side renames a parameter; the other adds a statement that uses the old name.',
    make: () => {
      const renamed = { ...fn('alpha', stdBody('amount + 1')), params: ['amount'] };
      return { base: [fn('alpha')], ours: [renamed], theirs: [fn('alpha', [['if', 'value < 0', '0'], ...stdBody()])] };
    },
  },
  'same-constant-different': {
    auto: false,
    langs: [...CODE, 'json', 'yaml', 'css'],
    what: 'Both sides change the same constant to different values.',
    make: () => {
      const g = (a) =>
        constGroup([
          ['LIMIT', a],
          ['OTHER', 5],
        ]);
      return { base: [g(1)], ours: [g(10)], theirs: [g(20)] };
    },
  },
  'duplicate-definition': {
    auto: false,
    langs: [...CODE, 'css'],
    what: 'Both sides add a function with the same name and different bodies.',
    make: () => ({
      base: [fn('alpha'), fn('omega')],
      ours: [fn('alpha'), fn('beta', stdBody('value + 2')), fn('omega')],
      theirs: [fn('alpha'), fn('beta', stdBody('value + 3', 'total * 4')), fn('omega')],
    }),
  },
  'duplicate-member': {
    auto: false,
    langs: ['ts', 'tsx', 'js', 'py', 'cs', 'go', 'rs', 'java', 'json', 'yaml', 'css'],
    what: 'Both sides add an enum member or object key with the same name and different values.',
    make: (lang) => {
      if (['json', 'yaml', 'css', 'js', 'py'].includes(lang)) {
        const o = (...e) => ({ t: 'obj', name: 'settings', entries: [['retries', 1], ['timeout', 2], ...e] });
        return { base: [o()], ours: [o(['verbose', 3])], theirs: [o(['verbose', 4])] };
      }
      const e = (...m) => ({ t: 'enum', name: 'Color', members: [['RED', 1], ['GREEN', 2], ...m] });
      return { base: [e()], ours: [e(['BLUE', 3])], theirs: [e(['BLUE', 4])] };
    },
  },
};

// ---------------------------------------------------------------- variation and case assembly
/** mulberry32: small, seeded and stable across Node versions. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const AXES = {
  position: ['middle', 'top', 'end'],
  indent: ['4', '2', 'tab'],
  eol: ['lf', 'crlf'],
  nesting: ['top', 'class', 'nested'],
  size: ['small', 'large'],
};
const INDENT = { 2: '  ', 4: '    ', tab: '\t' };
const DEFAULT_INDENT = {
  ts: '2',
  tsx: '2',
  js: '2',
  json: '2',
  yaml: '2',
  css: '2',
  py: '4',
  cs: '4',
  java: '4',
  rs: '4',
  go: 'tab',
};
function filler(lang, k) {
  if (lang === 'json' || lang === 'yaml') return { t: 'const', name: `filler_${k}`, value: k };
  return fn(`filler${k}`, [['ret', `value + ${k}`]]);
}
/** Lines one filler item takes, roughly, to reach the large size. */
const FILLER_LINES = { json: 1, yaml: 1, css: 4, py: 3, go: 4, rs: 4, ts: 4, tsx: 4, js: 4, java: 4, cs: 5 };

function variantAxes(lang, pattern, k, rng) {
  // Variant 0 is the plain case; the others draw each axis at random.
  const pick = (name) =>
    k === 0
      ? name === 'indent'
        ? DEFAULT_INDENT[lang]
        : AXES[name][0]
      : AXES[name][Math.floor(rng() * AXES[name].length)];
  const axes = {
    position: pick('position'),
    indent: pick('indent'),
    eol: pick('eol'),
    nesting: pick('nesting'),
    size: k === 0 ? 'small' : pick('size'),
  };
  if (lang === 'yaml' && axes.indent === 'tab') axes.indent = '2';
  if (pattern.position === false) axes.position = 'middle';
  return axes;
}

function assemble(lang, patternName, axes) {
  const p = PATTERNS[patternName];
  const spec = p.make(lang);
  const count = axes.size === 'large' ? Math.ceil(2100 / FILLER_LINES[lang]) : 2;
  const fill = Array.from({ length: count }, (_, k) => filler(lang, k));
  const place = (subject) =>
    axes.position === 'top'
      ? [...subject, ...fill]
      : axes.position === 'end'
        ? [...fill, ...subject]
        : [...fill.slice(0, count / 2), ...subject, ...fill.slice(count / 2)];
  const opts = { ind: INDENT[axes.indent], nest: axes.nesting };
  const eol = (text) => (axes.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text);
  const file = (items, imports) => eol(render(lang, { items: place(items), imports }, opts));
  const im = spec.imports ?? {};
  const name = `lab/${patternName}.${EXT[lang]}`;
  const accept = (spec.accept ?? []).map((items, k) => file(items, im.accept?.[k] ?? im.base));
  if (!spec.accept && im.accept) for (const imports of im.accept) accept.push(file(spec.base, imports));
  return {
    path: name,
    base: file(spec.base, im.base),
    ours: file(spec.ours, im.ours),
    theirs: file(spec.theirs, im.theirs),
    accept: spec.accept || im.accept ? accept : [],
  };
}

/** The whole matrix as lab cases: every pattern × language × variant. `filter` keeps names that contain it. */
export function generateMatrix({ seed = 1, variants = 4, filter, patterns, languages } = {}) {
  const cases = [];
  for (const [patternName, p] of Object.entries(PATTERNS)) {
    if (patterns && !patterns.includes(patternName)) continue;
    for (const lang of p.langs) {
      if (languages && !languages.includes(lang)) continue;
      const rng = random(seed * 7919 + hash(`${patternName}:${lang}`));
      const seen = new Set();
      for (let k = 0; k < variants; k++) {
        const axes = variantAxes(lang, p, k, rng);
        const key = JSON.stringify(axes);
        if (seen.has(key)) continue;
        seen.add(key);
        const name = `gen-${patternName}-${lang}-${axes.position}-${axes.indent}-${axes.eol}-${axes.nesting}-${axes.size}`;
        if (filter && !name.includes(filter)) continue;
        const f = assemble(lang, patternName, axes);
        const b = (text) => new Map([[f.path, Buffer.from(text)]]);
        cases.push({
          name,
          meta: {
            description: p.what,
            language: LANGUAGE[lang],
            lang,
            category: p.auto ? 'matrix/auto' : 'matrix/must-not-merge',
            pattern: patternName,
            axes,
            expected: { [f.path]: p.auto ? 'auto' : 'any-but-merged' },
            acceptable: f.accept.length ? { [f.path]: f.accept } : undefined,
          },
          trees: { base: b(f.base), ours: b(f.ours), theirs: b(f.theirs) },
        });
      }
    }
  }
  return cases;
}
function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------- the confidence report
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
/** One case's outcome: auto (Merged or merged by Git) and whether it is correct, else Check or Decide. */
function outcome(result) {
  if (result.error) return { kind: 'error', tiers: ['error'], notes: [result.error] };
  const files = result.steps.flatMap((s) => s.files);
  const buckets = files.flatMap((f) => (f.clean ? ['clean'] : f.buckets));
  const fixed = files.flatMap((f) => (f.clean ? ['clean'] : (f.bucketsWithFixes ?? f.buckets)));
  const tiers = files.map((f) => f.tier).filter(Boolean);
  const notes = files.map((f) => f.note).filter(Boolean);
  const comparisons = files.map((f) => f.comparison).filter(Boolean);
  const kindOf = (bs) =>
    bs.includes('decide')
      ? 'decide'
      : bs.includes('check')
        ? 'check'
        : bs.every((b) => b === 'clean')
          ? 'clean'
          : 'merged';
  return {
    kind: kindOf(buckets),
    kindWithFixes: kindOf(fixed),
    tiers,
    notes,
    comparisons,
    fixNotes: files.map((f) => f.fixNote).filter(Boolean),
    wholeFile: files.some((f) => f.wholeFileProposal),
    wholeFileCorrect: files.some((f) => f.wholeFileProposal === 'correct'),
  };
}
const good = (comparisons) => comparisons.length > 0 && comparisons.every((c) => c !== 'differs');

export function matrixReport(results, cases) {
  const byName = new Map(cases.map((c) => [c.name, c]));
  const cells = new Map(); // pattern -> lang -> stats
  const langs = [...new Set(cases.map((c) => c.meta.lang))];
  const wrong = [];
  const tierCounts = new Map(); // pattern -> tier -> n
  const recoverable = new Map(); // pattern -> { decide, wholeFile, union }
  const stat = () => ({
    n: 0,
    merged: 0,
    clean: 0,
    correct: 0,
    wrong: 0,
    check: 0,
    decide: 0,
    error: 0,
    wrongFixed: 0,
    lostToFixes: 0,
    cleanWrong: 0,
    wholeFile: 0,
    wholeFileCorrect: 0,
  });
  const totals = { auto: stat(), must: stat() };
  for (const r of results) {
    const c = byName.get(r.name);
    const { pattern, lang } = c.meta;
    const auto = PATTERNS[pattern].auto;
    const o = outcome(r);
    const s =
      (cells.get(pattern) ?? cells.set(pattern, new Map()).get(pattern)).get(lang) ??
      cells.get(pattern).set(lang, stat()).get(lang);
    for (const t of [s, auto ? totals.auto : totals.must]) {
      t.n++;
      if (o.kind === 'error') t.error++;
      else if (o.kind === 'check') {
        t.check++;
        if (o.wholeFile) t.wholeFile++;
        if (o.wholeFileCorrect) t.wholeFileCorrect++;
      } else if (o.kind === 'decide') t.decide++;
      else if (o.kind === 'clean') {
        t.clean++;
        if (auto && good(o.comparisons)) t.correct++;
        if (auto && !good(o.comparisons)) t.cleanWrong++;
      } else {
        t.merged++;
        const isWrong = !auto || !good(o.comparisons);
        if (isWrong) t.wrong++;
        else t.correct++;
        if (isWrong && o.kindWithFixes === 'merged') t.wrongFixed++;
        if (!isWrong && o.kindWithFixes !== 'merged') t.lostToFixes++;
      }
    }
    if (o.kind === 'merged' && (!auto || !good(o.comparisons)))
      wrong.push({
        name: r.name,
        pattern,
        lang,
        axes: c.meta.axes,
        comparisons: o.comparisons,
        fixed: o.kindWithFixes,
        fixNotes: o.fixNotes,
        text: r.steps[0]?.files[0]?.mergedText,
      });
    if (auto && o.kind === 'decide') {
      const files = r.steps.flatMap((x) => x.files);
      const ok = (k) => files.some((f) => f[k] && f[k] !== 'differs');
      const m =
        recoverable.get(pattern) ?? recoverable.set(pattern, { decide: 0, wholeFile: 0, union: 0 }).get(pattern);
      m.decide++;
      if (ok('wholeFileComparison')) m.wholeFile++;
      else if (ok('unionComparison')) m.union++;
    }
    if (auto && (o.kind === 'check' || o.kind === 'decide' || o.kind === 'error')) {
      const m = tierCounts.get(pattern) ?? tierCounts.set(pattern, new Map()).get(pattern);
      const key = o.kind === 'check' ? `verify: ${o.notes[0] ?? ''}` : (o.tiers[0] ?? o.kind);
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  const a = totals.auto;
  const conflicting = a.n - a.clean;
  const headline =
    `Of ${conflicting} generated conflicts we should handle automatically, ${pct(a.correct - (a.clean - a.cleanWrong), conflicting)} are Merged and correct, ` +
    `${pct(a.check, conflicting)} go to Check, ${pct(a.decide, conflicting)} go to Decide, and ${pct(a.wrong, conflicting)} are wrongly Merged (must be 0). ` +
    `Git merged ${a.clean} more on its own. Of ${totals.must.n} cases that must not be Merged, ${totals.must.wrong} were Merged. ` +
    `${a.wholeFile + totals.must.wholeFile} cases are whole-file proposals in Check; ${a.wholeFileCorrect + totals.must.wholeFileCorrect} of them are correct.`;
  const out = ['# Conflict lab: permutation matrix', '', headline, ''];
  out.push(
    `Cases: ${results.length} (${cases.length} generated). Cell: Merged-or-Git% / correct% / wrong-Merged% (n). Must-not patterns: correct% is "not Merged".`,
    ''
  );
  const head = ['pattern', ...langs];
  const rows = [];
  for (const [pattern, p] of Object.entries(PATTERNS)) {
    if (!cells.has(pattern)) continue;
    rows.push([
      `${p.auto ? '' : '(must not) '}${pattern}`,
      ...langs.map((l) => {
        const s = cells.get(pattern).get(l);
        if (!s) return '';
        if (!p.auto) return `${pct(s.merged, s.n)} / ${pct(s.n - s.merged, s.n)} / ${pct(s.wrong, s.n)} (${s.n})`;
        return `${pct(s.merged + s.clean, s.n)} / ${pct(s.correct, s.n)} / ${pct(s.wrong, s.n)} (${s.n})`;
      }),
    ]);
  }
  out.push(
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    ''
  );
  out.push('## Where each pattern ended up (all languages)', '');
  out.push(
    '| pattern | n | Merged | Git merged | correct | Check | Decide | wrong Merged | wrong with proposed checks | correct lost to proposed checks | whole-file proposals (correct) |',
    '|---|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const [pattern, p] of Object.entries(PATTERNS)) {
    if (!cells.has(pattern)) continue;
    const s = [...cells.get(pattern).values()].reduce(
      (x, y) => Object.fromEntries(Object.keys(x).map((k) => [k, x[k] + y[k]])),
      stat()
    );
    out.push(
      `| ${p.auto ? '' : '(must not) '}${pattern} | ${s.n} | ${s.merged} | ${s.clean} | ${p.auto ? s.correct : s.n - s.merged} | ${s.check} | ${s.decide} | ${s.wrong} | ${s.wrongFixed} | ${s.lostToFixes} | ${s.wholeFile} (${s.wholeFileCorrect}) |`
    );
  }
  out.push(
    '',
    '## Decide cases where a correct proposal was possible',
    '',
    'Whole file: Mergiraf resolved the whole file correctly, but its result changed lines outside the conflict blocks, so #444 kept no proposal. Union: each side only added lines in the block, and both sides together are the expected result.',
    '',
    '| pattern | Decide | Mergiraf whole file correct | union of both sides correct |',
    '|---|---|---|---|'
  );
  for (const [pattern, m] of recoverable) out.push(`| ${pattern} | ${m.decide} | ${m.wholeFile} | ${m.union} |`);
  out.push('', '## What stops the automatic patterns', '');
  for (const [pattern, m] of tierCounts)
    out.push(
      `- ${pattern}: ${[...m]
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${k} (${v})`)
        .join('; ')}`
    );
  const cosmetic = results.filter((r) => r.steps.some((s) => s.files.some((f) => f.comparison === 'cosmetic')));
  out.push(
    '',
    `## Merged and correct, but with broken layout: ${cosmetic.length}`,
    '',
    'The code is the same as the expected result once whitespace and empty `;` statements are ignored.',
    ''
  );
  for (const r of cosmetic) out.push(`- ${r.name}`);
  out.push('', `## Wrongly Merged: ${wrong.length}`, '');
  for (const w of wrong)
    out.push(
      `### ${w.name}`,
      '',
      `Pattern ${w.pattern}, ${w.lang}, ${JSON.stringify(w.axes)}. Comparison: ${w.comparisons.join(', ') || 'none (must not be Merged)'}. With the proposed checks: ${w.fixed}${w.fixNotes.length ? ` (${w.fixNotes.join(' ')})` : ''}.`,
      '',
      '```',
      (w.text ?? '').slice(0, 1500),
      '```',
      ''
    );
  return { text: out.join('\n'), headline, wrong, totals };
}

// ---------------------------------------------------------------- CLI
async function main() {
  const args = process.argv.slice(2);
  const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  if (args.includes('--list')) {
    for (const [name, p] of Object.entries(PATTERNS))
      console.log(`${p.auto ? 'auto ' : 'must-not'} ${name.padEnd(26)} ${p.langs.join(',')}  ${p.what}`);
    console.log(
      `${generateMatrix({ variants: Number(value('--variants') ?? 4) }).length} cases at --variants ${value('--variants') ?? 4}`
    );
    return;
  }
  const dir = value('--write-sample');
  if (dir) {
    const names = (value('--names') ?? '').split(',').filter(Boolean);
    const cases = generateMatrix({ variants: 1 }).filter(
      (c) => !names.length || names.some((n) => c.name.startsWith(n))
    );
    for (const c of cases) {
      const root = path.join(dir, c.name);
      for (const [tree, files] of Object.entries(c.trees))
        for (const [p, data] of files) {
          await fs.mkdir(path.dirname(path.join(root, tree, p)), { recursive: true });
          await fs.writeFile(path.join(root, tree, p), data);
        }
      const accept = c.meta.acceptable?.[[...c.trees.base.keys()][0]];
      if (accept?.length) {
        const p = [...c.trees.base.keys()][0];
        await fs.mkdir(path.dirname(path.join(root, 'resolved', p)), { recursive: true });
        await fs.writeFile(path.join(root, 'resolved', p), accept[0]);
      }
      const meta = { ...c.meta };
      delete meta.acceptable;
      delete meta.lang;
      meta.category = `${meta.category} (generated sample)`;
      if (accept && accept.length > 1) meta.acceptable = { [[...c.trees.base.keys()][0]]: accept.slice(1) };
      await fs.writeFile(path.join(root, 'case.json'), JSON.stringify(meta, null, 2) + '\n');
    }
    console.log(`${cases.length} sample cases written to ${dir}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
