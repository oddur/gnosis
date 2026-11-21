export function run(ok: boolean) {
  if (ok) {
    run();
    log();
  } else {
    skip();
  }
}
