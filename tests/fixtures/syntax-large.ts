import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';
import { patchOf } from './syntax-scope';

/**
 * `?syntax-large`: a large PR for the structure load speed checks (`--syntax-scope`). 168 modified files in six
 * languages (C#, Rust, TypeScript, Go, Python, Java), every seventh one 2,400 lines or more, the rest 200 to 700. Each
 * file changes three methods, near its top, middle and end; in every fourth file the middle change only deletes a
 * line, so its old side is read and parsed as well. Contents are never prepared: Changes reads them as it would from
 * GitHub, and the test adds latency.
 */
export const LARGE_FILES = 168;
const LANGUAGES = ['cs', 'rs', 'ts', 'go', 'py', 'java'] as const;
type Extension = (typeof LANGUAGES)[number];
const BODY = 18;

/** One method, `BODY + 3` lines, at the given indent. */
function method(extension: Extension, index: number, indent: string): string[] {
  // Lines as dense as real code: a call with several arguments, a string and arithmetic.
  const body = Array.from({ length: BODY }, (_, k) => `total += compute(total, ${k}, "label-${k}") * (total + ${k}) / scale(1, ${k});`);
  const inner = indent + '    ';
  switch (extension) {
    case 'cs':
      return [`${indent}public int Method${index}(int input) {`, `${inner}var total = input;`, ...body.map((l) => inner + l), `${inner}return total;`, `${indent}}`];
    case 'rs':
      return [`${indent}pub fn method_${index}(&self) -> u32 {`, `${inner}let mut total = 0;`, ...body.map((l) => inner + l), `${inner}total`, `${indent}}`];
    case 'ts':
      return [`${indent}method${index}(input: number): number {`, `${inner}let total = input;`, ...body.map((l) => inner + l), `${inner}return total;`, `${indent}}`];
    case 'go':
      return [`func (s *Service) Method${index}(input int) int {`, '    total := input', ...body.map((l) => '    ' + l.replace(';', '')), '    return total', '}'];
    case 'py':
      return [`${indent}def method_${index}(self, total):`, `${inner}total = total or 0`, ...body.map((l) => inner + l.replace(';', '')), `${inner}return total`];
    case 'java':
      return [`${indent}public int method${index}(int input) {`, `${inner}int total = input;`, ...body.map((l) => inner + l), `${inner}return total;`, `${indent}}`];
  }
}

/** A file of `count` methods inside its language's container. */
function source(extension: Extension, file: number, count: number): string[] {
  const methods = (indent: string) => Array.from({ length: count }, (_, i) => ['', ...method(extension, i, indent)]).flat();
  switch (extension) {
    case 'cs':
      return [`// Large fixture ${file}.`, 'using System;', '', 'namespace Gnosis.Large {', `    public class Service${file} {`, ...methods('        '), '    }', '}'];
    case 'rs':
      return [`// Large fixture ${file}.`, 'use std::fmt;', '', 'mod api {', `    pub struct Service${file};`, '', `    impl Service${file} {`, ...methods('        '), '    }', '}'];
    case 'ts':
      return [`// Large fixture ${file}.`, "import { join } from 'node:path';", '', `export class Service${file} {`, ...methods('  '), '}'];
    case 'go':
      return [`// Large fixture ${file}.`, 'package large', '', 'type Service struct{}', ...methods('')];
    case 'py':
      return [`# Large fixture ${file}.`, 'import os', '', `class Service${file}:`, ...methods('    ')];
    case 'java':
      return [`// Large fixture ${file}.`, 'package gnosis.large;', '', `public class Service${file} {`, ...methods('    '), '}'];
  }
}

/** The line of method `index`'s body that changes: its `compute(total, k, …)` line. */
const target = (extension: Extension, before: string[], index: number, k: number) => {
  const head =
    extension === 'cs' || extension === 'go' ? `Method${index}(` : extension === 'ts' || extension === 'java' ? `method${index}(` : `method_${index}(`;
  const start = before.findIndex((line) => line.includes(head));
  return before.findIndex((line, i) => i > start && line.includes(`compute(total, ${k},`));
};

export function largeFile(file: number): { path: string; before: string[]; after: string[]; deletes: boolean } {
  const extension = LANGUAGES[file % LANGUAGES.length];
  const big = file % 7 === 0;
  // 2,400+ lines for every seventh file; 200 to 700 for the rest.
  const count = big ? 110 + (file % 3) * 10 : 10 + ((file * 7) % 24);
  const before = source(extension, file, count);
  const after = [...before];
  const deletes = file % 4 === 3;
  const [first, middle, last] = [1, Math.floor(count / 2), count - 2];
  const edit = (index: number, k: number) => {
    const line = target(extension, before, index, k);
    after[line] = after[line].replace(`compute(total, ${k},`, `compute(total, ${k} * 2,`);
  };
  edit(first, 5);
  edit(last, 5);
  if (deletes) after.splice(target(extension, before, middle, 7), 1);
  else edit(middle, 5);
  const folder = { cs: 'Services', rs: 'api', ts: 'web', go: 'server', py: 'tools', java: 'core' }[extension];
  return { path: `src/large/${folder}/f${String(file).padStart(3, '0')}.${extension}`, before, after, deletes };
}

const LARGE = Array.from({ length: LARGE_FILES }, (_, i) => largeFile(i));
const BY_PATH = new Map(LARGE.map((file) => [file.path, file]));
export const syntaxLargeFiles: PrChangeFile[] = LARGE.map(({ path, before, after }, i) => {
  const patch = patchOf(before, after, { headers: true });
  const lines = patch.split('\n');
  return {
    path,
    status: 'modified' as const,
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    changeId: `large-${i}`,
    patch,
  };
});
const text = (lines: string[]) => `${lines.join('\n')}\n`;
export function syntaxLargeContents(path: string): PrFileContents | undefined {
  const file = BY_PATH.get(path);
  return file && { before: { kind: 'text', content: text(file.before) }, after: { kind: 'text', content: text(file.after) } };
}
