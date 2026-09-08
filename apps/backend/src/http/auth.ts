import { randomBytes, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { LoginLimiter } from "./loginLimiter.js";

/** Absolute session lifetime. A captured cookie stops working after this. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface AuthOptions {
  password: string;
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Sets `Secure` on the session cookie. Off by default because the
   * documented deployment is plain HTTP on a LAN, where the browser would
   * silently drop a Secure cookie. See config/envFlag.ts.
   */
  secureCookie?: boolean;
}

/**
 * Endpoints reachable without a session, as `METHOD /matched/route`.
 *
 * `/api/session` is the login exchange itself, and the doorbell carries its
 * own shared token which the route checks (Task 15) — a session cookie would
 * be useless there because the caller is the miner subprocess, not a browser.
 * Nothing else belongs here: this list is the whole of the public API.
 */
const PUBLIC_ENDPOINTS = new Set(["POST /api/session", "POST /internal/doorbell"]);

/**
 * Route patterns that serve the built frontend (Task 20 mounts `@fastify/static`
 * on a `/*` wildcard). These stay public deliberately: a browser with no session
 * still has to download the bundle to render the login form, so locking them
 * would make logging in impossible. Only the static build is mounted there, and
 * only safe verbs are allowed through — every API route is a more specific match
 * and so keeps its session check. If a wildcard is ever used to mount anything
 * other than public frontend assets, this allowance has to be revisited.
 */
const PUBLIC_STATIC_ROUTES = new Set(["/*", "/"]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * The address the login limiter counts against.
 *
 * This is `request.ip`, which is the socket's peer address unless Fastify was
 * built with `trustProxy`, in which case it is the address that option told
 * Fastify to believe from `X-Forwarded-For`.
 *
 * Deliberately not read from the header directly. A spoofable key is worse
 * than no key at all: an attacker who picks a fresh `X-Forwarded-For` per
 * request gets a fresh bucket every time and never trips the limit, while the
 * operator sees a limiter in the code and believes they are covered. Honoring
 * the header is therefore a decision made once, at server construction, by
 * someone who knows a proxy is actually in front -- see TRUST_PROXY in
 * .env.example.
 *
 * Without a proxy every request already carries a real peer address, so the
 * default path needs no header at all.
 */
function keyFor(request: FastifyRequest): string {
  return request.ip;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Decides whether a request may skip the session check.
 *
 * Deny by default: anything not explicitly allowlisted here needs a session.
 *
 * The decision is made on `routeOptions.url` — the route pattern find-my-way
 * matched *after* it percent-decoded the request target — and never on the raw
 * request line. Testing the raw URL is exploitable: `/%61pi/config` decodes to
 * `/api/config` and reaches that handler, but does not start with `/api/`, so a
 * raw-prefix rule waves it through unauthenticated.
 *
 * An unrouted request has no matched route, so it is denied rather than
 * silently allowed.
 *
 * For the two public endpoints the raw path must *also* match literally, so an
 * encoded spelling such as `/%69nternal/doorbell` fails closed instead of being
 * admitted through the allowlist.
 */
function isPublic(request: FastifyRequest): boolean {
  const matched = request.routeOptions?.url;
  if (matched === undefined) return false;
  if (SAFE_METHODS.has(request.method) && PUBLIC_STATIC_ROUTES.has(matched)) {
    return true;
  }
  const rawPath = request.url.split("?")[0];
  if (rawPath !== matched) return false;
  return PUBLIC_ENDPOINTS.has(`${request.method} ${matched}`);
}

export async function registerAuth(
  app: FastifyInstance,
  opts: AuthOptions,
): Promise<void> {
  const now = opts.now ?? Date.now;
  // Owned by this registration, not the module, so a token minted against one
  // server instance cannot authenticate another in the same process.
  const sessions = new Map<string, number>();
  const limiter = new LoginLimiter(now);

  function isLive(token: string): boolean {
    const expiresAt = sessions.get(token);
    if (expiresAt === undefined) return false;
    // Lazy eviction: a timer would hold the event loop open for the process
    // lifetime just to drop a handful of strings.
    if (now() >= expiresAt) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  await app.register(cookie);

  app.post("/api/session", async (request, reply) => {
    const key = keyFor(request);
    const retryAfter = limiter.retryAfter(key);
    if (retryAfter > 0) {
      // 429 rather than 401: the caller is being told to stop, not that this
      // particular password was wrong. Answering 401 here would leak whether
      // a guess landed, which is the one bit a locked-out guesser wants.
      return reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .send({ error: "too many attempts" });
    }
    const body = request.body as { password?: string } | undefined;
    if (!body?.password || !sameSecret(body.password, opts.password)) {
      limiter.fail(key);
      return reply.code(401).send({ error: "invalid password" });
    }
    limiter.succeed(key);
    const issuedAt = now();
    // Sweep on mint so abandoned tokens cannot accumulate unbounded.
    for (const [token, expiresAt] of sessions) {
      if (issuedAt >= expiresAt) sessions.delete(token);
    }
    const token = randomBytes(32).toString("hex");
    sessions.set(token, issuedAt + SESSION_TTL_MS);
    return reply
      .setCookie("session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: opts.secureCookie ?? false,
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      })
      .send({ ok: true });
  });

  /**
   * Drops the caller's token server-side, then clears the cookie.
   *
   * Deliberately *not* public: it runs behind the session check, so it can
   * only ever revoke the token the caller already holds. Forgetting the
   * token is the part that matters -- expiring the cookie alone would leave
   * a captured value working for the rest of its 24h TTL.
   */
  app.post("/api/session/logout", async (request, reply) => {
    const token = request.cookies?.session;
    if (token) sessions.delete(token);
    return reply.clearCookie("session", { path: "/" }).send({ ok: true });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (isPublic(request)) return;
    const token = request.cookies?.session;
    if (!token || !isLive(token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
}
