/**
 * Some suites build fixtures with fixed dates, and the code under test only looks at PRs updated in the last N days.
 * `useFixtureClock(at)` shifts the clock to `at` (it keeps ticking), so those suites don't start failing once the dates
 * age out. Call it at the top of the suite, before anything reads the time; pick a moment just after the fixture dates.
 */
export function useFixtureClock(at: string) {
  const RealDate = Date;
  const offset = RealDate.parse(at) - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length) super(...args);
      else super(RealDate.now() + offset);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}
