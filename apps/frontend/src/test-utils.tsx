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
