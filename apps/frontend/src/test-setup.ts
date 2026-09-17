import { configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia, but Mantine's provider queries it on
// mount (color scheme detection). Without this stub every test that renders
// a Mantine component fails with "window.matchMedia is not a function"
// before it reaches any assertion.
//
// Width queries are answered against jsdom's own 1024px window rather than
// with a blanket false: the app asks whether it is on a desktop-width
// screen to decide which half of the sidebar toggle to drive, and a stub
// that always says no would pin every test to the narrow-screen branch --
// making the wide-screen behaviour untestable and, worse, silently green.
const WIDTH_QUERY = /\((min|max)-width:\s*([\d.]+)(px|em|rem)\)/;

function widthMatches(query: string): boolean {
  const parsed = WIDTH_QUERY.exec(query);
  if (parsed === null) return false;
  const [, bound, size, unit] = parsed;
  const px = unit === "px" ? Number(size) : Number(size) * 16;
  return bound === "min" ? window.innerWidth >= px : window.innerWidth <= px;
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: widthMatches(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}

// jsdom implements no scrollIntoView. Mantine's Combobox (Select, and the
// settings dialog's enum controls) calls it on the active option from a
// timer after the dropdown opens, so the throw lands *after* the test that
// opened it has already passed: vitest reports every test green, then exits
// non-zero with "Vitest caught 1 unhandled error" and warns about false
// positives. Stubbing it keeps `pnpm test` -- and so CI -- honest.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom does not implement ResizeObserver either, and Mantine's ScrollArea
// (used by the Logs screen) observes its viewport on mount. Without this
// stub every test that renders a ScrollArea fails before any assertion.
if (typeof window !== "undefined" && !window.ResizeObserver) {
  class StubResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

// Testing Library keeps its own async timeout and does NOT read vitest's
// `testTimeout` -- so findBy*/waitFor expired after 1s while the test
// itself still had plenty of budget left. That 1s is the real source of
// this suite's "a random unrelated test failed" flakiness: several suites
// legitimately do a second or more of work per test (a Settings screen
// mounts a form of Mantine controls; the dashboard's detail dialog sits
// behind a dynamic import), so on a four-core box whatever is nearest the
// line fails as soon as anything else wants CPU. Reproduced by
// oversubscribing the cores 3:1, which fails reliably at 1s and passes at
// 5s.
//
// A ceiling for a stuck query, not a budget: every wait still resolves the
// moment its condition holds, so passing tests are no slower.
configure({ asyncUtilTimeout: 5_000 });
