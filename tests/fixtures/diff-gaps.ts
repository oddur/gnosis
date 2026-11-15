import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';

/**
 * Synthetic files for the `--diff-gaps` suite, added to the workbench fixture's Changes with `?diff-gaps`.
 *
 * `src/gaps.ts` has 200 lines before and 201 after. The first change replaces line 50 with two lines, so below it the
 * new side runs one line ahead of the old side. Its patch has two hunks, which leave three gaps: new lines 1–46,
 * 55–147 (old 54–146) and 155–201 (old 154–200).
 *
 * `zz/huge.ts` is a 3,000-line added file.
 */
const before = Array.from({ length: 200 }, (_, i) => `export const g${i + 1} = ${i + 1};`);
const after = [
  ...before.slice(0, 49),
  'export const g50 = 500;',
  'export const g50b = 501;',
  ...before.slice(50, 149),
  'export const g150 = 1500;',
  ...before.slice(150),
];
const context = (from: number, to: number) => before.slice(from - 1, to).map((line) => ` ${line}`);
const gapsPatch = [
  '@@ -47,7 +47,8 @@',
  ...context(47, 49),
  `-${before[49]}`,
  `+${after[49]}`,
  `+${after[50]}`,
  ...context(51, 53),
  '@@ -147,7 +148,7 @@',
  ...context(147, 149),
  `-${before[149]}`,
  `+${after[150]}`,
  ...context(151, 153),
].join('\n');

export const diffGapsBefore = `${before.join('\n')}\n`;
export const diffGapsAfter = `${after.join('\n')}\n`;
export const hugeLines = Array.from(
  { length: 3000 },
  (_, k) => `export function generated${k}(input: number): number { return input * ${k} + ${k % 7}; }`
);
const huge = hugeLines.join('\n');

export const diffGapFiles: PrChangeFile[] = [
  { path: 'src/gaps.ts', status: 'modified', additions: 3, deletions: 2, changeId: 'gaps-v1', patch: gapsPatch },
  {
    path: 'zz/huge.ts',
    status: 'added',
    additions: 3000,
    deletions: 0,
    changeId: 'huge-v1',
    patch: `@@ -0,0 +1,3000 @@\n${hugeLines.map((line) => `+${line}`).join('\n')}`,
  },
];

export function diffGapContents(path: string): PrFileContents | undefined {
  if (path === 'src/gaps.ts')
    return { before: { kind: 'text', content: diffGapsBefore }, after: { kind: 'text', content: diffGapsAfter } };
  if (path === 'zz/huge.ts') return { before: { kind: 'absent' }, after: { kind: 'text', content: huge } };
}
