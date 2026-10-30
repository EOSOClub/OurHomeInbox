// The web app: the built files in webRoot, served as they are. Any other GET
// (outside /api) gets index.html, since the app works out the page from the
// address itself (a single-page app).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { log } from "../log.js";
import type { AppEnv } from "./http.js";

export function webRoutes(webRoot: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // The build names files in assets/ by their content, so they never change.
  // Everything else (index.html above all) is checked each time, so a new
  // version shows up at once.
  app.use("*", async (c, next) => {
    await next();
    if (c.res.headers.has("Cache-Control")) return;
    const forever = c.res.ok && c.req.path.startsWith("/assets/");
    c.res.headers.set("Cache-Control", forever ? "public, max-age=31536000, immutable" : "no-cache");
  });
  app.use("*", serveStatic({ root: webRoot }));

  app.get("*", async (c) => {
    // A missing file (it has an extension) is a 404, not the app's page in its place.
    if (/\.[^/]*$/.test(c.req.path)) return c.text("Not found.", 404);
    let html: string;
    try {
      html = await readFile(join(webRoot, "index.html"), "utf8");
    } catch (err) {
      log.error(`The web app's index.html could not be read from ${webRoot}: ${err instanceof Error ? err.message : String(err)}`);
      return c.text("The OurHomeInbox web app is not installed here.", 404);
    }
    return c.html(html);
  });

  return app;
}
