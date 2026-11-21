/**
 * Some suites build fixtures with fixed dates, and the code under test only looks at PRs updated in the last N days.
 * `useFixtureClock(at)` shifts the clock to `at` (it keeps ticking), so those suites don't start failing once the dates
 * age out. Call it at the top of the suite, before anything reads the time; pick a moment just after the fixture dates.
 *
 * Only `Date` and `Date.now` move; `performance.now()` and timers are untouched.
 */
export function useFixtureClock(at: string) {
  shiftClock(realDate().parse(at) - realDate().now());
}

/**
 * Carries the browser suites' clock offset in milliseconds. scripts/test-workbench.mjs computes it once, so the test
 * main (tests/electron-test-shim.ts) and every fixture page, across reloads, share one shifted clock.
 */
export const FIXTURE_CLOCK_OFFSET = 'GNOSIS_FIXTURE_CLOCK_OFFSET';

const real = Symbol.for('gnosis.fixture-clock.real-date');
type Shifted = DateConstructor & { [real]?: DateConstructor };
const realDate = () => (Date as Shifted)[real] ?? Date;

/** Shifts `Date` by `offset` milliseconds from the real clock. A second call replaces the first shift. */
export function shiftClock(offset: number) {
  const RealDate = realDate();
  class ShiftedDate extends RealDate {
    // `new Date(y, m, …)` passes several arguments; the typings only know the one-argument form.
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [number]));
      else super(RealDate.now() + offset);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  Object.defineProperty(ShiftedDate, real, { value: RealDate });
  Object.defineProperty(ShiftedDate, 'name', { value: 'Date' });
  globalThis.Date = ShiftedDate as DateConstructor;
}
