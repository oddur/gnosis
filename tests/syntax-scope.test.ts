import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import {
  OPEN_BY_DEFAULT_LINES,
  WHOLE_DEFINITION_LINES,
  createSyntaxEngine,
  definitionChain,
  definitionPatterns,
  definitionReveal,
  enclosingDefinition,
  enclosingPoint,
  opensByDefault,
  syntaxLanguage,
  type SyntaxDefinition,
  type SyntaxLanguage,
} from '../lib/syntax-scope';
import { diffGaps, pinLines, revealSpan, revealedParts, shownLines, withPins, type GapHunk } from '../lib/diff-gaps';
import {
  hunkHeaderText,
  hunkScopes,
  oldToNew,
  patchHeaders,
  provisionalScopes,
  revealLabel,
  spokenChain,
  visibleCrumbs,
} from '../lib/hunk-scopes';
import { perfBudget } from './perf-budget';
import { largeAfter, lazyHandler, patchOf, scopeAfter, scopeBefore, storeAfter, storeBefore } from './fixtures/syntax-scope';

/**
 * Enclosing definitions with the real tree-sitter runtime and the grammars Gnosis bundles (#393), and the rules that
 * turn them into hunk headers and reveals.
 */
const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});
const definitions = async (language: SyntaxLanguage, source: string) =>
  (await engine.definitions(language, source)).definitions;
/** The label of the scope around lines `start`–`end`. */
const scopeOf = (list: SyntaxDefinition[], start: number, end = start) => enclosingDefinition(list, start, end)?.label;
const defined = <T>(value: T | undefined, what = 'value'): T => {
  assert.ok(value !== undefined, `Missing ${what}`);
  return value;
};
const lineOf = (lines: string[], text: string) => {
  const index = lines.indexOf(text);
  assert.ok(index >= 0, `Missing line: ${text}`);
  return index + 1;
};

const TS = `import x from 'y';
export function resolvePaths(a: string): string[] {
  const out = [a];
  return out;
}
export const add = (a: number, b: number) =>
  a + b;
export class StoreBridge<T> extends Base {
  private count = 0;
  save(value: T): void {
    const next = () => {
      this.count++;
    };
    next();
  }
  handler = () => {
    return 1;
  };
}
interface Shape {
  area(): number;
  name: string;
}
enum Color { Red, Green }
namespace Tools { export function inner() { return 1; } }
describe('parser', () => {
  beforeEach(() => {});
  it('parses paths', () => {
    expect(1).toBe(1);
  });
  test.only(\`template\`, async () => {
    await 1;
  });
});
`;
const RUST = `use std::fmt;
pub struct Store {
    a: u32,
}
impl Store {
    pub const LIMIT: u32 = 3;
    pub fn new() -> Self {
        Store { a: 0 }
    }
}
impl fmt::Display for Store {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        Ok(())
    }
}
pub trait Bridge {
    fn send(&self);
    fn flush(&self) {
        self.send();
    }
}
pub enum Event {
    Saved,
}
fn top() {
    let x = 1;
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_store() {
        assert_eq!(1, 1);
    }
}
`;
const ts = TS.split('\n'),
  rust = RUST.split('\n');

void test('TypeScript scopes: functions, arrow consts, classes, methods, nested and test calls', async () => {
  const list = await definitions('typescript', TS);
  assert.equal(scopeOf(list, lineOf(ts, '  const out = [a];')), 'resolvePaths()');
  assert.equal(scopeOf(list, lineOf(ts, '  a + b;')), 'add()');
  // A const arrow function covers its `export const` line.
  assert.deepEqual(
    list.filter((d) => d.label === 'add()').map((d) => [d.start, d.end, d.kind]),
    [[lineOf(ts, 'export const add = (a: number, b: number) =>'), lineOf(ts, '  a + b;'), 'function']]
  );
  assert.equal(scopeOf(list, lineOf(ts, '  private count = 0;')), 'class StoreBridge');
  assert.equal(scopeOf(list, lineOf(ts, '    next();')), 'StoreBridge.save()');
  // A const arrow function nested in a method is the smallest definition around its body.
  assert.equal(scopeOf(list, lineOf(ts, '      this.count++;')), 'next()');
  assert.equal(scopeOf(list, lineOf(ts, '    return 1;')), 'StoreBridge.handler()');
  assert.equal(scopeOf(list, lineOf(ts, '  name: string;')), 'interface Shape');
  assert.equal(scopeOf(list, lineOf(ts, '    expect(1).toBe(1);')), 'it("parses paths")');
  assert.equal(scopeOf(list, lineOf(ts, '  beforeEach(() => {});')), 'describe("parser")');
  assert.equal(scopeOf(list, lineOf(ts, '    await 1;')), 'test.only("template")');
  assert.equal(scopeOf(list, lineOf(ts, "import x from 'y';")), undefined, 'Top-level lines have no scope');
  const kinds = Object.fromEntries(list.map((d) => [d.label, d.kind]));
  assert.equal(kinds['enum Color'], 'enum');
  assert.equal(kinds['namespace Tools'], 'module');
  assert.equal(kinds['it("parses paths")'], 'test');
  // The signature ends where the body opens.
  const save = list.find((d) => d.label === 'StoreBridge.save()');
  assert.deepEqual(
    [save?.start, save?.signatureEnd],
    [lineOf(ts, '  save(value: T): void {'), lineOf(ts, '  save(value: T): void {')]
  );
});

