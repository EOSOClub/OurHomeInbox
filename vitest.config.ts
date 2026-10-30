// Tests for the server (test/) and the web app (web/src/**/*.test.tsx).
// A file of its own so vite.config.ts's `root: "web"` does not hide test/.
// Web tests that need a browser DOM start with `// @vitest-environment jsdom`.

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: { include: ["test/**/*.test.ts", "web/src/**/*.test.{ts,tsx}"] },
});
