// A login helper that ignores SIGTERM, simulating login.py wedged in its
// `sleep(interval)`/`send_oauth_request` poll loop against a slow or dead
// network. Used to prove LoginRunner#cancel() escalates to SIGKILL instead
// of hanging forever.
//
// As in stubborn-helper.mjs, a setInterval keeps the event loop alive
// independent of anything else, so only a real signal (SIGTERM, which we
// swallow, or SIGKILL, which cannot be caught) can end the process.
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

process.on("SIGTERM", () => {
  // Deliberately swallow it -- do not exit.
});

emit({ stage: "code", userCode: "ABCD1234",
       verificationUri: "https://www.twitch.tv/activate", expiresAt: 999 });
emit({ stage: "pending" });

setInterval(() => {}, 1_000_000);