void test('TSX and JavaScript use the same patterns', async () => {
  const tsx = await definitions('tsx', `export function Panel() {\n  return <div>{1}</div>;\n}\n`);
  assert.equal(scopeOf(tsx, 2), 'Panel()');
  const js = await definitions(
    'javascript',
    `class A {\n  run() {\n    return 1;\n  }\n  field = () => {\n    return 2;\n  };\n}\nit('works', () => {\n  run();\n});\n`
  );
  assert.equal(scopeOf(js, 3), 'A.run()');
  assert.equal(scopeOf(js, 6), 'A.field()');
  assert.equal(scopeOf(js, 10), 'it("works")');
});

void test('Rust scopes: functions, impl blocks and their methods, traits and #[test] functions', async () => {
  const list = await definitions('rust', RUST);
  assert.equal(scopeOf(list, lineOf(rust, '        Store { a: 0 }')), 'Store.new()');
  assert.equal(scopeOf(list, lineOf(rust, '    pub const LIMIT: u32 = 3;')), 'impl Store');
  assert.equal(scopeOf(list, lineOf(rust, '        Ok(())')), 'Store.fmt()');
  const display = list.find((d) => d.kind === 'impl' && d.label.includes('Display'));
  assert.equal(display?.label, 'impl fmt::Display for Store');
  assert.equal(scopeOf(list, lineOf(rust, '    fn send(&self);')), 'trait Bridge');
  assert.equal(scopeOf(list, lineOf(rust, '        self.send();')), 'Bridge.flush()');
  assert.equal(scopeOf(list, lineOf(rust, '    a: u32,')), 'struct Store');
  assert.equal(scopeOf(list, lineOf(rust, '    Saved,')), 'enum Event');
  assert.equal(scopeOf(list, lineOf(rust, '    let x = 1;')), 'top()');
  assert.equal(scopeOf(list, lineOf(rust, '        assert_eq!(1, 1);')), 'test creates_store()');
  // The attribute is part of the test function, and the module's attribute part of the module.
  const testFn = defined(list.find((d) => d.kind === 'test'));
  assert.equal(testFn.start, lineOf(rust, '    #[test]'));
  assert.equal(testFn.signatureEnd, lineOf(rust, '    fn creates_store() {'));
  assert.equal(list.find((d) => d.label === 'mod tests')?.start, lineOf(rust, '#[cfg(test)]'));
  assert.equal(scopeOf(list, lineOf(rust, '    use super::*;')), 'mod tests');
});

void test('Go, Python, Java, JSON and YAML find their definitions', async () => {
  const go = await definitions(
    'go',
    'package x\n\ntype Store struct {\n\ta int\n}\n\nfunc (s *Store) Save() {\n\ts.a++\n}\n\nfunc TestSave(t *testing.T) {\n\tt.Log()\n}\n'
  );
  assert.deepEqual(
    [scopeOf(go, 4), scopeOf(go, 8), scopeOf(go, 12)],
    ['struct Store', 'Store.Save()', 'test TestSave()']
  );
  const python = await definitions(
    'python',
    'class Store:\n    @property\n    def size(self):\n        return 1\n\ndef test_size():\n    assert Store().size == 1\n'
  );
  assert.deepEqual([scopeOf(python, 4), scopeOf(python, 7)], ['Store.size()', 'test test_size()']);
  assert.equal(python.find((d) => d.label === 'Store.size()')?.start, 2, 'Decorators belong to the definition');
  const java = await definitions('java', 'class Store {\n  void save() {\n    count++;\n  }\n}\n');
  assert.equal(scopeOf(java, 3), 'Store.save()');
  const json = await definitions('json', '{\n  "scripts": {\n    "test": "x"\n  }\n}\n');
  assert.equal(scopeOf(json, 3), '"scripts"');
  const yaml = await definitions('yaml', 'jobs:\n  build:\n    runs-on: x\n    steps: []\n');
  assert.equal(scopeOf(yaml, 4), 'build:');
});

