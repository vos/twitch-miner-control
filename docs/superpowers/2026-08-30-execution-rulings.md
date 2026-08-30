# Execution rulings — Twitch Miner Control UI

Decisions taken by the controlling agent while executing
`docs/superpowers/plans/2026-08-29-twitch-miner-web-ui.md` across its 20 tasks, without pausing
to ask. Each records what was decided, why, and what it costs if wrong, in the order made.

Most exist because the plan itself was defective in a way only implementation exposed: twelve
distinct plan defects were found and ruled on during execution, two of them Critical — an
authentication bypass reachable by percent-encoding one character of a URL, and a first-run
path that left the app unconfigurable through its own UI.

A recurring theme worth reading for on its own: this plan's tests repeatedly passed against
broken implementations. The auth bypass shipped with six green auth tests. A supervisor restart
cap that never engaged had a test that passed either way. A Python helper that could not be run
as a script passed pytest because the test config masked it. Two tests failed one run in three
under parallel load while reporting green in isolation.

This file is the durable record; the execution ledger it was extracted from was deleted with
its scratch workspace once the final review came back clean.

---

### 

Ruling: keep task order (T3's testable unit is miner_config, which T4 does not touch; reordering
would make T4's run.py-integration unverifiable instead). Instruct T3's implementer to create
python/helpers/__init__.py and a minimal python/helpers/doorbell.py stub ONLY if needed to make
step 6 reach the KeyError, and to expect T4 to replace doorbell.py wholesale. T3 step 6 accepts
either KeyError or a clean import as long as exit is non-zero and fast.
Cost if wrong: T4 overwrites a stub; near-zero rework.


---

### 

Ruling: server.ts belongs to T15 alone. T14's file list is wrong; T14 delivers auth.ts + sse.ts only.
Spec is silent on file layout, so the plan's actual code bodies are authoritative over its file list.
Cost if wrong: none — T15 writes the only server.ts body in the plan.


---

### 

Ruling: these three belong to T19. T16 delivers package.json, vite.config.ts, test-setup.ts,
api/client.ts, components/PasswordGate.tsx and their tests. T16's build/dev scripts are not
exercised until T19, which is acceptable — T16's gate is its two vitest files.
Cost if wrong: none — T19 writes the only bodies.


---

### 

Ruling: do NOT create the five routes.*.ts files. The plan's own code is authoritative; inventing
five empty modules to satisfy a stale file list is worse than a single cohesive server.ts.
Reviewers will be told server.ts is the intended home for T15's routes.
Cost if wrong: server.ts is larger than the spec's "one file per route group" sketch; if it grows
unwieldy a later refactor splits it. Flagging to the final review as a deliberate deviation.


---

### Task 1

Ruling: plan defect — our pyproject.toml declares only `requests`, but Tasks 2-7 all
`import TwitchChannelPointsMiner...`, which pulls the miner's transitive deps (websocket-client,
emoji, colorama, millify, pytz, validators, irc, flask, werkzeug, python-dateutil, pandas).
Verified: contract-style import fails under pytest with ModuleNotFoundError: websocket.
The plan's Global Constraints require `uv run pytest` to pass, which is impossible as written.
Decision: add the miner's runtime deps to our [project].dependencies, EXCLUDING pre-commit
(a dev tool, not a runtime import). Doing it as a Task-1 amendment rather than deferring, because
every Python task from 2 onward is blocked without it.
Cost if wrong: our venv is heavier than strictly needed (pandas/flask are only needed by miner
subsystems we do not drive). Acceptable — the Dockerfile already installs the miner's full deps
via `uv sync` against a pyproject that must satisfy the miner anyway.


---

### Task 1

Ruling: implementer's concern #1 ("miner_config/helpers missing from vendor/miner") is a
misread — those are OUR modules, created by Tasks 3-7 at python/. No action.


---

### Task 2

Ruling: reviewer raised 3 findings, ALL plan-mandated (implementer transcribed my brief verbatim,
so these are defects in the plan I authored, not in the implementation). Verified all three against real
upstream source before ruling.
(i) GQL methods pinned by `callable(...)` only, not signature. Real risk: Task 6 calls
get_channel_points_context(username), with_is_stream_live_query(channel_id), get_id_from_login(username)
positionally. Verified actual params: ['self','username'], ['self','channel_id'], ['self','streamer_username'].
(ii) Streamer(..., settings=...) keyword unpinned; only params[1]=="username" asserted. Verified `settings` present.
(iii) StreamerSettings kwarg-compat inferred from __slots__, but Task 3 does StreamerSettings(**merged).
__slots__ and __init__ params are independent declarations. Verified they currently agree.
Decision: STRENGTHEN NOW rather than accept residual risk. Task 2's sole purpose is drift detection for
Tasks 3-7; a tripwire that misses the two most-used seams fails at its one job, and the fix is ~10 lines
against the alternative of a silent runtime break during a later `git -C vendor/miner pull`.
Cost if wrong: contract test is slightly more brittle — it will now fail on benign upstream param renames
that we could have absorbed. That is the intended trade for a tripwire; a noisy tripwire beats a silent one.


---

### Task 2

Ruling: reviewer's ⚠️ item — Task 5's Interfaces line claims it Consumes CLIENT_ID/CLIENT_VERSION
"(Task 2)", but Task 2's brief never mentioned constants.py. Plan inconsistency I introduced.
Verified CLIENT_ID, CLIENT_VERSION and USER_AGENTS["Linux"]["FIREFOX"] all import and exist today.
Decision: fold the constants into Task 2's contract test now, since Task 5 imports them directly and
Task 5's own step-4 probe would otherwise be the first thing to discover a break.
Cost if wrong: none material — three extra assertions.


---

### Task 3

Ruling (pre-dispatch, from scan finding A): keep task order; T3 creates an inert placeholder
python/helpers/doorbell.py + helpers/__init__.py so run.py imports resolve and Step 6 is meaningful.
T4 replaces doorbell.py wholesale. Told T3 not to test the placeholder.
Cost if wrong: T4 overwrites a stub. Near-zero.


---

### Task 3

