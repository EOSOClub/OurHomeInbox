// GET /api/settings: the settings in use, read-only. Built field by field from
// the loaded config so a password (or any secret added to Config later) can
// never ride along by accident.

import { Hono } from "hono";
import type { Config } from "../config.js";
import { mailboxSlug } from "../config.js";
import type { SettingsResponse } from "../shared/api.js";
import type { AppEnv } from "./http.js";

export interface SettingsDeps {
  config: Config;
  configPath: string;
}

export function settingsResponse(deps: SettingsDeps): SettingsResponse {
  const { config } = deps;
  return {
    configPath: deps.configPath,
    logLevel: config.logLevel,
    web: { port: config.web.port },
    capture: { everyMinutes: config.capture.everyMinutes },
    mailboxes: config.mailboxes.map((mailbox) => ({
      name: mailbox.name,
      slug: mailboxSlug(mailbox.name),
      provider: mailbox.provider,
      folder: mailbox.folder,
      imap: {
        host: mailbox.imap.host,
        port: mailbox.imap.port,
        security: mailbox.imap.security,
        username: mailbox.imap.username,
        passwordEnv: mailbox.imap.passwordEnv,
        passwordSet: mailbox.imap.password !== "",
      },
    })),
  };
}

export function settingsRoutes(deps: SettingsDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/settings", (c) => c.json(settingsResponse(deps)));
  return app;
}