const UNITY = `using UnityEngine;

namespace Klang.Seed.World
{
    [RequireComponent(typeof(Rigidbody))]
    public class Navmesh : MonoBehaviour
    {
        [SerializeField] private float speed = 2f;

        public float Height
        {
            get { return transform.position.y; }
        }

        public Navmesh()
        {
            speed = 1f;
        }

        private void Update()
        {
            float Step(float s)
            {
                return s * Time.deltaTime;
            }
            transform.Translate(0, Step(speed), 0);
        }

        public struct Cell
        {
            public int X;
        }

        public record struct Edge(int From, int To);

        public enum Layer
        {
            Ground,
            Water,
        }
    }

    public interface IWalkable
    {
        bool CanWalk(Vector3 at);
    }
}
`;
const FILE_SCOPED = `namespace Klang.Seed.Tests;

public class NavmeshTests
{
    [Test]
    public void FindsAPath()
    {
        Assert.IsTrue(true);
    }

    [UnityTest]
    public IEnumerator Settles()
    {
        yield return null;
    }
}
`;

void test('C# scopes: namespaces, classes, structs, records, enums, members and Unity tests', async () => {
  const unity = UNITY.split('\n');
  const list = await definitions('csharp', UNITY);
  const at = (text: string) => lineOf(unity, text);
  assert.equal(scopeOf(list, at('            get { return transform.position.y; }')), 'Navmesh.Height');
  assert.equal(scopeOf(list, at('            speed = 1f;')), 'Navmesh.Navmesh()');
  assert.equal(scopeOf(list, at('            transform.Translate(0, Step(speed), 0);')), 'Navmesh.Update()');
  assert.equal(scopeOf(list, at('                return s * Time.deltaTime;')), 'Step()');
  assert.equal(scopeOf(list, at('            public int X;')), 'struct Cell');
  assert.equal(scopeOf(list, at('            Water,')), 'enum Layer');
  assert.equal(list.find((d) => d.name === 'CanWalk')?.label, 'IWalkable.CanWalk()');
  assert.equal(scopeOf(list, at('        [SerializeField] private float speed = 2f;')), 'class Navmesh');
  // The attribute belongs to the class.
  assert.equal(list.find((d) => d.label === 'class Navmesh')?.start, at('    [RequireComponent(typeof(Rigidbody))]'));
  assert.deepEqual(chainOf(list, at('            transform.Translate(0, Step(speed), 0);')), [
    'namespace Klang.Seed.World',
    'class Navmesh',
    'Update()',
  ]);
  assert.equal(list.find((d) => d.name === 'Edge')?.crumb, 'record struct Edge');
  assert.deepEqual(chainOf(list, at('            get { return transform.position.y; }')).at(-1), 'Height');

  const tests = FILE_SCOPED.split('\n');
  const scoped = await definitions('csharp', FILE_SCOPED);
  assert.equal(scopeOf(scoped, lineOf(tests, '        Assert.IsTrue(true);')), 'test FindsAPath()');
  assert.equal(scopeOf(scoped, lineOf(tests, '        yield return null;')), 'test Settles()');
  assert.deepEqual(chainOf(scoped, lineOf(tests, '        yield return null;')), [
    'namespace Klang.Seed.Tests',
    'class NavmeshTests',
    'Settles()',
  ]);
  assert.equal(syntaxLanguage('Assets/Scripts/Navmesh.cs'), 'csharp');
});

/** The breadcrumb of the scope around lines `start`–`end`, outermost first. */
const chainOf = (list: SyntaxDefinition[], start: number, end = start) => {
  const inner = enclosingDefinition(list, start, end);
  return inner ? definitionChain(list, inner).map((d) => d.crumb) : [];
};

