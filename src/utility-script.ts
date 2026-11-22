import { utilityProcess } from 'electron';
import type { RunScript } from './conflict-type-check';

/**
 * Runs a Node script in an Electron utility process: the packaged app cannot run itself as Node (the RunAsNode fuse is
 * off), and the computer may have no Node. The conflict type check runs the clone's compiler this way (#445 item 24).
 * A timeout or abort kills the process.
 */
export const runUtilityScript: RunScript = (script, args, options) =>
  new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const child = utilityProcess.fork(script, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
      serviceName: 'Gnosis type check',
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (reason: Error) => {
      if (failure) return;
      failure = reason;
      child.kill();
    };
    const collect = (list: Buffer[]) => (data: Buffer) => {
      size += data.length;
      if (size > options.maxBytes) stop(new Error('The compiler wrote more output than Gnosis reads.'));
      else list.push(data);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    const abort = () => stop(new Error('Operation cancelled.'));
    options.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('The operation timed out.')), options.timeout);
    child.once('exit', (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        });
    });
  });
