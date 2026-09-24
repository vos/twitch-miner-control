import { onNotificationClick, onPush, type SwNotification, type SwScope } from "./handlers.js";

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushEvent extends ExtendableEvent {
  data: { text(): string } | null;
}
interface NotificationEvent extends ExtendableEvent {
  notification: SwNotification;
  action: string;
}
interface WorkerScope extends SwScope {
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: SwScope["clients"] & { claim(): Promise<void> };
}

// `self` is typed for a page here; in the built worker it is the
// ServiceWorkerGlobalScope this interface describes.
const scope = self as unknown as WorkerScope;

// A new version takes over at once rather than waiting for every tab to close.
scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));
scope.addEventListener("push", (event) => event.waitUntil(onPush(scope, event.data?.text() ?? null)));
scope.addEventListener("notificationclick", (event) =>
  event.waitUntil(onNotificationClick(scope, event.notification, event.action)));