void test('Breadcrumbs in Rust: mod › impl › fn, and impl Trait for T', async () => {
  const source = `mod api {
    pub struct GameplayClient;
    impl GameplayClient {
        pub fn list_badge_grants(&self) -> u32 {
            let grants = 1;
            grants
        }
    }
    impl fmt::Display for GameplayClient {
        fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
            Ok(())
        }
    }
    pub trait Bridge {
        fn send(&self);
    }
    macro_rules! twice {
        ($e:expr) => { $e * 2 };
    }
}
`;
  const lines = source.split('\n');
  const list = await definitions('rust', source);
  assert.deepEqual(chainOf(list, lineOf(lines, '            let grants = 1;')), [
    'mod api',
    'impl GameplayClient',
    'fn list_badge_grants',
  ]);
  assert.deepEqual(chainOf(list, lineOf(lines, '            Ok(())')), ['mod api', 'impl fmt::Display for GameplayClient', 'fn fmt']);
  assert.deepEqual(chainOf(list, lineOf(lines, '        fn send(&self);')), ['mod api', 'trait Bridge']);
  assert.deepEqual(chainOf(list, lineOf(lines, '        ($e:expr) => { $e * 2 };')), ['mod api', 'macro_rules! twice']);
  // The #[test] function of the fixture above is an `fn` crumb inside its module.
  const fixture = await definitions('rust', RUST);
  assert.deepEqual(chainOf(fixture, lineOf(rust, '        assert_eq!(1, 1);')), ['mod tests', 'fn creates_store']);
  assert.deepEqual(chainOf(fixture, lineOf(rust, '    let x = 1;')), ['fn top']);
  // The browser suite's lazy handlers.
  const [, handlerAfter] = lazyHandler(3);
  const handler = await definitions('rust', `${handlerAfter.join('\n')}\n`);
  assert.deepEqual(chainOf(handler, lineOf(handlerAfter, '            total += 30 * 2;')), [
    'mod api',
    'impl Client3',
    'fn handler_3',
  ]);
});

void test('Breadcrumbs in TypeScript: class › method, nested arrow consts, describe › it', async () => {
  const list = await definitions('typescript', TS);
  assert.deepEqual(chainOf(list, lineOf(ts, '      this.count++;')), ['class StoreBridge', 'save()', 'next()']);
  assert.deepEqual(chainOf(list, lineOf(ts, '    return 1;')), ['class StoreBridge', 'handler()']);
  assert.deepEqual(chainOf(list, lineOf(ts, '  const out = [a];')), ['function resolvePaths()']);
  assert.deepEqual(chainOf(list, lineOf(ts, '  a + b;')), ['add()']);
  assert.deepEqual(chainOf(list, lineOf(ts, '    expect(1).toBe(1);')), ['describe "parser"', 'it "parses paths"']);
  assert.deepEqual(chainOf(list, lineOf(ts, '    await 1;')), ['describe "parser"', 'test.only "template"']);
  assert.deepEqual(chainOf(list, lineOf(ts, '  name: string;')), ['interface Shape']);
  const nested = await definitions(
    'typescript',
    'namespace Tools {\n  export class Panel {\n    open() {\n      const step = () => {\n        return 1;\n      };\n    }\n  }\n}\n'
  );
  assert.deepEqual(chainOf(nested, 5), ['namespace Tools', 'class Panel', 'open()', 'step()']);
});

void test('Breadcrumbs in Go and Python', async () => {
  const go = await definitions(
    'go',
    'package x\n\ntype Store struct {\n\ta int\n}\n\nfunc (s *Store) Save() {\n\ts.a++\n}\n\nfunc Load() {\n\treturn\n}\n'
  );
  assert.deepEqual(chainOf(go, 8), ['func (s *Store) Save']);
  assert.deepEqual(chainOf(go, 12), ['func Load']);
  assert.deepEqual(chainOf(go, 4), ['type Store']);
  const python = await definitions(
    'python',
    'class Store:\n    @property\n    def size(self):\n        def inner():\n            return 1\n        return inner()\n'
  );
  assert.deepEqual(chainOf(python, 5), ['class Store', 'def size', 'def inner']);
  assert.deepEqual(chainOf(python, 6), ['class Store', 'def size']);
});

