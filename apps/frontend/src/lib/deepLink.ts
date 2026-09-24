import type { ScreenParams } from "./screenIntent.js";

/**
 * Where a notification points inside the app: `/?open=<screen>&...`.
 * The screen name is checked by the shell, which knows which exist.
 */
export interface LinkTarget {
  screen: string;
  params?: ScreenParams;
  /** Opens that streamer's detail dialog over the screen. */
  streamer?: string;
}

export function isExternal(link: string): boolean {
  return /^https?:\/\//i.test(link);
}

export function parseLink(link: string): LinkTarget | null {
  if (isExternal(link)) return null;
  let url: URL;
  try {
    url = new URL(link, "http://app.invalid");
  } catch {
    return null;
  }
  const screen = url.searchParams.get("open");
  if (!screen) return null;
  const params: ScreenParams = {};
  const campaign = url.searchParams.get("campaign");
  if (campaign) params.campaign = campaign;
  const period = url.searchParams.get("period");
  if (period === "week" || period === "month") params.period = period;
  const streamer = url.searchParams.get("streamer");
  return {
    screen,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(streamer ? { streamer } : {}),
  };
}

/** Drops the `?open=` link from the address bar once it has been followed. */
export function clearBootLink(): void {
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
}
