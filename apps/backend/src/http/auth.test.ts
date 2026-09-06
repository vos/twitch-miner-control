import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, expect, test } from "vitest";
import { registerAuth } from "./auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Counts how many times a protected handler actually ran. */
let handlerHits = 0;

beforeEach(() => {
  handlerHits = 0;
});

async function app(password = "hunter2", now?: () => number) {
  const instance = Fastify();
  await registerAuth(instance, { password, now });
  instance.get("/api/protected", async () => {
    handlerHits += 1;
    return { ok: true, secret: "LEAKED" };
  });
  return instance;
}

async function login(instance: FastifyInstance, password = "hunter2") {
  const res = await instance.inject({
    method: "POST",
    url: "/api/session",
    payload: { password },
  });
  return res.cookies[0].value;
}

// --- Baseline behaviour ------------------------------------------------

test("rejects an unauthenticated request", async () => {
  const res = await (await app()).inject({ method: "GET", url: "/api/protected" });
  expect(res.statusCode).toBe(401);
});

test("rejects the wrong password", async () => {
  const res = await (await app()).inject({
    method: "POST", url: "/api/session", payload: { password: "wrong" },
  });
  expect(res.statusCode).toBe(401);
});

test("issues a session cookie for the right password", async () => {
  const res = await (await app()).inject({
    method: "POST", url: "/api/session", payload: { password: "hunter2" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.cookies[0].name).toBe("session");
  expect(res.cookies[0].httpOnly).toBe(true);
});

test("accepts a protected request with a valid session cookie", async () => {
  const instance = await app();
  const res = await instance.inject({
    method: "GET", url: "/api/protected",
    cookies: { session: await login(instance) },
  });
  expect(res.statusCode).toBe(200);
});

test("rejects a forged session cookie", async () => {
  const res = await (await app()).inject({
    method: "GET", url: "/api/protected", cookies: { session: "made-up" },
  });
  expect(res.statusCode).toBe(401);
});

test("does not require auth for the internal doorbell path", async () => {
  const instance = await app();
  instance.post("/internal/doorbell", async () => ({ ok: true }));
  const res = await instance.inject({ method: "POST", url: "/internal/doorbell" });
  expect(res.statusCode).toBe(200);
});

// --- Deny by default: percent-encoding must not route around the hook ---

test("denies a percent-encoded spelling of a protected path", async () => {
  // `/%61pi/protected` percent-decodes to `/api/protected`, so Fastify routes
  // it straight to the protected handler. A hook that tests the raw URL for an
  // `/api/` prefix lets this through unauthenticated.
  const instance = await app();
  const res = await instance.inject({ method: "GET", url: "/%61pi/protected" });
  expect(res.statusCode).toBe(401);
  expect(handlerHits).toBe(0);
  expect(res.body).not.toContain("LEAKED");
});

test("still serves a percent-encoded path to an authenticated caller", async () => {
  const instance = await app();
  const res = await instance.inject({
    method: "GET", url: "/%61pi/protected",
    cookies: { session: await login(instance) },
  });
  expect(res.statusCode).toBe(200);
  expect(handlerHits).toBe(1);
});

test("denies a percent-encoded spelling of the doorbell path", async () => {
  const instance = await app();
  let doorbellHits = 0;
  instance.post("/internal/doorbell", async () => {
    doorbellHits += 1;
    return { ok: true };
  });
  const res = await instance.inject({ method: "POST", url: "/%69nternal/doorbell" });
  expect(res.statusCode).toBe(401);
  expect(doorbellHits).toBe(0);
});

test("denies an unrouted api path rather than letting it fall through", async () => {
  const res = await (await app()).inject({ method: "GET", url: "/api/nonexistent" });
  expect(res.statusCode).toBe(401);
});

test("denies an unrouted non-api path rather than letting it fall through", async () => {
  const res = await (await app()).inject({ method: "GET", url: "/nonexistent" });
  expect(res.statusCode).toBe(401);
});

test("denies an unauthenticated write to a non-api route", async () => {
  const instance = await app();
  let writes = 0;
  instance.post("/danger", async () => {
    writes += 1;
    return { ok: true };
  });
  const res = await instance.inject({ method: "POST", url: "/danger" });
  expect(res.statusCode).toBe(401);
  expect(writes).toBe(0);
});

// --- Static assets are public on purpose (Task 20 mounts the SPA on `/*`) ---

test("serves wildcard-mounted static assets without a session", async () => {
  const instance = await app();
  instance.get("/*", async () => "bundle");
  const res = await instance.inject({ method: "GET", url: "/assets/app.js" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe("bundle");
});

test("does not extend the static allowance to non-GET verbs", async () => {
  const instance = await app();
  let uploads = 0;
  instance.post("/*", async () => {
    uploads += 1;
    return { ok: true };
  });
  const res = await instance.inject({ method: "POST", url: "/assets/app.js" });
  expect(res.statusCode).toBe(401);
  expect(uploads).toBe(0);
});

// --- Session lifetime ---------------------------------------------------

test("sets the cookie lifetime to match the 24 hour session TTL", async () => {
  const res = await (await app()).inject({
    method: "POST", url: "/api/session", payload: { password: "hunter2" },
  });
  expect(res.cookies[0].maxAge).toBe(DAY_MS / 1000);
});

test("accepts a session just before it expires", async () => {
  let clock = 1_700_000_000_000;
  const instance = await app("hunter2", () => clock);
  const session = await login(instance);
  clock += DAY_MS - 1;
  const res = await instance.inject({
    method: "GET", url: "/api/protected", cookies: { session },
  });
  expect(res.statusCode).toBe(200);
});

test("rejects a session once its 24 hour lifetime has elapsed", async () => {
  let clock = 1_700_000_000_000;
  const instance = await app("hunter2", () => clock);
  const session = await login(instance);
  clock += DAY_MS + 1;
  const res = await instance.inject({
    method: "GET", url: "/api/protected", cookies: { session },
  });
  expect(res.statusCode).toBe(401);
  expect(handlerHits).toBe(0);
});

// --- Session isolation --------------------------------------------------

test("does not accept a session minted by a different server instance", async () => {
  const first = await app();
  const second = await app();
  const res = await second.inject({
    method: "GET", url: "/api/protected",
    cookies: { session: await login(first) },
  });
  expect(res.statusCode).toBe(401);
});

// --- Logout -------------------------------------------------------------

test("logout revokes the token it was called with", async () => {
  const instance = await app();
  const session = await login(instance);
  const out = await instance.inject({
    method: "POST", url: "/api/session/logout", cookies: { session },
  });
  expect(out.statusCode).toBe(200);
  const res = await instance.inject({
    method: "GET", url: "/api/protected", cookies: { session },
  });
  expect(res.statusCode).toBe(401);
  expect(handlerHits).toBe(0);
});

test("logout clears the session cookie", async () => {
  const instance = await app();
  const res = await instance.inject({
    method: "POST", url: "/api/session/logout",
    cookies: { session: await login(instance) },
  });
  const cleared = res.cookies.find((c) => c.name === "session");
  expect(cleared?.value).toBe("");
});

test("logout needs a session of its own", async () => {
  const res = await (await app()).inject({ method: "POST", url: "/api/session/logout" });
  expect(res.statusCode).toBe(401);
});

test("logout leaves other sessions working", async () => {
  const instance = await app();
  const mine = await login(instance);
  const theirs = await login(instance);
  await instance.inject({
    method: "POST", url: "/api/session/logout", cookies: { session: mine },
  });
  const res = await instance.inject({
    method: "GET", url: "/api/protected", cookies: { session: theirs },
  });
  expect(res.statusCode).toBe(200);
});