void test('A long breadcrumb keeps the innermost two crumbs; the whole chain is its label', () => {
  const at = (kind: SyntaxDefinition['kind'], name: string, crumb: string, start: number, end: number): SyntaxDefinition => ({
    kind,
    name,
    label: crumb,
    crumb,
    start,
    end,
    signatureEnd: start,
  });
  const list = [
    at('module', 'api', 'mod api', 1, 100),
    at('module', 'v2', 'mod v2', 2, 90),
    at('impl', 'GameplayClient', 'impl GameplayClient', 3, 80),
    at('method', 'list_badge_grants', 'fn list_badge_grants', 10, 20),
    // The same lines as the impl add nothing.
    at('impl', 'GameplayClient', 'impl GameplayClient', 3, 80),
  ];
  const chain = definitionChain(list, list[3]);
  assert.deepEqual(chain.map((d) => d.crumb), ['mod api', 'mod v2', 'impl GameplayClient', 'fn list_badge_grants']);
  const crumbs = chain.map((definition) => ({ definition }));
  assert.deepEqual(
    visibleCrumbs(crumbs).map((crumb) => (crumb === 'more' ? '…' : crumb.definition.crumb)),
    ['…', 'impl GameplayClient', 'fn list_badge_grants']
  );
  assert.deepEqual(visibleCrumbs(crumbs.slice(2)).length, 2, 'Two crumbs show whole');
  assert.equal(
    spokenChain('build_api_routes.rs', crumbs.slice(2)),
    'In build_api_routes.rs, impl GameplayClient, function list_badge_grants'
  );
});

void test('Tag queries keep only their definition patterns', () => {
  const source =
    '; a comment (with parens)\n(call_expression function: (identifier) @name) @reference.call\n\n(function_item name: (identifier) @name) @definition.function\n(a (#match? @x "^(\\\\)\\")$")) @definition.class\n';
  assert.equal(
    definitionPatterns(source),
    '(function_item name: (identifier) @name) @definition.function\n\n(a (#match? @x "^(\\\\)\\")$")) @definition.class'
  );
});

void test('Unsupported languages and broken source fall back', async () => {
  assert.equal(syntaxLanguage('lib/notes.rb'), undefined);
  assert.equal(syntaxLanguage('Makefile'), undefined);
  assert.equal(syntaxLanguage('src/a.d.ts'), 'typescript');
  assert.equal(syntaxLanguage('src/App.TSX'), 'tsx');
  assert.equal(syntaxLanguage('Cargo.lock'), undefined);
  // Tree-sitter recovers from syntax errors: the definitions it can still see remain.
  const broken = await definitions('typescript', 'function ok() {\n  return 1;\n}\nfunction broken( {\n');
  assert.equal(scopeOf(broken, 2), 'ok()');
  // A hunk with no new-side definitions has no scope.
  const hunks: GapHunk[] = [
    {
      oldStart: 5,
      newStart: 5,
      rows: [
        { type: '-', text: 'a' },
        { type: '+', text: 'b' },
      ],
      noEofOld: false,
      noEofNew: false,
    },
  ];
  const gaps = defined(diffGaps(hunks, 10));
  const parts = revealedParts(
    hunks,
    gaps,
    {},
    Array.from({ length: 10 }, (_, i) => `${i}`)
  );
  assert.equal(hunkScopes(parts, gaps, {}, shownLines(parts).after).size, 0);
});

void test('A definition the change covers whole is the change, not its scope', () => {
  const list: SyntaxDefinition[] = [
    { kind: 'class', name: 'A', label: 'class A', crumb: 'class A', start: 1, end: 30, signatureEnd: 1 },
    { kind: 'method', name: 'm', label: 'A.m()', crumb: 'm()', start: 10, end: 14, signatureEnd: 10 },
  ];
  assert.equal(enclosingDefinition(list, 10, 14)?.label, 'class A');
  assert.equal(enclosingDefinition(list, 11, 12)?.label, 'A.m()');
  assert.equal(enclosingDefinition(list, 9, 15)?.label, 'class A');
  assert.equal(enclosingDefinition(list, 31, 31), undefined);
  // Deleted lines sit between two new lines; their scope holds both.
  assert.equal(enclosingPoint(list, 12)?.label, 'A.m()');
  assert.equal(enclosingPoint(list, 10)?.label, 'class A');
});

void test('The cap: whole up to 150 lines, the signature beyond', () => {
  const at = (lines: number, signature = 1): SyntaxDefinition => ({
    kind: 'function',
    name: 'f',
    label: 'f()',
    crumb: 'f()',
    start: 100,
    end: 99 + lines,
    signatureEnd: 99 + signature,
  });
  assert.deepEqual(definitionReveal(at(WHOLE_DEFINITION_LINES)), { kind: 'whole', start: 100, end: 249 });
  assert.deepEqual(definitionReveal(at(WHOLE_DEFINITION_LINES + 1)), { kind: 'signature', start: 100, end: 100 });
  assert.deepEqual(definitionReveal(at(400, 3)), { kind: 'signature', start: 100, end: 102 });
  // A signature longer than ten lines shows its first ten.
  assert.deepEqual(definitionReveal(at(400, 30)), { kind: 'signature', start: 100, end: 109 });
});

