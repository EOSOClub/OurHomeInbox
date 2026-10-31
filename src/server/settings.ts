// The install's settings (config.yml), changed and reloaded without a restart:
//   GET  /api/settings          the settings in use
//   PUT  /api/settings          change how often mail is read and the log level (admin)
//   POST /api/settings/reload   read config.yml again, after editing it by hand (admin)
//
// A change is written into config.yml (keeping its comments) and applied at
// once. A file with a mistake is refused with the reasons, and the settings in
// use stay. The web port and Docker's settings only take effect when
// docker/deploy.sh runs the container again; the page says so.
//
// Built field by field, so no secret can ride along in a response.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { ConfigError, updateConfigFile, type Config, type ConfigChanges } from "../config.js";
import { log } from "../log.js";
import type { SettingsResponse } from "../shared/api.js";
import { LOG_LEVELS, MAX_CAPTURE_MINUTES, MIN_CAPTURE_MINUTES } from "../shared/settings.js";
import { apiError, jsonBody, MESSAGES, type AppEnv } from "./http.js";

const ADMIN_ONLY = "Only an admin can change these settings.";

/** The settings in use, and how to read them again or change them. */
export class InstallSettings {
  private current: Config;
  /** The web port the server was started on; a different one in config.yml needs a restart. */
  readonly runningPort: number;

  constructor(
    initial: Config,
    private readonly options: {
      /** Where config.yml is. */
      path: string;
      /** Where the previous config.yml is copied before a change is written. */
      backupPath: string;
      /** Reads config.yml (loadConfig). */
      load: () => Config;
      /** Puts settings into effect (the log level, the reading schedule). */
      apply: (config: Config) => void;
    },
  ) {
    this.current = initial;
    this.runningPort = initial.web.port;
  }

  get config(): Config {
    return this.current;
  }

  get path(): string {
    return this.options.path;
  }

  /** Reads config.yml again and puts it into effect. Null when it worked, else the problems (and nothing changed). */
  reload(): string[] | null {
    let next: Config;
    try {
      next = this.options.load();
    } catch (err) {
      if (err instanceof ConfigError) return err.problems;
      throw err;
    }
    this.current = next;
    this.options.apply(next);
    log.info(`Settings reloaded from ${this.options.path}`);
    return null;
  }

  /** Writes `changes` into config.yml and puts them into effect. Null when it worked, else the problems. */
  update(changes: ConfigChanges): string[] | null {
    try {
      updateConfigFile(this.options.path, changes, this.options.backupPath);
    } catch (err) {
      if (err instanceof ConfigError) return err.problems;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
        return [
          `${this.options.path} cannot be written (${code === "EROFS" ? "it is mounted read-only" : "no permission"}). ` +
            "Run docker/deploy.sh once to update how the container is set up, then try again.",
        ];
      }
      throw err;
    }
    return this.reload();
  }
}

const settingsSchema = z.object(
  {
    logLevel: z.enum(LOG_LEVELS, { error: "Choose a log level." }),
    captureEveryMinutes: z
      .number({ error: "Enter how often to read mail, in minutes." })
      .int("Enter a whole number of minutes.")
      .min(MIN_CAPTURE_MINUTES, `Read mail at most every ${MIN_CAPTURE_MINUTES} minute.`)
      .max(MAX_CAPTURE_MINUTES, `Read mail at least once a day (every ${MAX_CAPTURE_MINUTES} minutes).`),
  },
  { error: MESSAGES.badShape },
);

export interface SettingsDeps {
  settings: InstallSettings;
  /** Where the key protecting saved passwords comes from. */
  secretKey: "env" | "file";
  /** How many mailboxes config.yml still lists after they were copied into the database. */
  ignoredMailboxes: () => number;
}

export function settingsResponse(c: Context<AppEnv>, deps: SettingsDeps): SettingsResponse {
  const { config } = deps.settings;
  const needsRestart: string[] = [];
  if (config.web.port !== deps.settings.runningPort) {
    needsRestart.push(
      `The web port in config.yml is ${config.web.port}, but OurHomeInbox is running on ${deps.settings.runningPort}. Run docker/deploy.sh for it to take effect.`,
    );
  }
  return {
    configPath: deps.settings.path,
    logLevel: config.logLevel,
    captureEveryMinutes: config.capture.everyMinutes,
    web: { port: config.web.port },
    docker: config.docker
      ? { network: config.docker.network ?? null, port: config.docker.port ?? null, bind: config.docker.bind ?? null }
      : null,
    canEdit: c.var.user?.isAdmin === true,
    needsRestart,
    ignoredMailboxes: deps.ignoredMailboxes(),
    secretKey: deps.secretKey,
  };
}

export function settingsRoutes(deps: SettingsDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const isAdmin = (c: Context<AppEnv>) => c.var.user?.isAdmin === true;

  app.get("/settings", (c) => c.json(settingsResponse(c, deps)));

  app.put("/settings", jsonBody(settingsSchema), (c) => {
    if (!isAdmin(c)) return apiError(c, 403, ADMIN_ONLY);
    const { logLevel, captureEveryMinutes } = c.req.valid("json");
    const problems = deps.settings.update({ logLevel, captureEveryMinutes });
    if (problems) return apiError(c, 409, problems.join(" "));
    return c.json(settingsResponse(c, deps));
  });

  app.post("/settings/reload", (c) => {
    if (!isAdmin(c)) return apiError(c, 403, ADMIN_ONLY);
    const problems = deps.settings.reload();
    if (problems) return apiError(c, 409, `config.yml has a problem, so the settings in use were kept: ${problems.join(" ")}`);
    return c.json(settingsResponse(c, deps));
  });

  return app;
}
