import { MantineProvider } from "@mantine/core";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { theme } from "./theme.js";

/**
 * Renders inside the same provider configuration as main.tsx.
 *
 * A bare <MantineProvider> renders Mantine's default theme, so a test
 * using one asserts against a theme the app never ships. Keep this in
 * step with main.tsx.
 */
export function renderApp(ui: ReactNode): RenderResult {
  return render(
    <MantineProvider theme={theme} forceColorScheme="dark">
      {ui}
    </MantineProvider>,
  );
}

/** jsdom's own implementation, captured before any test overrides it. */
const nativeRect = Element.prototype.getBoundingClientRect;

/**
 * Gives the streamer rows a real vertical layout for the duration of a test.
 *
 * jsdom reports every `getBoundingClientRect` as 0x0. dnd-kit chooses a drop
 * target by comparing the dragged item's geometry against its neighbours', so
 * under jsdom every row looks like it sits at the same point and a drag
 * "succeeds" while reordering nothing -- a test asserting on the result would
 * pass against a component that does not work. Stacking the rows into a 50px
 * column is the smallest lie that makes the collision maths mean something.
 *
 * Returns nothing: the override is undone by the caller's `afterEach` via
 * `restoreRects`.
 */
export function stubRowRects(testId = "streamer-row"): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, width: 300, height, top, left: 0,
      right: 300, bottom: top + height, toJSON: () => ({}),
    }) as DOMRect;

    if (el.dataset?.testid !== testId) return rect(0, 400);
    const siblings = Array.from(el.parentElement?.children ?? []);
    return rect(siblings.indexOf(el) * 50, 50);
  };
}

/** Undoes {@link stubRowRects}. Call from `afterEach`. */
export function restoreRects(): void {
  Element.prototype.getBoundingClientRect = nativeRect;
}
