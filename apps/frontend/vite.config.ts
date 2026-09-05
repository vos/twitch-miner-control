import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Vite's default binds loopback only, which resolves to IPv6 [::1]
    // inside the dev container -- unreachable from the host, whose port
    // forwarding connects over IPv4. `true` binds all interfaces, the
    // same as the backend's own 0.0.0.0.
    host: true,
    // 127.0.0.1 rather than `localhost` for the same reason: Node 18+
    // no longer reorders DNS results, so `localhost` can resolve to
    // [::1] and miss the backend listening on 0.0.0.0.
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    css: true,
  },
});
