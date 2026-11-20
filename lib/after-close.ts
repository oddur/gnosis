/**
 * A command the palette runs once it has closed and handed focus back (`AppCommand.afterClose`). Opening the palette
 * again drops a command left from an earlier opening, so it never runs on a later close; a failure is reported, since
 * the palette's own error line is gone by then.
 */
export function createAfterClose(report: (message: string) => void) {
  let pending: (() => void | Promise<void>) | null = null;
  return {
    set(perform: () => void | Promise<void>) {
      pending = perform;
    },
    /** The palette opened. */
    clear() {
      pending = null;
    },
    /** The palette closed and focus is back. Resolves once the command has finished or failed. */
    async run() {
      const next = pending;
      pending = null;
      if (!next) return;
      try {
        await next();
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