void test('The default-open rule: up to 40 lines', () => {
  assert.equal(OPEN_BY_DEFAULT_LINES, 40);
  assert.equal(opensByDefault({ start: 1, end: 40 }), true);
  assert.equal(opensByDefault({ start: 1, end: 41 }), false);
});

/** The hunks of a patch between two versions, as the gap model reads them. */
function hunksOf(beforeLines: string[], afterLines: string[]): GapHunk[] {
  const patch = structuredPatch('a', 'b', `${beforeLines.join('\n')}\n`, `${afterLines.join('\n')}\n`, '', '', {
    context: 3,
  });
  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    rows: hunk.lines.map((line) => ({ type: line[0] as ' ' | '+' | '-', text: line.slice(1) })),
    noEofOld: false,
    noEofNew: false,
  }));
}

void test('Hunk scopes in a TypeScript file: default open, Show whole function, and the signature past the cap', async () => {
  const after = await definitions('typescript', `${scopeAfter.join('\n')}\n`);
  const hunks = hunksOf(scopeBefore, scopeAfter);
  assert.equal(hunks.length, 4);
  const gaps = defined(diffGaps(hunks, scopeAfter.length));
  let reveals = {};
  let parts = revealedParts(hunks, gaps, reveals, scopeAfter);
  let scopes = hunkScopes(parts, gaps, { after }, shownLines(parts).after);
  const byKey = (key: string) => defined(scopes.get(key), key);
  assert.deepEqual(
    [...scopes.values()].map((s) => s.definition.label),
    ['resolvePaths()', 'StoreBridge.flush()', 'migrate()', 'it("joins names")']
  );
  assert.deepEqual(
    [...scopes.values()].map((s) => s.opens),
    [true, false, false, true]
  );
  assert.equal(revealLabel(byKey('h1')), 'Show whole function');
  assert.deepEqual(
    [...scopes.values()].map((s) => s.chain.map((crumb) => crumb.definition.crumb)),
    [['function resolvePaths()'], ['class StoreBridge', 'flush()'], ['function migrate()'], ['describe "resolvePaths"', 'it "joins names"']]
  );
  assert.equal(byKey('h2').reveal?.kind, 'signature');
  assert.equal(revealLabel(byKey('h2')), 'Show function signature');
  // Opening the short ones by default reveals each definition and nothing else.
  for (const scope of scopes.values())
    if (scope.opens && scope.reveal) reveals = revealSpan(reveals, gaps, scope.reveal.start, scope.reveal.end);
  parts = revealedParts(hunks, gaps, reveals, scopeAfter);
  let shown = shownLines(parts).after;
  const resolve = byKey('h0').definition;
  for (let line = resolve.start; line <= resolve.end; line++)
    assert.ok(shown.has(line), `resolvePaths line ${line} shows`);
  assert.ok(!shown.has(resolve.start - 1), 'The line above resolvePaths stays hidden');
  scopes = hunkScopes(parts, gaps, { after }, shown);
  assert.equal(byKey('h0').reveal, undefined, 'Nothing left to show');
  // Show whole function on the method.
  const flush = byKey('h1');
  const flushReveal = defined(flush.reveal);
  reveals = revealSpan(reveals, gaps, flushReveal.start, flushReveal.end);
  parts = revealedParts(hunks, gaps, reveals, scopeAfter);
  shown = shownLines(parts).after;
  for (let line = flush.definition.start; line <= flush.definition.end; line++) assert.ok(shown.has(line));
  assert.ok(!shown.has(flush.definition.start - 1) && !shown.has(flush.definition.end + 1));
  // Past the cap: the signature shows above the hunk, and the lines between stay hidden.
  const migrate = byKey('h2');
  const migrateReveal = defined(migrate.reveal);
  const pinned = pinLines(hunks, gaps, reveals, migrateReveal.start, migrateReveal.end);
  assert.deepEqual(pinned.pin, [migrate.definition.start, migrate.definition.start]);
  const withPin = withPins(hunks, [defined(pinned.pin)], scopeAfter);
  const pinGaps = defined(diffGaps(withPin, scopeAfter.length));
  parts = revealedParts(withPin, pinGaps, pinned.reveals, scopeAfter);
  shown = shownLines(parts).after;
  assert.ok(shown.has(migrate.definition.start), 'The signature shows');
  assert.ok(!shown.has(migrate.definition.start + 1), 'The body above the hunk stays hidden');
  // The earlier reveals moved with their gaps: the method is still whole.
  for (let line = flush.definition.start; line <= flush.definition.end; line++) assert.ok(shown.has(line));
  scopes = hunkScopes(parts, pinGaps, { after }, shown);
  assert.equal([...scopes.values()].find((s) => s.definition.label === 'migrate()')?.reveal, undefined);
  assert.equal(scopes.size, 4, 'The pinned signature has no scope of its own');
});

