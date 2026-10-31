import { spawn } from 'node:child_process';

/** Bounded subprocess groups: cancellation also stops Git's network helpers. */
export function runConflictProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    signal?: AbortSignal;
    timeout?: number;
    maxBytes?: number;
  } = {}
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: 'pipe',
      detached: grouped,
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let size = 0,
      failure: Error | undefined,
      forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error) => {
      if (failure) return;
      failure = reason;
      if (grouped && child.pid) {
        const pid = child.pid;
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill();
        }
        forceTimer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }, 1000);
      } else if (child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const abort = () => stop(new Error('Operation cancelled. Reopen the workspace to inspect the saved draft.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => stop(new Error('The operation timed out. Reopen the workspace to check its saved state.')),
      options.timeout ?? 120_000
    );
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    const collect = (list: Buffer[], data: Buffer) => {
      size += data.length;
      if (size > (options.maxBytes ?? 32 * 1024 * 1024))
        stop(new Error('This conflict is too large to resolve in Gnosis.'));
      else list.push(data);
    };
    child.stdout.on('data', (data: Buffer) => collect(out, data));
    child.stderr.on('data', (data: Buffer) => collect(err, data));
    child.stdin.on('error', () => {
      /* A stopped process may close stdin before consuming it. */
    });
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      if (failure) reject(failure);
      else resolve({ code: code ?? 128, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(options.input);
  });
}