Ruling: implementer deviated from my brief twice; I verified BOTH against real source and both
deviations are correct — my brief was wrong:
(i) Brief imported LoggerSettings from TwitchChannelPointsMiner.classes.Settings. Verified: it is
actually defined at TwitchChannelPointsMiner/logger.py:68. FollowersOrder IS in classes/Settings.py
(classes/Settings.py:23), so only the one import was wrong. Accepting the correction.
(ii) pytest pythonpath widened from [".", "vendor/miner"] to [".", "python", "vendor/miner"]. Necessary
because python/__init__.py makes "." resolve miner_config as python.miner_config, not miner_config.
The brief's own test code does bare `from miner_config import ...`, so without this the brief is
self-contradictory. Accepting.
Cost if wrong: (i) none, verified. (ii) slightly broader import surface for tests; harmless.

---

### Task 4

Ruling: reviewer's Minor #1 — `self.dropped += 1` is a non-atomic increment mutated from
arbitrary miner threads without a lock. Verified it is a best-effort diagnostic counter with zero
control-flow or correctness role; reviewer stress-tested 10k concurrent increments x3 with no loss.
Decision: ACCEPT AS-IS, no lock. Adding synchronisation to the send() path to protect a diagnostic
counter would put a lock on the exact code path whose entire purpose is never blocking — the cure
is worse than the disease.
Cost if wrong: an under-count in a diagnostic counter nobody branches on. Negligible.


---

### Task 4

Ruling: reviewer's Minor #2 — my plan's Task 4 Interfaces line advertises `.pending()`, but the
plan's own code never defines it and grep confirms NO caller exists anywhere in tasks 1-20
(checked python/ and apps/). Plan-authoring error by me: a forward reference that never materialised.
Decision: STRIKE `.pending()` from the interface; do NOT implement it. YAGNI — inventing an unused
method to satisfy a stale doc line is worse than fixing the line. `flush()` already covers the
only real need (draining in tests). Correcting the plan text so later tasks aren't misled.
Cost if wrong: if Task 12 later wants queue depth, it adds a 2-line method then, with a real caller.


---

### Task 5

Ruling: third brief defect. My brief's tests used `monkeypatch.setattr(session.login, ...)`,
but TwitchLogin declares __slots__ (verified: vendor/miner/.../TwitchLogin.py:42), so instance
attribute patching raises "attribute is read-only". Implementer patched `type(session.login)` instead.
I checked the leakage risk this introduces (class-level patches can bleed across tests) and confirmed
it does NOT apply: they used pytest's `monkeypatch`, which auto-restores at teardown. Verified by
running the suite in both orderings and 8x repeated — 0 failures, no cross-test contamination.
Decision: ACCEPT. Implementation code was untouched; only the test mocking strategy changed.
Cost if wrong: none observed; if a future test patches the class WITHOUT monkeypatch it could leak,
so noting the pattern for Tasks 6/7.
NOTE for Tasks 6/7: stub TwitchLogin methods via monkeypatch on the CLASS, never the instance.


---

### Task 6

Ruling: implementer's concern #1 is a REAL design defect I introduced. `_is_auth_error()`
string-matches "401"/"unauthorized"/"authentication" against str(exc). Investigated the real
exception surface:
- requests.HTTPError -> "401 Client Error: Unauthorized for url: ..." — MATCHES. Good.
- GQLError subclasses (vendor/.../gql/Errors.py) -> RetryError.__str__ is
"GQL Operation 'X' failed all N attempts, errors:\n[...]" and GQLResponseErrors.__str__ is
"GQL Operation 'X' returned errors: [...]". Neither contains our markers except incidentally,
via the nested error list's repr. So auth failures arriving as GQLError are likely misclassified
as code:"GQL" instead of code:"AUTH".
Impact: the backend would treat an expired token as a transient GQL error, keep polling, and never
surface LOGIN_REQUIRED — exactly the failure mode the spec's error table says must prompt re-login.
Decision: DO NOT patch blindly on a guess about Twitch's error text. Instead make the detection
structural where we can be certain, and keep the string match as a fallback:
(a) treat requests.exceptions.HTTPError with response.status_code in (401, 403) as auth — exact.
(b) for GQLError, recurse into the nested `.errors` list and match against those reprs too, so a
401 buried in a RetryError is seen.
(c) keep the existing lowercase string fallback for anything else.
Also add a test proving a RetryError-wrapped 401 is classified AUTH, which is the case that is
currently broken.
Cost if wrong: if Twitch signals expiry some third way, we still misclassify and the user sees a
stale dashboard with an error banner rather than a login prompt — degraded, not dangerous, and
visible. Recorded as UNVERIFIED because only a real expired cookie settles it.


---

### Task 6

Ruling: reviewer found Important over-matching defect that MY fix instruction introduced.
I told them to add bare "403" to AUTH_MARKERS and to substring-match nested reprs, which multiplied
the collision surface. Verified three concrete false positives myself:
TimeoutError("Connection timed out after 40100ms")   -> AUTH  (contains "401")
RuntimeError("rate limited: retry-after=403")        -> AUTH  (contains "403")
RuntimeError("server error, request id 8401f")       -> AUTH  (contains "401")
A request id containing 8401f would log the user out. Spurious logout is as bad as never logging out.
Decision: replace bare-digit substring matching with word-boundary regex on HTTP status codes, and
keep the exact structural HTTPError/status check (which is the reliable path) plus the unambiguous
word markers. Specifically: match r"\b(401|403)\b" rather than "401" in text, keep "unauthorized"/
"authentication" as words. Structural check stays primary; text is fallback only.
Cost if wrong: a Twitch error phrased like "error401" (no boundary) is misclassified GQL and the user
sees a stale-data banner instead of a login prompt — the safer direction of the two failure modes.


---

### Task 6

Ruling: reviewer's Minor #2 (ExceptionContext.exception not contract-pinned) — ACCEPT AS-IS.
It is accessed via getattr(item, "exception", item) which degrades gracefully, ExceptionContext is not
one of the four named seams, and the implementer disclosed it. Pinning every incidental attribute
would make the contract test brittle without buying real protection.
Cost if wrong: if upstream renames it, auth detection silently falls back to text matching — degraded,
not broken, and the word-boundary fix above keeps that fallback sane.


---

### Task 6