void test('Hunk scopes in a Rust file, with deleted lines looked up in the old tree', async () => {
  const after = await definitions('rust', `${storeAfter.join('\n')}\n`);
  const beforeDefinitions = await definitions('rust', `${storeBefore.join('\n')}\n`);
  const hunks = hunksOf(storeBefore, storeAfter);
  const gaps = defined(diffGaps(hunks, storeAfter.length));
  const parts = revealedParts(hunks, gaps, {}, storeAfter);
  const scopes = hunkScopes(parts, gaps, { after, before: beforeDefinitions }, shownLines(parts).after);
  assert.deepEqual(
    [...scopes.values()].map((s) => [s.definition.label, s.side, s.opens]),
    [
      ['impl StoreBridge', 'after', false],
      ['StoreBridge.save()', 'after', false],
      ['trait Bridge', 'after', true],
      ['cleanup()', 'before', true],
      ['test saves_items()', 'after', true],
    ]
  );
  assert.equal(revealLabel([...scopes.values()][0]), 'Show whole impl block');
  // Each hunk's breadcrumb; the deleted line's comes from the old tree.
  assert.deepEqual(
    [...scopes.values()].map((s) => s.chain.map((crumb) => crumb.definition.crumb)),
    [['impl StoreBridge'], ['impl StoreBridge', 'fn save'], ['trait Bridge'], ['fn cleanup'], ['mod tests', 'fn saves_items']]
  );
  // A crumb reveals its own definition: the impl block around save(), whole, as it is under the cap.
  const save = [...scopes.values()][1];
  assert.equal(save.chain[0].reveal?.kind, 'whole');
  assert.equal(defined(save.chain[0].reveal).start, lineOf(storeAfter, 'impl StoreBridge {'));
  assert.deepEqual(save.chain.at(-1)?.reveal, save.reveal, 'The innermost crumb is the action');
  // The old definition maps to new lines: cleanup() lost a line.
  const cleanup = defined([...scopes.values()].find((s) => s.definition.label === 'cleanup()')).definition;
  assert.deepEqual(
    [cleanup.start, cleanup.end],
    [
      lineOf(storeAfter, 'pub fn cleanup(store: &mut StoreBridge) {'),
      lineOf(storeAfter, 'pub fn cleanup(store: &mut StoreBridge) {') + 3,
    ]
  );
  // Without the old side, a deletion's scope comes from the new tree around where the lines were.
  const afterOnly = hunkScopes(parts, gaps, { after }, shownLines(parts).after);
  assert.equal([...afterOnly.values()][3].definition.label, 'cleanup()');
  assert.equal([...afterOnly.values()][3].side, 'after');
  assert.equal(oldToNew(parts, gaps, 1), 1);
});

void test('Parsing a 3,000-line TypeScript file and a Rust file', async () => {
  // Load each grammar first, so the numbers are parse and query time alone.
  await definitions('typescript', 'const a = 1;\n');
  await definitions('rust', 'fn a() {}\n');
  const rustLarge = Array.from(
    { length: 600 },
    (_, k) => `impl Item${k} {\n    pub fn run(&self) -> u32 {\n        ${k}\n    }\n}`
  ).join('\n');
  const results: Record<string, { parse: number; query: number; definitions: number }> = {};
  for (const [name, language, source] of [
    ['typescript, 3,000 lines', 'typescript', `${largeAfter.join('\n')}\n`],
    ['rust, 3,000 lines', 'rust', `${rustLarge}\n`],
  ] as const) {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await engine.definitions(language, source));
    const best = runs.reduce((a, b) => (a.parse + a.query <= b.parse + b.query ? a : b));
    results[name] = {
      parse: Math.round(best.parse * 10) / 10,
      query: Math.round(best.query * 10) / 10,
      definitions: best.definitions.length,
    };
  }
  console.log('Parse timings (best of 5, ms):', JSON.stringify(results));
  assert.equal(results['typescript, 3,000 lines'].definitions, 1000);
  assert.equal(results['rust, 3,000 lines'].definitions, 1200);
  for (const [name, result] of Object.entries(results))
    assert.ok(result.parse + result.query < perfBudget(250), `${name}: ${JSON.stringify(result)}`);
});

