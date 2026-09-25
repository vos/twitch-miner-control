import { api } from "./client.js";

export interface KindInfo {
  kind: string;
  group: string;
  label: string;
  description: string;
  defaultOn: boolean;
}

export interface NotifyConfig {
  vapidPublicKey: string;
  groups: Array<{ id: string; label: string }>;
  catalogue: KindInfo[];
}

/** Mirrors prefsSchema in apps/backend/src/notify/prefs.ts. */
export interface Prefs {
  kinds: Partial<Record<string, boolean>>;
  streamers: "all" | string[];
  quietHours: { from: string; to: string; allowHealth: boolean } | null;
  timeZone: string;
  digestAt: string;
}

export interface Destination {
  id: string;
  channel: "webpush";
  label: string;
  endpoint: string | null;
  prefs: Prefs;
  enabled: boolean;
  createdTs: number;
  lastOkTs: number | null;
  lastError: string | null;
  lastErrorTs: number | null;
}

export type DestinationPatch = { label?: string; enabled?: boolean; prefs?: Prefs };

export interface InboxItem {
  id: number;
  ts: number;
  kind: string;
  title: string;
  body: string;
  streamer: string | null;
  link: string;
}

export const notifyApi = {
  config: () => api.get<NotifyConfig>("/api/notify/config"),
  destinations: () => api.get<{ destinations: Destination[] }>("/api/notify/destinations"),
  register: (body: {
    subscription: PushSubscriptionJSON;
    label: string;
    timeZone: string;
    previousEndpoint?: string;
  }) => api.post<{ destination: Destination }>("/api/notify/destinations", body),
  update: (id: string, patch: DestinationPatch) =>
    api.put<{ destination: Destination }>(`/api/notify/destinations/${encodeURIComponent(id)}`, patch),
  remove: (id: string) =>
    api.post<{ ok: true }>(`/api/notify/destinations/${encodeURIComponent(id)}/remove`),
  test: (id: string) =>
    api.post<{ ok: boolean; error?: string }>(`/api/notify/destinations/${encodeURIComponent(id)}/test`),
  inbox: (before?: number) =>
    api.get<{ items?: InboxItem[] }>(`/api/notify/inbox${before === undefined ? "" : `?before=${before}`}`),
  removeInbox: (id: number) => api.post<{ ok: true }>(`/api/notify/inbox/${id}/remove`),
  clearInbox: () => api.post<{ ok: true; removed: number }>("/api/notify/inbox/clear"),
};
