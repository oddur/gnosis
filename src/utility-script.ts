import { utilityProcess } from 'electron';
import { CRASHED, INCOMPLETE, TypeCheckSkipped, type RunScript } from './conflict-type-check';

/** After the process exits, how long its output may take to arrive in full. */
const OUTPUT_GRACE_MS = 2000;

/**
 * Runs a Node script in an Electron utility process: the packaged app cannot run itself as Node (the RunAsNode fuse is
 * off), and the computer may have no Node. The conflict type check runs the clone's compiler this way (#445 item 24).
 * A timeout or abort kills the process. It settles only once the process has exited and both of its outputs have
 * ended; output that doesn't end soon after the exit is incomplete, and is never read as a result. A fatal error in
 * the process, such as running out of memory, is "the type checker crashed", never an error in the main process.
 */
export const runUtilityScript: RunScript = (script, args, options) =>
  new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    let child: Electron.UtilityProcess;
    try {
      child = utilityProcess.fork(script, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: 'pipe',
        serviceName: 'Gnosis type check',
      });
    } catch {
      reject(new TypeCheckSkipped(CRASHED));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let settled = false;
    let exit: number | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const open = new Set<NodeJS.ReadableStream>();
    const timer = setTimeout(() => stop(new Error('The operation timed out.')), options.timeout);
    const abort = () => stop(new Error('Operation cancelled.'));
    const finish = () => {
      // A failure settles at once: the process is killed, and nothing it wrote is read.
      if (settled || (!failure && (exit === undefined || open.size))) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code: exit ?? 128, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    function stop(reason: Error) {
      if (failure) return;
      failure = reason;
      child.kill();
      finish();
    }
    for (const [stream, list] of [
      [child.stdout, out],
      [child.stderr, err],
    ] as const) {
      if (!stream) continue;
      open.add(stream);
      stream.on('data', (data: Buffer) => {
        size += data.length;
        if (size > options.maxBytes) stop(new TypeCheckSkipped(INCOMPLETE));
        else list.push(data);
      });
      const ended = () => {
        open.delete(stream);
        finish();
      };
      stream.once('end', ended);
      stream.once('close', ended);
      stream.once('error', ended);
    }
    options.signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => stop(new TypeCheckSkipped(CRASHED)));
    child.once('exit', (code) => {
      exit = code;
      if (open.size && !failure) grace = setTimeout(() => stop(new TypeCheckSkipped(INCOMPLETE)), OUTPUT_GRACE_MS);
      finish();
    });
  });
