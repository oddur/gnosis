export function run(ready: boolean) {
  start();
  if (ready) {
  stop();
    go();
  }
  finish();
}