Ruling: reviewer's Minor #3 is a process note about reading a report mid-write, not a code
defect. No action.

---

### Task 7

Ruling: fourth brief defect (mine). The brief's Step 3 implementation reads `login.client_id`
(lines 183, 202 of the brief) but its Step 1 `FakeLogin` fixture never defines that attribute, so
transcribing both verbatim fails all 7 tests with AttributeError rather than the predicted PASS.
Verified: impl python/helpers/login.py:29,48 reads it; fixture python/tests/test_login.py:29 now sets it.
Decision: ACCEPT the implementer's one-line fixture addition (self.client_id = "fake-client-id").
It changes the TEST DOUBLE only — the implementation file is byte-for-byte as specified, and reading
client_id off the login object is correct (TwitchLogin owns the real client id; hardcoding it in
login.py would duplicate upstream's constant).
Cost if wrong: none — a fake's attribute value is never asserted on, only passed through to the
recorded request, which the tests check by shape.


---

### Task 7

Ruling: reviewer's Important #1 is a REAL cross-process bug in MY brief. `expiresAt` is computed
as `time.monotonic() + expires_in` (python/helpers/login.py:25,36) and emitted over NDJSON to the Node
backend. time.monotonic()'s epoch is unspecified (typically time-since-boot) and is only comparable
within one process. Task 11's loginRunner.ts and Task 19's UI render a countdown from this value;
`expiresAt - Date.now()` across two processes yields nonsense.
Decision: FIX NOW — emit wall-clock `time.time() + expires_in` as epoch SECONDS for the wire value,
while keeping the monotonic clock for the internal polling deadline (monotonic is the correct choice
for measuring elapsed time — it is immune to NTP steps and DST). The two clocks serve different jobs;
the bug was using one value for both. Injected `now` stays monotonic so existing expiry tests hold.
Cost if wrong: if a later task expects milliseconds rather than seconds, the countdown is off by 1000x —
visible immediately and a one-line fix. Recording the unit here so Task 11's brief states it explicitly.


---

### Task 7

Ruling: reviewer's Important #2 — spec (design doc:184) sketches snake_case user_code/
verification_uri/expires_at; plan and delivered code use camelCase userCode/verificationUri/expiresAt.
Normally the spec is binding, but verified the plan is camelCase CONSISTENTLY at Task 7 (:1216,1398-1401),
Task 11 LoginProgress (:2340,2424), and Task 19 (:4497,4550) — and the spec's own mandated wire field
`lastUpdated` (design doc:260) is camelCase too. The snake_case sketch is an isolated slip in an
illustrative code block, not a considered interface decision.
Decision: KEEP camelCase. It matches the rest of both documents and the TypeScript consumers.
Cost if wrong: none — the producer and all consumers are inside this branch and agree.


---

### Task 7

Task 8 (pre-dispatch): Ruling: plan's Tech Stack says "Node 22" but the only node in this container is
v20.20.2 (/usr/local/bin/node); no Node 22 is installed and no `engines` field pins it in package.json
or apps/backend/package.json. Verified `pnpm test` passes green on v20 (vitest 3.2.7, smoke test OK).
Decision: PROCEED on Node 20 rather than installing Node 22 mid-run. Nothing in Tasks 8-20 needs a
Node-22-only API — better-sqlite3, Fastify 5, Zod 4 and Vitest 3 all support Node 20. Installing a
runtime the environment did not provide is a bigger, riskier change than the version gap it closes.
NOT adding an `engines` pin either, since that would fail the local install for no benefit.
Cost if wrong: if a later task reaches for a Node 22-only API (e.g. a stable built-in that landed in
22), it fails fast at test time and we install Node 22 then. Flagging to final review: the Dockerfile
(Task 20) should still pin its own Node version explicitly, and 22 there is fine — the container
build is independent of this dev environment.

---

### Task 8

Ruling: fifth brief defect (mine). Brief line 224/228 writes `raw as Record<string, never>`,
which does not compile under `strict: true` (verified set at tsconfig.base.json:6) — `never` as the
value type makes every property access an error. Implementer substituted `Record<string, unknown>`
with explicit casts at the use sites.
Decision: ACCEPT. `Record<string, never>` is simply wrong for "parsed JSON of unknown shape";
`unknown` is the correct type and forces the explicit narrowing that `never` would have skipped.
Runtime behaviour is identical and both suites pass.
Cost if wrong: none — a type annotation on already-validated data; Zod does the real checking.


---

### Task 8

Ruling: implementer asked whether `tsc` type-checking (beyond `pnpm test`) is the bar for TS
tasks. It is — vitest transpiles without full type-checking, so a type error can pass the test suite
and still break the build. The implementer ran `pnpm --filter @app/backend build` on its own
initiative and that is how it caught the defect above.
Decision: ADOPT as standing policy for Tasks 9-20 — every TypeScript task must pass a build/typecheck,
not just `pnpm test`. Adding to subsequent dispatch briefs.
Cost if wrong: a few extra seconds per task. Strictly cheaper than shipping a type error to Task 20's
Docker build, where it would surface far from its cause.


---

### Task 8

Ruling: reviewer found an Important blind spot in the parity test — MY brief's test, transcribed
faithfully. test_schema_parity.py extracts only the VALUES of TO_PYTHON (regex `:\s*"([a-z_]+)"`) and
compares them to ALLOWED_SETTINGS. It never checks TO_PYTHON's KEYS, and never checks BOOL_SETTINGS
(which actually drives settingsSchema, i.e. what the browser may send) against TO_PYTHON's keys.
Reviewer proved the gap with four mutations, restoring the tree after each:
- remove an entry            -> FAILS (good)
- reformat the declaration   -> FAILS loudly "TO_PYTHON map not found" (fails safe, acceptable)
- add colliding key legacyChat:"chat" alongside chat:"chat" -> SILENTLY PASSES (bad; the reverse map
in settingsFromPython resolves last-key-wins)
- rename claimDrops -> claimDropsTypo keeping "claim_drops" -> SILENTLY PASSES (bad; desyncs the TS
key from BOOL_SETTINGS, so the setting reaches Python untranslated via `?? k` or is dropped by
.strict() on round-trip)
I verified the regex and the BOOL_SETTINGS/settingsSchema wiring myself at schema.ts:4-27.
Decision: STRENGTHEN NOW, same reasoning as the Task 2 contract-test ruling. This test's ONE job is
drift detection across the language boundary, and 12 remaining tasks will trust it while touching
config. A tripwire that passes silently on the most likely drift (a rename) fails at its only job.
Fix: also assert TO_PYTHON's key set equals BOOL_SETTINGS + {pointsLimit, chat}, and assert no
duplicate Python values. Keep the fail-safe regex behaviour.
Cost if wrong: the parity test becomes sensitive to schema.ts formatting and will need updating when
a setting is legitimately added — which is exactly when a human should confirm both sides. Intended.


---

### Task 9

Ruling: SIXTH brief defect (mine), and the most consequential so far. My brief's sample
implementation dropped the protocol's `code` field on error responses: the message type at brief
line 143 omits `code` entirely, and line 155 does `reject(new Error(message.error ?? "helper error"))`.
That discards exactly the AUTH|GQL|BAD_REQUEST discriminator that Task 6 works hard to produce —
and that Tasks 13/15 must branch on to surface LOGIN_REQUIRED. Verified both lines in the brief myself.
Impact if shipped: an expired Twitch session would arrive at the backend as an untyped Error,
indistinguishable from a transient GQL failure — resurrecting the exact bug Task 6 spent two fix
rounds eliminating on the Python side, one layer up.
Decision: ACCEPT the implementer's fix — an exported NdjsonError class carrying `code`
(ndjsonClient.ts:14,24-30,45,94). Correct and minimal; typed via NdjsonErrorCode so Task 13/15 get
exhaustiveness checking rather than string comparison.
Cost if wrong: none — strictly more information preserved than the brief specified.


---

### Task 9

Ruling: implementer added 5 tests beyond the brief (chunk-splitting, multi-message-per-chunk,
out-of-order correlation, error-code propagation, double-stop). My brief named these as the real
production failure modes in prose but its own tests never exercised them — every brief test sent
whole lines, one message at a time, in order.
Decision: ACCEPT and keep. This is scope the brief implied and failed to deliver, not gold-plating:
stdout chunk boundaries are arbitrary, and a client that assumes one chunk == one message works in
every test and fails in production under load. Verified all 10 tests present and green.
Cost if wrong: a slightly larger test file. Trivially worth it.


---

### Task 9

Ruling: reviewer returned 1 Critical + 4 Important, all empirically demonstrated (20 scenarios,
7 scratch fixtures, tree left clean). I independently confirmed the Critical and read the code for the
rest. All are real; all enter the fix loop. None are plan-mandated — they are gaps my brief left open.
(1) CRITICAL: no child.on("error") listener (ndjsonClient.ts:64-72). Node throws on an unhandled
'error' event, so a bad `command` path (wrong venv / missing uv / bad PYTHON_BIN — the single most
likely misconfiguration) kills the ENTIRE BACKEND. I reproduced it under bare node v20.20.2:
"Unhandled 'error' event ... ENOENT", process exit code 1. Not a rejected promise — process death.
(2) IMPORTANT: `JSON.stringify({ id, op, ...params })` (:125) spreads params LAST, so a param named
id or op overwrites the envelope. Reviewer demonstrated request("lookup",{op:"hacked"}) executing
`hacked` and RESOLVING AS a successful lookup. Envelope must win.
(3) IMPORTANT: stop() awaits exit with no SIGKILL escalation (:136-140) — hangs forever on a helper
wedged in an uninterruptible read, leaking a Python process holding Twitch cookies.
(4) IMPORTANT: stop() is not final — request() calls ensure() without checking `stopped` (:114,130),
so a late call silently RESPAWNS the helper after shutdown. Reviewer verified it resolved normally.
(5) IMPORTANT: state.py:168 emits {"id": None, ...} on its bad-json path, but the client rejects any
non-number id (:86), so that response is dropped and the request stalls for the full timeout with
a generic message instead of the real BAD_REQUEST diagnostic. Verified state.py:167-169 myself.
Decision: FIX ALL FIVE. This is the backend's only channel to real miner state; (1) is a crash and
(2) is a silent wrong-answer, which is worse than a crash.
Cost if wrong: more surface in a file that was clean; each fix is small and independently tested.


---

### Task 10

Ruling: SEVENTH brief defect (mine) — and it was the Task 9 CRITICAL about to repeat verbatim.
I verified the brief contains ZERO `on("error"` occurrences (grep count 0), and its spawnOnce() set
state to RUNNING synchronously right after spawn() returned, before Node could report ENOENT or
confirm liveness. Shipped as written, a bad python path would have killed the whole backend AND the
supervisor would have reported RUNNING for a process that never started.
Decision: ACCEPT the implementer's fix — await Node's 'spawn'/'error' events before resolving start(),
with a child.on("error") handler (supervisor.ts:105,144). Verified present.
Cost if wrong: start() is marginally slower (one event-loop round trip). Trivial against a crash.
NOTE: this is the second brief in a row where I omitted the spawn-error listener. Any REMAINING task
that spawns a process must be dispatched with this lesson stated explicitly.


---

### Task 10

Ruling: implementer found a second, subtler defect — sending SIGTERM immediately after spawn
confirmation races the child's own signal-handler registration (fork/exec latency ~30-40ms exceeds a
JS tick), so the brief's "escalates to SIGKILL" test FALSELY PASSED in 1-4ms without ever exercising
SIGTERM-resistance. Same false-pass shape as Task 9's fixture bug, one layer earlier.
Decision: ACCEPT the 50ms startup-settle delay. Verified myself: the escalation test now runs 355ms
(not ~2ms), which is only reachable if SIGTERM is genuinely ignored and SIGKILL escalation fires.
Cost if wrong: 50ms added to each real miner start, and the constant is sized against a Node fixture
rather than the real Python miner — recorded as UNVERIFIED below.


