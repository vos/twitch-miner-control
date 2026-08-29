// A helper that ignores SIGTERM, simulating a Python helper wedged in an
// uninterruptible read or a network call (see state.py's `for line in
// stdin` loop). Used to prove NdjsonClient#stop() escalates to SIGKILL
// instead of hanging forever.
//
// Critically, this process must NOT exit merely because stdin closes --
// a plain readline-on-stdin process (like echo-helper.mjs) exits on EOF
// as soon as the client calls stdin.end(), which would let this fixture
// "pass" stop() without ever actually testing SIGTERM-resistance. A
// setInterval keeps the event loop alive independent of stdin, so only a
// real signal (SIGTERM, which we swallow, or SIGKILL, which cannot be
// caught) can end the process.
import { createInterface } from "node:readline";

process.on("SIGTERM", () => {
  // Deliberately swallow it -- do not exit.
});

setInterval(() => {}, 1_000_000);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({ id: req.id, ok: true, data: { echoed: req.op } })}\n`,
  );
});
