/**
 * Some suites build fixtures with fixed October 2026 dates, and the code under test only looks at PRs updated in the
 * last N days. Importing this module shifts the clock to just after those dates (it still ticks), so the suites don't
 * start failing a month later when the dates age out. Import it first, before anything reads the time.
 */
const RealDate = Date;
const offset = RealDate.parse('2026-10-27T00:00:00Z') - RealDate.now();
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
export {};
