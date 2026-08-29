const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
emit({ stage: "code", userCode: "ABCD1234",
       verificationUri: "https://www.twitch.tv/activate", expiresAt: 999 });
emit({ stage: "pending" });
if (process.env.FAKE_LOGIN === "fail") {
  emit({ stage: "error", error: "token rejected by Twitch" });
  process.exit(1);
}
if (process.env.FAKE_LOGIN === "badstage") {
  // Task 11 correction 5: a line whose "stage" isn't one of the known
  // LoginProgress variants (e.g. a future helper version, or transient
  // corruption) must never reach consumers as if it were valid progress.
  emit({ stage: "bogus", note: "unrecognised by the runner" });
}
if (process.env.FAKE_LOGIN === "stderr-flood") {
  // Task 11 correction 2: write past the OS pipe's ~64KB buffer so a
  // runner that isn't reading child.stderr would deadlock here forever.
  // Exits without ever reaching "ok"/"error" so the runner's own
  // synthesized error message is what gets asserted on, proving the
  // collected (tail-capped) stderr text ends up in it.
  process.stderr.write(`${"x".repeat(200_000)}TRACEBACK_MARKER_END`);
  process.exit(1);
}
emit({ stage: "ok", username: "alex" });
