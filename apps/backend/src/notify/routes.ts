import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NULL_LOG, type AppLog } from "../appLog/port.js";
import { COMPONENT, EVENT } from "../appLog/types.js";
import { GROUPS, LISTED, NOTIFY_KIND } from "./catalogue.js";
import type { Notifier } from "./notifier.js";
import { isTimeZone, prefsSchema } from "./prefs.js";
import type { Destination, NotifyStore } from "./store.js";

export interface NotifyRouteDeps {
  store: NotifyStore;
  notifier: Pick<Notifier, "sendTo" | "onInbox">;
  vapidPublicKey: string;
  /** Carries out a notification action. False when the token is unknown, used or expired. */
  redeemAction: (token: string) => boolean;
  now?: () => number;
}

const https = z.string().max(2048).refine((v) => v.startsWith("https://"), "must be an https URL");

const registerSchema = z.object({
  subscription: z.object({
    endpoint: https,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  }),
  label: z.string().trim().min(1).max(60),
  timeZone: z.string().refine(isTimeZone, "unknown time zone"),
  previousEndpoint: z.string().max(2048).optional(),
}).strict();

const updateSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  prefs: prefsSchema.optional(),
}).strict();

const actionSchema = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/** A destination as the API shows it: the subscription's keys stay on the server. */
export function publicDestination(destination: Destination): Omit<Destination, "subscription"> {
  const { subscription: _subscription, ...rest } = destination;
  return rest;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? "invalid request" : `${issue.path.join(".")}: ${issue.message}`;
}

export function registerNotifyRoutes(
  app: FastifyInstance,
  deps: NotifyRouteDeps & { log?: AppLog },
): void {
  const log = (deps.log ?? NULL_LOG).child({ component: COMPONENT.NOTIFY });
  const now = deps.now ?? Date.now;

  app.get("/api/notify/config", async () => ({
    vapidPublicKey: deps.vapidPublicKey,
    groups: GROUPS,
    catalogue: LISTED.map(({ kind, group, label, description, defaultOn }) => ({
      kind, group, label, description, defaultOn,
    })),
  }));

  app.get("/api/notify/destinations", async () => ({
    destinations: deps.store.list().map(publicDestination),
  }));

  app.post("/api/notify/destinations", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { destination, created } = deps.store.upsertWebPush({ ...parsed.data, now: now() });
    if (created) {
      log.info({
        type: EVENT.NOTIFY_DESTINATION_ADDED,
        msg: `notifications turned on for "${destination.label}"`,
        destinationId: destination.id,
        label: destination.label,
      });
    }
    return { destination: publicDestination(destination) };
  });

  app.put("/api/notify/destinations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const destination = deps.store.update(id, parsed.data);
    if (destination === null) return reply.code(404).send({ error: "no such destination" });
    return { destination: publicDestination(destination) };
  });

  app.post("/api/notify/destinations/:id/remove", async (request, reply) => {
    const { id } = request.params as { id: string };
    const destination = deps.store.get(id);
    if (destination === null || !deps.store.remove(id)) {
      return reply.code(404).send({ error: "no such destination" });
    }
    log.info({
      type: EVENT.NOTIFY_DESTINATION_REMOVED,
      msg: `notifications turned off for "${destination.label}"`,
      destinationId: id,
      label: destination.label,
    });
    return { ok: true };
  });

  app.post("/api/notify/destinations/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };
    const destination = deps.store.get(id);
    if (destination === null) return reply.code(404).send({ error: "no such destination" });
    const result = await deps.notifier.sendTo(destination, {
      kind: NOTIFY_KIND.TEST,
      title: "Test notification",
      body: `Notifications work on "${destination.label}".`,
      ts: now(),
      link: "/?open=notifications",
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });

  app.get("/api/notify/inbox", async (request) => {
    const query = request.query as { before?: string; limit?: string };
    const before = Number(query.before);
    const limit = Number(query.limit);
    return {
      items: deps.store.inbox(
        Number.isInteger(before) && before > 0 ? before : null,
        Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
      ),
    };
  });

  // Public: see PUBLIC_ENDPOINTS in http/auth.ts. The token is the credential.
  app.post("/api/notify/action", async (request, reply) => {
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "token required" });
    if (!deps.redeemAction(parsed.data.token)) {
      return reply.code(404).send({ error: "this action is no longer available" });
    }
    return { ok: true };
  });
}
