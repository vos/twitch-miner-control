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
    // Write the response one character at a time with the event loop
    // yielding in between, forcing the OS pipe (and therefore the
    // client's stdout handler) to see it as many separate chunks rather
    // than one line-sized write.
    const payload = `${JSON.stringify({ id: req.id, ok: true, data: { echoed: "slow_chunks" } })}\n`;
    let i = 0;
    const writeNext = () => {
      if (i >= payload.length) return;
      process.stdout.write(payload[i]);
      i += 1;
      setImmediate(writeNext);
    };
    writeNext();
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
