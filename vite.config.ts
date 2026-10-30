// The web app (web/). Built into dist/web, which the server serves.
// In development, `npm run dev:web` serves it on port 5173 and passes /api on
// to the server started with `npm run dev:server`.

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8080" } },
});
