/** The classifier and a parser, for scripts/noise-audit.ts and scripts/noise-explain.ts. */
import fs from 'node:fs';
import path from 'node:path';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine, type SyntaxLanguage } from '../lib/syntax-scope';
import type { NoiseBlock } from '../lib/semantic-noise';

const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: () => Promise.resolve(new Uint8Array(fs.readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')))),
  grammar: (language) => Promise.resolve(new Uint8Array(fs.readFileSync(path.join(assets, `${language}.wasm`)))),
  tags: (name) => Promise.resolve(fs.readFileSync(path.join(assets, `${name}-tags.scm`), 'utf8')),
});
let parser: TreeSitter.Parser | undefined;
const grammars = new Map<SyntaxLanguage, TreeSitter.Language>();
export async function parse(language: SyntaxLanguage, text: string) {
  if (!parser) {
    await TreeSitter.Parser.init({ wasmBinary: fs.readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')) as unknown as ArrayBuffer, locateFile: (n: string) => n });
    parser = new TreeSitter.Parser();
  }
  let grammar = grammars.get(language);
  if (!grammar) {
    grammar = await TreeSitter.Language.load(new Uint8Array(fs.readFileSync(path.join(assets, `${language}.wasm`))));
    grammars.set(language, grammar);
  }
  parser.setLanguage(grammar);
  const tree = parser.parse(text);
  if (!tree) throw Error('No tree');
  return tree;
}

/** The kind of each change block between two texts, as GitHub's patch would show them. */
export async function kinds(language: SyntaxLanguage, before: string, after: string) {
  const patch = structuredPatch('a', 'b', before, after, '', '', { context: 3 });
  const hunks = patch.hunks.map((hunk) => ({
    oldStart: hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart,
    newStart: hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart,
    rows: hunk.lines.filter((l) => !l.startsWith('\\')).map((l) => ({ type: l[0] as ' ' | '+' | '-', text: l.slice(1) })),
  }));
  if (!hunks.length) return { blocks: [] as NoiseBlock[], ms: 0 };
  const result = await engine.noise(language, after, hunks);
  return { blocks: result.blocks, ms: result.classify };
}