---

### Task 10

Ruling: implementer verified the generation guard is load-bearing by MUTATION — removing it and
injecting a stale gen-1 exit after gen-2 was RUNNING corrupted state (RUNNING->CRASHED, livePids()
broken); with the guard, correctly ignored. Accepting; this is the cross-generation defect class I
warned about from Task 9, proven handled rather than assumed.


---

### Task 10

Ruling: STOP_GRACE_MS = 20_000 here vs Task 9's 2_000. Not an inconsistency — different
processes: Task 9 guards a thin NDJSON helper, this guards the full miner (heavier shutdown: closing
websockets, flushing state). Tests override via graceMs so suite runtime is unaffected. ACCEPT.
Cost if wrong: a wedged miner takes 20s to force-kill on shutdown. Acceptable; the alternative
(SIGKILLing a healthy-but-slow miner mid-write) risks corrupting its cookie/state files.


---

### Task 10

Ruling: reviewer returned 1 Critical + 2 Important + 4 Minor. I REPRODUCED THE CRITICAL MYSELF.
(1) CRITICAL — stop() is not final; a pending backoff timer resurrects a stopped miner.
terminate() (supervisor.ts:195-200) early-returns when `!child` and sets `intentionalStop = true`
only AFTER that return (:201). A miner that crashes past fastExit reaches scheduleRestart and
sleeps in backoff with child === null. An operator's stop() then takes the early return, so the
flag is never set, generation is never bumped, and the guard at :187 passes — the miner respawns.
My reproduction (isolated scratch test, long-uptime crash at 700ms > fastExit 300ms):
state while backing off: RUNNING | right after stop(): STOPPED | AFTER BACKOFF WINDOW: RUNNING
The app reports STOPPED, then silently flips to RUNNING with a live Twitch session the operator
explicitly killed. Same defect CLASS as Task 9 finding (4), one branch further in.
Note my first reproduction attempt used FAKE_MODE=instant and PASSED — that path is fastExit,
which returns CRASHED without scheduling a restart. The bug needs a post-fastExit crash. Recording
because it shows how narrowly this escapes a plausible test.
(2) IMPORTANT — restartCount never decays (:172-181,231); reset only by explicit restart(). A miner
that crashes once a week and recovers fine exhausts maxRestarts after 5 healthy multi-day runs and
parks in CRASHED permanently. Budget should bound RAPID loops, not lifetime crashes.
(3) IMPORTANT — start() resolves RUNNING for an already-dead process (:122-141): Node delivers 'exit'
AFTER the settle setTimeout, so a child dying in ~5-50ms is still announced RUNNING. Reviewer swept
DIE_AFTER=1 (correct CRASHED) vs 5/45 (both wrongly RUNNING first). Self-healing but the UI flashes
RUNNING and `await start()` reports false success.
ALSO FOUND BY ME during reproduction, not in the reviewer's list: state read RUNNING while the miner
was actually dead and backing off — onExit nulls child and calls scheduleRestart without setting any
interim state. Folding into fix (3): a crashed-and-backing-off miner must not report RUNNING.
Decision: FIX (1), (2), (3) + my state-during-backoff finding, and Minors 1, 2 and 4 (cheap, same file).
Cost if wrong: this is the control half of the app; leaving (1) means Stop is not trustworthy.


