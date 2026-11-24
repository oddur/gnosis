// A drop-in for `test` from node:test that can run one part of a long test file. With GNOSIS_TEST_PART=i/n, a file
// registers only every n-th top-level test, starting at the i-th, so n processes (or n CI jobs) run the file between
// them, each test exactly once. Without the variable every test runs. scripts/run-unit-tests.mjs sets it.
import { test as nodeTest } from 'node:test';

/** The part `i/n` (1-based) from GNOSIS_TEST_PART, or undefined when the whole file runs. */
export function testPart(value = process.env.GNOSIS_TEST_PART): { index: number; count: number } | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return undefined;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`Invalid GNOSIS_TEST_PART ${value}; expected i/n`);
  return { index, count };
}

/** Whether the test registered at `position` (0-based, in file order) belongs to the part. */
export const inPart = (position: number, part: { index: number; count: number }) =>
  position % part.count === part.index - 1;

const part = testPart();
let position = 0;

export const test: typeof nodeTest = part
  ? Object.assign(
      (...args: Parameters<typeof nodeTest>) => (inPart(position++, part) ? nodeTest(...args) : Promise.resolve()),
      nodeTest
    )
  : nodeTest;
