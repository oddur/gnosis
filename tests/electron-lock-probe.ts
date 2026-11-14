/**
 * A minimal Gnosis main process for the single-instance smoke test: the production lock and link buffer, and no
 * window. tests/electron-smoke.ts starts several with `--user-data-dir` and `GNOSIS_SINGLE_INSTANCE=1` (the lock
 * without OS registration). Each line on stdout is one JSON event.
 */
import { app } from 'electron';
import { instance } from '../src/single-instance-start';

const say = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (instance.primary) {
  instance.attach({ receive: (link, source) => say({ link, source }), show: () => say({ show: true }) });
  void app.whenReady().then(() => say({ ready: app.getPath('userData') }));
} else {
  say({ lost: true });
}
