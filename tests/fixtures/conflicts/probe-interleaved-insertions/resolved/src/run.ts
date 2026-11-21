export function run(ready: boolean) {
  start();
  if (ready) {
    go();
  }
  stop();
  finish();
}
