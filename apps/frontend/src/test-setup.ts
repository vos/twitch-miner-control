import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia, but Mantine's provider queries it on
// mount (color scheme detection). Without this stub every test that renders
// a Mantine component fails with "window.matchMedia is not a function"
// before it reaches any assertion.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
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
