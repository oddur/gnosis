// A drop-in for `test` from node:test that can run one part of a long test file. With GNOSIS_TEST_PART=i/n, a file
// registers only every n-th top-level test, starting at the i-th, so n processes (or n CI jobs) run the file between
// them, each test exactly once. Without the variable every test runs. scripts/run-unit-tests.mjs sets it, only for the
// processes that run files importing this module.
import { test as nodeTest } from 'node:test';

type Part = { index: number; count: number };

/** The part `i/n` (1-based) from GNOSIS_TEST_PART, or undefined when the whole file runs. */
export function testPart(value = process.env.GNOSIS_TEST_PART): Part | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return undefined;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`Invalid GNOSIS_TEST_PART ${value}; expected i/n`);
  return { index, count };
}

/** Whether the test registered at `position` (0-based, in file order) belongs to the part. */
export const inPart = (position: number, part: Part) => position % part.count === part.index - 1;

/**
 * A `test` whose top-level tests, skipped and todo ones included, count towards the part. `only`, `it`, `describe` and
 * `suite` would register outside that count, so every part would run them, or none; they throw instead.
 */
export function partTest(part: Part | undefined): typeof nodeTest {
  let position = 0;
  const mine = () => !part || inPart(position++, part);
  const unsupported = (name: string) => () => {
    throw new Error(
      `${name} is not supported in a file split by tests/support/test-part.ts: use top-level test() calls, or take test from node:test.`
    );
  };
  return Object.assign(
    (...args: Parameters<typeof nodeTest>) => (mine() ? nodeTest(...args) : Promise.resolve()),
    nodeTest,
    {
      skip: (...args: Parameters<typeof nodeTest.skip>) => (mine() ? nodeTest.skip(...args) : Promise.resolve()),
      todo: (...args: Parameters<typeof nodeTest.todo>) => (mine() ? nodeTest.todo(...args) : Promise.resolve()),
      only: unsupported('test.only'),
      it: unsupported('it'),
      describe: unsupported('describe'),
      suite: unsupported('suite'),
    }
  ) as typeof nodeTest;
}

export const test = partTest(testPart());
