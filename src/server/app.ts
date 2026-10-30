// The HTTP server's app: the REST API under /api (see shared/api.ts for the
// routes) and, when there is a built web app, the web app everywhere else.
// Built as a plain Hono app so tests can call it with app.request() and the
// runtime can hand it to @hono/node-server's serve().
//
// Every request passes, in order: security headers (added on the way out),
// the body size limit and cross-site check (changing requests only), the
// session cookie, and the sign-in requirement.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { Config } from "../config.js";
import { log } from "../log.js";
import type { HealthResponse } from "../shared/api.js";
import type { CaptureStore } from "../store.js";
import { billerRoutes } from "./billers.js";
import { captureRoutes } from "./captures.js";
import type { Database } from "./db.js";
import { apiError, crossSiteCheck, MAX_BODY_BYTES, MESSAGES, securityHeaders, type AppEnv } from "./http.js";
import { loadSession, requireSignIn, sessionRoutes } from "./session.js";
import { settingsRoutes } from "./settings.js";
import { webRoutes } from "./web.js";

export interface AppDeps {
  config: Config;
  /** Shown in SettingsResponse. */
  configPath: string;
  db: Database;
  store: CaptureStore;
  /** The folder with the built web app (index.html), or null to serve no UI. */
  webRoot: string | null;
  version: string;
  /** For tests. */
  now?: () => Date;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date());
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders);
  app.use(
    "/api/*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => apiError(c, 413, MESSAGES.tooLarge) }),
    crossSiteCheck,
    loadSession({ db: deps.db, now }),
    requireSignIn,
  );

  app.get("/api/health", (c) => {
    const body: HealthResponse = { ok: true, version: deps.version };
    return c.json(body);
  });
  app.route("/api", sessionRoutes({ db: deps.db, now }));
  app.route("/api", captureRoutes({ config: deps.config, store: deps.store }));
  app.route("/api", settingsRoutes({ config: deps.config, configPath: deps.configPath }));
  app.route("/api", billerRoutes({ db: deps.db, now }));
  // Before the web app's catch-all, so an unknown API address is a JSON 404, never the app's page.
  app.all("/api", (c) => apiError(c, 404, MESSAGES.notFound));
  app.all("/api/*", (c) => apiError(c, 404, MESSAGES.notFound));

  if (deps.webRoot !== null) app.route("/", webRoutes(deps.webRoot));

  app.notFound((c) => c.text("Not found.", 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      // Hono's own: malformed JSON (400) and the like. Its messages are for developers.
      const status = err.status;
      const message = status === 400 ? MESSAGES.badJson : status === 413 ? MESSAGES.tooLarge : MESSAGES.server;
      return apiError(c, status, message);
    }
    log.error(`${c.req.method} ${c.req.path} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return apiError(c, 500, MESSAGES.server);
  });

  return app;
}