---

### Task 10

Ruling: reviewer answered my highest-value question — the 50ms settle is a TEST ARTIFACT, not a
production safety mechanism. stop() and start() both route through serialize(), so a stop() inside the
settle window QUEUES rather than racing; SIGTERM is never sent early or dropped (verified at 0ms and
10ms offsets, both ending STOPPED with zero live pids; 4 concurrent start() calls yield one process).
Decision: KEEP the 50ms (cheap insurance if the lock is refactored) but the code comment overstates its
role — have the implementer correct the comment rather than the constant. The earlier UNVERIFIED entry
about sizing it against the real Python miner is therefore LOW concern: nothing depends on it.


---

### Task 11

Ruling (pre-dispatch, recorded so it is not lost): the Task 11 brief types `expiresAt: number`
(brief lines 10, 94) with NO unit stated, and its fixtures use placeholder values (`expiresAt: 999`
at lines 18, 55). python/helpers/login.py emits epoch SECONDS (time.time() + expires_in); JS Date.now()
is epoch MILLISECONDS. A Task 11 implementer working from this brief alone would plausibly write
`expiresAt - Date.now()` and get a countdown wrong by a factor of 1000 — the exact bug Task 7's fix
round eliminated on the Python side.
Decision for whoever resumes: Task 11's dispatch MUST state the unit explicitly, and its tests must
use a realistic epoch-seconds value rather than the brief's placeholder 999, so a unit error is
visible in the test rather than hidden behind a magic number.
Cost if wrong: a visibly broken countdown; cheap to fix but embarrassing and easy to prevent.


---

### Task 10

Ruling: re-review found NEW Important defect N1 introduced BY fix (2). REPRODUCED BY ME.
supervisor.ts:232-236 zeroes restartCount whenever a single run exceeded `stability`, and does so
BEFORE scheduleRestart:241 reads it — so any miner whose runs exceed stabilityMs re-enters the
budget check at 0 forever and maxRestarts can NEVER be reached.
My reproduction (fastExit 200ms, stability 300ms, crash at 400ms, backoff 50ms, maxRestarts 2):
N1 RESULT: state=RUNNING restartCount=1   — after 5s of crashing every 400ms.
Expected CRASHED. Instead: unbounded slow crash loop, no operator signal. At production defaults
(stability 5min, maxRestarts 5) a miner with an expiring token or nightly OOM that dies every
5min 1s restarts forever.
The existing test asserts only `state !== "CRASHED"`, which passes for BOTH the intended decay and
this unbounded loop — so it cannot distinguish them. Re-reviewer instrumented 14 consecutive crashes:
restartCount was [0]*14 with maxRestarts 2; a control run with uptime BELOW stability correctly
reached CRASHED, confirming the cap only survives when runs stay under stabilityMs.
Decision: this is a REAL regression — fix (2) traded "budget never decays" for "budget never engages",
which is the worse failure (a stuck-CRASHED miner is visible; an infinite silent restart loop is not).
It must be fixed with a decay (restartCount - 1) or a crash-RATE window rather than a hard zero, and
its test must assert the cap still ENGAGES, not merely that state != CRASHED.
HOWEVER: the user has instructed me to stop after current work completes and dispatch nothing new.
A fix round is a new dispatch. PARKING N1 as the top item for whoever resumes, NOT fixing it now.
Cost of parking: Task 10 ships with a restart cap that does not engage for slow crash loops. Bounded —
no consumer exists yet (grep: zero MinerState consumers outside supervisor.ts), Task 15 is the first.
It MUST be fixed before the supervisor is wired to anything real.