before(async () => {
  // Every bundled grammar loads with this runtime.
  for (const language of ['typescript', 'tsx', 'javascript', 'rust', 'go', 'python', 'java', 'json', 'yaml'] as const)
    await definitions(language, '');
});

void test('Provisional crumbs: the hunk header text from the patch, until the definitions arrive', async () => {
  assert.equal(
    hunkHeaderText('@@ -1158,7 +1159,11 @@ public void SetChatQuestId(EntityId characterId, QuestId questId) {'),
    'public void SetChatQuestId(EntityId characterId, QuestId questId)',
    'The trailing brace goes'
  );
  assert.equal(hunkHeaderText('@@ -5 +5 @@   impl   Store\tfor  Bridge   {  '), 'impl Store for Bridge', 'Whitespace collapses');
  assert.equal(hunkHeaderText('@@ -1,3 +1,4 @@ def load(path):'), 'def load(path):');
  assert.equal(hunkHeaderText('@@ -1,3 +1,4 @@'), undefined, 'No text');
  assert.equal(hunkHeaderText('@@ -1,3 +1,4 @@   {'), undefined, 'Only a brace');
  assert.equal(hunkHeaderText(' context line'), undefined, 'Not a header');
  const long = hunkHeaderText(`@@ -1 +1 @@ fn ${'x'.repeat(400)}() {`);
  assert.ok(long && long.length === 160 && long.endsWith('…'), 'Long text is clipped');
  assert.deepEqual(patchHeaders('@@ -1,3 +1,3 @@ fn a() {\n a\n-b\n+c\n@@ -9,0 +10,2 @@\n+x\n+y\n@@ -20,2 +21,0 @@ fn b()\n-p\n-q'), [
    { newStart: 1, text: 'fn a()' },
    { newStart: 10, text: undefined },
    // A side with no lines names the line before it.
    { newStart: 22, text: 'fn b()' },
  ]);

  // A Rust handler: the hunk inside handler_3 is named by its header before the file is read.
  const [before, after] = lazyHandler(3);
  const patch = patchOf(before, after, { headers: true });
  assert.match(patch, /^@@ -\d+,\d+ \+\d+,\d+ @@ +pub fn handler_3\(&self\) -> u32 \{\n/);
  const hunks = hunksOf(before, after);
  const parts = revealedParts(hunks, defined(diffGaps(hunks)), {});
  const scopes = provisionalScopes(parts, patch);
  const scope = defined(scopes.get('h0'));
  assert.equal(scope.provisional, true);
  assert.equal(scope.reveal, undefined, 'Nothing reveals from a header');
  assert.equal(scope.opens, false);
  assert.deepEqual(scope.chain.map((crumb) => [crumb.definition.crumb, crumb.provisional]), [['pub fn handler_3(&self) -> u32', true]]);
  assert.equal(spokenChain('h003.rs', scope.chain), 'In h003.rs, pub fn handler_3(&self) -> u32');

  // Imports change at the top, outside every definition: no header text, so the file alone.
  const top = ['use std::fmt;', 'use std::io;', '', ...Array.from({ length: 12 }, (_, i) => `const A${i}: u32 = ${i};`), '', 'fn run() {', '    let a = 1;', '    let d = 4;', '    let e = 5;', '    let b = 2;', '    let c = 3;', '}'];
  const changed = top.map((line) => (line === 'use std::io;' ? 'use std::io::Write;' : line === '    let b = 2;' ? '    let b = 3;' : line));
  const twoPatch = patchOf(top, changed, { headers: true });
  const twoHunks = hunksOf(top, changed);
  const twoParts = revealedParts(twoHunks, defined(diffGaps(twoHunks)), {});
  const two = provisionalScopes(twoParts, twoPatch);
  assert.deepEqual(
    [...two.values()].map((s) => s.chain.map((crumb) => crumb.definition.crumb)),
    [[], ['fn run()']]
  );
  // Real definitions are a separate map: the view shows them instead once they arrive.
  const real = hunkScopes(twoParts, defined(diffGaps(twoHunks)), { after: await definitions('rust', `${changed.join('\n')}\n`) }, shownLines(twoParts).after);
  assert.ok([...real.values()].every((s) => !s.provisional));
  assert.equal(provisionalScopes(twoParts, undefined).size, 0, 'No patch, no provisional crumbs');
});
