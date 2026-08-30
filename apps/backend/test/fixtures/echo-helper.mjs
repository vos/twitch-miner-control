// Minimal stand-in for python/helpers/state.py speaking the same protocol.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

// Buffers pending "coalesce_*" requests so their responses can be flushed
// together in a single stdout.write() -- used to prove the client can
// split two JSON lines out of one chunk.
const coalesceQueue = [];
let pendingReorderFirst = null;

rl.on("line", (line) => {
  const req = JSON.parse(line);

  if (req.op === "crash") process.exit(3);
  if (req.op === "silent") return;

  if (req.op === "whoami") {
    // Reports the environment this process was SPAWNED with. Used to prove
    // that recycling the client really replaced the OS process, rather
    // than just re-reading a value inside the existing one -- which is the
    // whole point, since helpers/_session.py freezes the cookie path from
    // TWITCH_USERNAME at startup and never re-reads the variable.
    process.stdout.write(
      `${JSON.stringify({
        id: req.id,
        ok: true,
        data: { username: process.env.TWITCH_USERNAME ?? null, pid: process.pid },
      })}\n`,
    );
    return;
  }

  if (req.op === "echo_params") {
    // Echoes back the full received request object (minus id/op) so a
    // test can assert exactly which fields the client put on the wire --
    // used to prove the envelope (id/op) cannot be overridden by params.
    const { id, op, ...rest } = req;
    process.stdout.write(
      `${JSON.stringify({ id: req.id, ok: true, data: { receivedOp: op, rest } })}\n`,
    );
    return;
  }

  if (req.op === "bad_json_style_error") {
    // Mirrors python/helpers/state.py's bad-JSON path (lines 167-169):
    // a response with no correlating id at all, because the helper never
    // got far enough to know what id it was replying to.
    process.stdout.write(
      `${JSON.stringify({
        id: null,
        ok: false,
        error: "bad json: simulated parse failure",
        code: "BAD_REQUEST",
      })}\n`,
    );
    return;
  }

  if (req.op === "orphan_success") {
    // A *success* frame with no correlating id. No correct helper can
    // produce this (state.py always echoes the id back), but a buggy one
    // could -- and the client used to drop it silently, stalling the caller
    // until its request timeout fired and then blaming a timeout.
    process.stdout.write(
      `${JSON.stringify({ id: null, ok: true, data: { echoed: req.op } })}\n`,
    );
    return;
  }

  if (req.op === "auth_fail") {
    process.stdout.write(
      `${JSON.stringify({
        id: req.id,
        ok: false,
        error: "Twitch session dead",
        code: "AUTH",
      })}\n`,
    );
    return;
  }

  if (req.op === "slow_chunks") {
    // Deliberately split the response across two writes separated by a
    // real timer tick (not setImmediate/microtask, which the OS pipe can
    // still coalesce back into one read on a fast machine). Waiting a
    // real 20ms with the first half already flushed forces the kernel to
    // deliver it as a separate read to the client before the remainder
    // exists at all -- so a client that assumes one `data` event is one
    // complete line will either hang (never sees the newline in the
    // first chunk) or throw parsing truncated JSON, rather than
    // incidentally passing because the halves got glued back together.
    const payload = `${JSON.stringify({ id: req.id, ok: true, data: { echoed: "slow_chunks" } })}\n`;
    const splitAt = Math.floor(payload.length / 2);
    process.stdout.write(payload.slice(0, splitAt), () => {
      setTimeout(() => {
        process.stdout.write(payload.slice(splitAt));
      }, 20);
    });
    return;
  }

  if (req.op === "coalesce_a" || req.op === "coalesce_b") {
    coalesceQueue.push(req);
    if (coalesceQueue.length === 2) {
      const combined = coalesceQueue
        .map((r) => JSON.stringify({ id: r.id, ok: true, data: { echoed: r.op } }))
        .join("\n");
      coalesceQueue.length = 0;
      process.stdout.write(`${combined}\n`);
    }
    return;
  }

  if (req.op === "reorder_first") {
    // Hold this one until reorder_second arrives, then send second's
    // response first -- proves correlation is by id, not arrival order.
    pendingReorderFirst = req;
    return;
  }
  if (req.op === "reorder_second") {
    process.stdout.write(
      `${JSON.stringify({ id: req.id, ok: true, data: { echoed: "reorder_second" } })}\n`,
    );
    if (pendingReorderFirst) {
      process.stdout.write(
        `${JSON.stringify({ id: pendingReorderFirst.id, ok: true, data: { echoed: "reorder_first" } })}\n`,
      );
      pendingReorderFirst = null;
    }
    return;
  }

  process.stdout.write(
    `${JSON.stringify({ id: req.id, ok: true, data: { echoed: req.op } })}\n`,
  );
});
