export function run(ok: boolean) {
  if (ok) {
    run();
  } else {
    skip();
    log();
  }
}
