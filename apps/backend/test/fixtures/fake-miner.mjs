// Stands in for the Python miner. Behaviour via env:
//   FAKE_MODE=normal         run until SIGTERM, exit 0 cleanly
//   FAKE_MODE=stubborn       ignore SIGTERM, must be SIGKILLed
//   FAKE_MODE=instant        exit(1) immediately (unstartable config)
//   FAKE_MODE=delayed_crash  run for DIE_AFTER_MS (default 700), then
//                            exit(1) on its own -- simulates a crash
//                            *after* the miner is considered successfully
//                            started (past fastExitMs), so it exercises
//                            the backoff/auto-restart path rather than
//                            the "unstartable config" CRASHED path that
//                            FAKE_MODE=instant exercises.
//
// The setInterval below keeps the event loop alive independent of stdio,
// so this process does not exit merely because stdin closes -- only a
// real signal (SIGTERM, which "stubborn" mode swallows, or SIGKILL,
// which cannot be caught) can end it. Without this, a stop() test could
// falsely pass without ever exercising SIGTERM-resistance.
const mode = process.env.FAKE_MODE ?? "normal";
if (mode === "instant") {
  process.stderr.write("KeyError: 'username'\n");
  process.exit(1);
}
process.stdout.write("miner started\n");
if (mode === "stubborn") {
  process.on("SIGTERM", () => process.stdout.write("ignoring SIGTERM\n"));
} else {
  process.on("SIGTERM", () => { process.stdout.write("shutting down\n"); process.exit(0); });
}
if (mode === "delayed_crash") {
  const dieAfter = Number(process.env.DIE_AFTER_MS ?? 700);
  setTimeout(() => {
    process.stderr.write("simulated crash after delay\n");
    process.exit(1);
  }, dieAfter);
}
setInterval(() => {}, 1000);
