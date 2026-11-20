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

/**
 * How the palette runs a chosen command: at once through `run`, or, for `afterClose` commands, once the palette has
 * closed. Either way nothing starts while an earlier action is still running.
 */
export function commandRunner(input: {
  busy: () => boolean;
  run: (perform: () => void | Promise<void>) => void;
  afterClose: Pick<ReturnType<typeof createAfterClose>, 'set'>;
  close: () => void;
}) {
  return (command: { perform: () => void | Promise<void>; afterClose?: boolean }) => {
    if (input.busy()) return;
    if (!command.afterClose) {
      input.run(command.perform);
      return;
    }
    input.afterClose.set(command.perform);
    input.close();
  };
}
