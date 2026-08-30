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