---

### Task 10

Ruling: N1 (parked restart-cap regression) — I designed the fix myself rather than
re-dispatching the old shape, because BOTH shapes the previous session proposed are provably
broken. Traced by hand:
- hard reset (`restartCount = 0` after a stable run)  -> slow loop: budget resets every crash,
cap NEVER engages. This is the N1 bug.
- decay-by-1 (`restartCount = max(0, n-1)`)           -> slow loop: restore 1, consume 1 per
cycle, budget hovers at 1 forever, cap ALSO never engages. The previously suggested fix does
not fix the bug.
Root cause: any budget keyed on a per-run "was this run long enough" test is evadable by a loop
whose period is just over that threshold. The cap must be keyed on crash RATE, not per-run uptime.
DECIDED: sliding crash-rate window. Keep a list of crash timestamps; drop entries older than
crashWindowMs; if the count exceeds maxRestarts within the window -> CRASHED. Replace the
stabilityMs hard-reset entirely (crashWindowMs subsumes it: an unbroken clean stretch of one
window empties the list naturally).
Default crashWindowMs = 1h. Sizing: the fastest legitimate recovery run of 5 backoffs spans ~31s
(1+2+4+8+16), so 1h is ~100x clear of a healthy recovery; a nightly OOM (1 crash/day) never trips;
the re-reviewer's 5min-1s loop trips after 6 crashes (~30 min) with a real operator signal.
Spec grounding (design doc:166) says "after 5 consecutive failures, park in CRASHED" — the spec
never defines a stability window (my plan invented it), and a rate window is the reading of
"consecutive" that both engages for real loops and does not punish a miner that has run for weeks.
stabilityMs is dropped, not deprecated: ledger-verified zero MinerState/Supervisor consumers exist
outside supervisor.ts, and the plan's Task 10 Interfaces line never advertised it.
Cost if wrong: a miner crashing slower than 5/hour restarts forever without ever reaching CRASHED
(still visible via RESTARTING + log buffer + restartCount). Bounded and tunable by one constant.


---

### Task 12

Ruling: rewrite that test to use a real temp file — open, write, close, reopen, assert. Carrying
into the dispatch. Cost if wrong: none; strictly more coverage than the plan's version.


---

### Task 12

Ruling: spec:214 specifies `events(ts, type, streamer_id?)`; the plan's schema and its
recordEvent(type, ts) signature omit the streamer column entirely. Verified by grep that NO caller
anywhere in Tasks 13-20 ever passes a streamer to recordEvent (only sites: plan:2909, 3451) —
the field is optional in the spec's own notation and has zero consumers.
Decision: keep the plan's shape, do not add a speculative column. SQLite ALTER TABLE ADD COLUMN
with a NULL default is O(1) and does not rewrite rows, so this stays cheap to add later.
Cost if wrong: one trivial migration on the persisted volume if the UI ever wants per-streamer
event filtering. Flagging to the final review as a deliberate, spec-permitted deviation.


---

### Task 11

Ruling: all 3 implementer concerns accepted as-is. (a) CANCEL_GRACE_MS=5000 — no measurement
was mandated and the value mirrors supervisor.ts's documented pattern. (b) broadened "unexpected exit"
to any non-terminal stage — reviewer agrees it is arguably more correct than the brief's null/pending
check; kept, with the missing test recorded as a deferred minor rather than a fix round, since the
behaviour is strictly safer than the brief's. (c) fixture extension — original lines byte-for-byte
intact, additions strictly necessary to test 3 of the 5 corrections.
Cost if wrong: (b) could synthesize an error for a helper that legitimately exits mid-stage; no such
helper exists (login.py always reaches ok or error).

---

### Task 13

Ruling: the empty path must set lastUpdated (an empty list is fully up to date — there is nothing
pending, so stale=false is correct) and emit "change" if the list was previously non-empty. Requires
a test that removes the last streamer and asserts both the emit and the cleared snapshot.
Cost if wrong: none — strictly more correct than silently retaining a deleted streamer's numbers.


---

### Task 14

