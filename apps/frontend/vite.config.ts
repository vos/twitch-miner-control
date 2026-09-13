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
  // `vite preview` serves the built bundle, and does NOT inherit the
  // `server` block above -- without its own proxy every /api call 404s
  // against the static server. Production does not use this path at all:
  // there the backend serves the built frontend itself from STATIC_ROOT
  // (see docker/Dockerfile), so this exists purely to test a production
  // bundle against a backend already running on 8080.
  preview: {
    host: true,
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
  test: {
    environment: "jsdom",
    // Each test file still gets its own jsdom, but inside a VM context in a
    // reused worker rather than a fresh one -- building those environments
    // was over a third of the suite's run time. `isolate: false` is not an
    // alternative: files then share one document and each other's renders.
    pool: "vmThreads",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    css: true,
  },
});
