import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The dev server forwards /api to the backend, so the browser sees one origin, as it does behind nginx.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/polyfills.ts", "src/test/setup.ts"],
  },
});