Ruling (CRITICAL — authentication bypass, reproduced by me, in MY plan text):
plan:3060-3068 authenticates allow-by-default: the onRequest hook does
`const url = request.url.split("?")[0]; ... if (!url.startsWith("/api/")) return;`
and only then checks the session cookie. The hook sees the RAW url while Fastify's router
percent-DECODES before matching, so a request to `/%61pi/config` skips the hook's guard and is
still routed to `/api/config`. I built a standalone Fastify probe using the plan's exact hook logic:
/api/config     -> 401 unauthorized      (correct)
/%61pi/config   -> 200 {"secret":"LEAKED"}  <-- BYPASS
/API/config     -> 404   //api/config -> 404   /api/./config -> 401
Every /api/* route — config, miner start/stop/restart, logs, streamer lookup — is reachable
unauthenticated by percent-encoding one character of the prefix. The plan's 6 auth tests all use
literal paths, so none of them can catch it.
Decision: invert to DENY-BY-DEFAULT. Authenticate every request except an explicit allowlist
(POST /api/session and the token-authenticated /internal/ doorbell), matching on the ROUTED path
rather than the raw URL. Deny-by-default also fails CLOSED for the doorbell bypass — an encoded
`/%69nternal/doorbell` gets denied rather than admitted. Required tests: the encoded-prefix probe
above, plus a test asserting an unknown/unrouted path is denied rather than silently allowed.
Cost if wrong: a deny-by-default hook can lock out a path someone forgot to allowlist — a visible,
immediate 401 in dev, versus a silent auth bypass shipped to a LAN-exposed box.


---

### Task 14

Ruling: `const sessions = new Set<string>()` (plan:3030) is MODULE-level, so every server
built in one process shares one session store — a token minted against one Fastify instance
authenticates another. Production runs a single server so this is latent there, but it makes the
tests interfere with each other and is a trap for Task 15/20's multi-instance tests.
Decision: move the session store into registerAuth's closure (per-instance). Cost if wrong: none.


---

### Task 14

Ruling: sessions never expire and are never evicted — no TTL, no logout, unbounded Set growth,
and a captured cookie is valid until process restart. Decision: give sessions an absolute TTL
(24h) with lazy eviction on lookup. Not in the spec, but "LAN only + single shared password"
is a reason for a bounded session, not an excuse for an unbounded one. Cost if wrong: an operator
is asked to re-enter the password once a day.


---

### Task 13

Ruling: staleness deviation ACCEPTED. Reviewer independently confirmed the brief's age-only
formula cannot pass the brief's own test (staleAfterMs=1000, clock advances 1, so `1 > 1000` is false
while the test asserts stale===true) — the implementer did not misread it. And on merits: given the
binding rule "never present stale numbers as current", an unconfirmed failure means we do not know
whether the held numbers are still true, so erring toward stale is correct rather than over-reporting.
Verified lastError is cleared on BOTH the success path and the correction-1 empty path, so stale
recovers and the empty path still yields stale:false. Cost if wrong: the UI shows a staleness banner
during a transient blip that age alone would have ridden out — conservative in the safe direction.

---

### Task 13

Ruling: reviewer's CRITICAL (doorbell event arriving during an in-flight refresh is silently
dropped) is REAL and is a NINTH defect in my plan text, not the implementer's work — the coalescing
code is the brief's Step 3 verbatim. Trace: ring()'s debounce callback nulls debounceTimer BEFORE
calling refresh(); a ring() arriving while a refresh is in flight therefore schedules a fresh timer,
and when that timer fires refresh() sees inFlight set and returns the STALE in-flight promise without
dispatching a new request. The new event's data is never fetched until an unrelated trigger. This
defeats the entire purpose of the doorbell (near-immediate updates) and degrades it to the 60s tick —
the exact failure the doorbell exists to prevent. Not caught because the one ring test bursts only
BEFORE the debounce fires. Entering fix round 1 rather than parking: Task 15 wires the doorbell route
to this service, so it is load-bearing for the next task but one.


---

### Task 14

Ruling: all 4 implementer concerns + the reviewer's latent footgun accepted as recorded, none
fixed here. (1) encapsulated-scope is REAL and Task 15's to honour — carried into its dispatch below,
with the two consequences the report understated: the POST /internal/doorbell allowlist entry becomes
dead code, and the three "denies an unrouted path" tests exercise a topology production will not have.
(2) Task 20's not-found handler repeats the raw-URL mistake — cosmetic (index.html is public either
way), carried to Task 20. (3) reply.hijack() — real latent defect, one-line, belongs with Task 15's
wiring. (4) no secure cookie flag — correct for LAN plain HTTP; secure would break login outright.
Cost if wrong: (3) is the only one with runtime consequence and it is contained to the SSE route.

---

### Task 15

Ruling: reviewer confirms I WAS WRONG on correction 3's premise and the implementer was right
(better-sqlite3 11.10.0 probed: undefined/NaN/""/null all bind and return [], no throw; only a plain
object throws, and that is unreachable through Fastify's querystring parser). Validation stands.

---

### Task 15

Ruling: IMPORTANT #1 is a real first-run breakage and goes into the fix loop. The
TWITCH_USERNAME accessor fixes LoginRunner (spawned per login) but NOT the state helper, which
index.ts spawns once at boot with username "" and never respawns; _session.py freezes cookies_file at
build time and reload_cookies() re-reads that same frozen path. So a user who logs in successfully on
a fresh install has a state helper reading cookies/.pkl until the backend is restarted — the app
looks logged out forever despite a good login. Fix: stop the helper on login success and on config
apply so the next request respawns it with the current username.

---

### Task 15

Ruling: IMPORTANT #2 (python/helpers/state.py:13) is a real defect in TASK 6's file, and it
goes into the same fix round rather than being deferred to a Python task that no longer exists.
Reviewer executed it: `TWITCH_USERNAME=alex .venv/bin/python python/helpers/state.py` gives
ModuleNotFoundError at line 13; with PYTHONPATH set it answers correctly. run.py and login.py hoist
their sys.path.insert to module scope; state.py does it inside main() and passes pytest ONLY because
pyproject.toml sets pythonpath — the test suite was hiding a file that cannot be run the way
production runs it. Keep index.ts's PYTHONPATH belt-and-braces, but fix the source.
Cost if wrong: none — hoisting an import path is what its two sibling helpers already do.

---

### Task 16

Ruling: TENTH plan defect (mine), surfaced by the implementer's concern 1. apps/frontend's
build script is `tsc -b && vite build`, but `apps/frontend/tsconfig.json` IS NEVER CREATED ANYWHERE
IN THE PLAN — grep across all 20 tasks finds no frontend tsconfig. Task 19 creates index.html/
main.tsx/app.tsx but no tsconfig either. Consequence: no frontend TypeScript is type-checked at all,
by anyone, for the whole branch — the same class of hole as a test package that never runs, which
this branch has already produced twice.
Decision: Task 16 owns it — it is the package-scaffold task and a tsconfig is scaffolding. Sending a
fix round now rather than after a review, since the defect is mine and already fully characterised;
the task review then covers the combined result. `vite build` will still fail until Task 19 supplies
index.html — accepted and expected per ruling C, so Tasks 17/18 gate on
`pnpm --filter @app/backend build` plus the frontend's own `tsc -b` instead of root `pnpm build`.
Cost if wrong: if Task 19 or 20 wants different compiler options it edits one file it would
otherwise have had to create from nothing.

---

### Task 16

Ruling: concern 2 (window.matchMedia polyfill added to test-setup.ts, not in the brief)
ACCEPTED. jsdom lacks matchMedia and Mantine's provider needs it on mount, so without it all four
PasswordGate tests fail regardless of implementation correctness. Additive and guarded.

---

### Task 16

Ruling: concerns 1, 3, 4 accepted (React types genuinely required for JSX; ESNext/bundler
override matches Vite's own template and loosens no strictness, strict:true still inherited; root
pnpm build's failure now confined to vite build's missing index.html, which is Task 19's).

---

### Task 17

Ruling: both get error handling that surfaces the server's message, with tests for the thrown-error
path and the failed-initial-load path. Cost if wrong: none — strictly more feedback than silence.

---

### Task 18

Ruling (my plan's defect, and the most consequential of the frontend tasks): useLiveState
trusts the SERVER's `stale` flag and never derives staleness locally. `stale` is computed inside a
snapshot at the moment the server builds it, and it only reaches the browser when a frame arrives.
So if the SSE connection dies — or the backend stops refreshing — the last snapshot the browser
holds keeps `stale: false` FOREVER, and the dashboard presents arbitrarily old point totals as
current. That is precisely what "Staleness is mandatory. Every state payload carries lastUpdated;
the UI must never present stale numbers as current" exists to forbid, and the failure mode is the
silent one: a frozen dashboard looks identical to a healthy one.
The brief's test cannot catch it — it stubs `stale: true` from the server and asserts the badge
renders, so it only ever tests the path where the server already told the truth.
Decision: the client must ALSO derive staleness from the age of `lastUpdated` against a ticking
clock, and show stale when EITHER the server says so or the local age exceeds the threshold.
Cost if wrong: a badge that flips to stale during a long legitimate gap between refreshes — visible
and conservative, versus silently showing week-old balances as live.

---

### Task 18

Ruling: `connected` is set true only when a `state` frame arrives and is never set false.
It stays false for up to the 60s refresh interval after a healthy connect, then stays true forever
once the stream drops. A connection indicator that cannot go false is worse than none. Decision:
drive it from EventSource's open/error events (it auto-reconnects, so open fires again).

---

### Task 18

Ruling: the initial REST load does `.catch(() => undefined)` — the same silent-swallow class
I corrected in Task 17. A failed first load leaves the dashboard blank with no explanation.
Decision: surface it.

---

### Task 19

Ruling: surface the error following the established Streamers/Dashboard pattern, and add a Logs test.

---

### Task 20

Ruling: deliver every artifact as specified (Dockerfile, compose.yaml, .dockerignore, README.md,
scripts/smoke.sh, and the server.ts static-serving change), but the implementer is forbidden from
claiming the smoke test passed. Instead it must (a) verify what is verifiable without Docker —
`bash -n` on the script, and an in-process equivalent of the smoke test's assertions driven through
buildServer + fastify inject, which covers the static serving, the notFound behaviour and the
session flow for real; and (b) state plainly in the report that the container build and the
container-level smoke run are UNVERIFIED here, and exactly which assertions were therefore never
executed. Cost if wrong: the image may not build on a machine that has Docker; that is a
first-run-on-real-hardware failure, visible immediately, and cheaper than a fabricated green tick.

---

### Task 20

Ruling: fix the notFound handler's raw-URL check (`request.url.startsWith("/api/")`,
brief line 22) — this is the Task 14 concern 2 item, the same class as the auth bypass I reproduced.
It is NOT a bypass here (index.html is public either way, so the consequence is only that
/%61pi/nope returns the SPA instead of a JSON 404), but a 404 handler runs precisely when no route
matched, so routeOptions.url is undefined and the raw path is all there is — the fix is to decode
the path before testing it, not to reach for the matched route. Cost if wrong: an API client gets
an HTML body instead of JSON for a mistyped encoded path.

---

### Final review

Ruling: C1 (fresh install cannot be configured through the UI) is REAL and is the single worst
defect on the branch — it defeats the project's entire purpose. DEFAULT_CONFIG.username is "",
usernameSchema requires {4,25}, so what loadConfig RETURNS is not something configSchema ACCEPTS;
no screen renders a username field; and the server never persists the username it already receives
in the stage:"ok" login progress. Probed: GET /api/config then PUT it back with one streamer added
returns 400 and config.json is never created. The README's documented first run is unreachable and
the only way in is hand-writing /data/config.json — the exact hand-editing this project exists to
remove. Into the fix wave. This is also the sharpest example of the branch's recurring failure: a
145-test green suite with no GET-then-PUT round trip using the DEFAULT config as the fixture.

---

### Final review

Ruling: C2 (unhandled EPIPE kills the backend) is REAL. ensure() reuses the child while
exitCode/signalCode are still null — the whole window between OS death and Node's exit event — then
writes to a stdin with no error listener. Reproduced against the real NdjsonClient: process dead,
and because it bypasses the SIGTERM handler the miner and login helper are ORPHANED. Note the
ledger's own L497 had marked this "safe on Node 20" — that earlier verification covered only the
post-ENOENT path where this.child is already null. A deferred item that was wrong. Into the wave.

---

### Final review

Ruling: I3 (LOGIN_REQUIRED never surfaced), I4 (app.close() hangs forever while a browser holds
the SSE stream, so every deploy is a SIGKILL), I5 (cold boot renders a confident "0" for 60s) all go
into the wave. I4 and I5 are one-liners; I3 is the difference between an expired token being
recoverable and being a mystery.

---

### Final review

Ruling: I6 (followers enabled -> dashboard shows none of them; and state.py does serial GQL
round trips instead of the spec's post_gql_request_batch, capping the useful list at ~30-60
streamers) is DEFERRED, not fixed. It is a feature gap plus a performance rework, not a defect in
what was built, and it needs a product decision about what the dashboard should show for followed
channels. Surfacing to my human partner instead. Cost if wrong: a user who enables the followers
toggle sees a dashboard that omits exactly what they turned on.

---

### Final review

Ruling: I7 (spec features absent — points-over-time chart, activity feed, drag-to-reorder,
per-streamer settings drawer, virtualized log view; GET /api/history is implemented and called by
nothing) is DEFERRED and surfaced. These were never in any of the plan's 20 tasks, so this is a
plan-vs-spec de-scope that predates execution. It is my human partner's call whether the de-scope
was intended, not mine to quietly close. Cost if wrong: the branch ships without visualisations the
design doc describes, and a live /api/history endpoint no client uses.

---

### Final review

Ruling: of the reviewer's three "worth five minutes" items, all three go into the wave
(killTimer orphan + its missing test, the silently dropped {id:null, ok:true}, and the tsconfig that
excludes test files from typechecking) — with an instruction to STOP and report if enabling test
typechecking surfaces more than a handful of errors, rather than half-fixing 20 tasks of tests.
