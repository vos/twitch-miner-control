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
if (process.env.FAKE_LOGIN === "stderr-utf8-split") {
  // One emoji split across two writes, so its bytes straddle a chunk
  // boundary. Decoding each chunk independently yields replacement
  // characters; a streaming decoder holds the partial bytes.
  const emoji = Buffer.from("\u{1F389}", "utf8");
  process.stderr.write(emoji.subarray(0, 2));
  await new Promise((r) => setTimeout(r, 50));
  process.stderr.write(emoji.subarray(2));
  process.exit(1);
}
if (process.env.FAKE_LOGIN === "stderr-flood") {
  // Task 11 correction 2: write past the OS pipe's ~64KB buffer so a
  // runner that isn't reading child.stderr would deadlock here forever.
  // Exits without ever reaching "ok"/"error" so the runner's own
  // synthesized error message is what gets asserted on, proving the
  // collected (tail-capped) stderr text ends up in it.
  // Exit from the write callback, not straight after the write:
  // process.exit() does not flush pending stdio, so a 200KB write to a
  // pipe that has not drained is simply discarded. Node 20 happened to
  // absorb it and Node 24 does not, which made this look like a bug in
  // the runner rather than in this fixture.
  await new Promise((resolve) =>
    process.stderr.write(`${"x".repeat(200_000)}TRACEBACK_MARKER_END`, resolve),
  );
  process.exit(1);
}
emit({ stage: "ok", username: "alex" });
