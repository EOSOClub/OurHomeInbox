// Puts the running service together: the key for saved passwords, the
// mailboxes, the install's settings, when mail is read, and the web app. Used
// by src/index.ts and by the tests, so both run the same wiring.

import { join } from "node:path";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import { log, setLogLevel } from "../log.js";
import type { CaptureStore } from "../store.js";
import { createApp } from "./app.js";
import type { Database } from "./db.js";
import type { AppEnv } from "./http.js";
import { invoicePass } from "./invoices.js";
import { Mailboxes } from "./mailboxes.js";
import { MailScheduler, type Timers } from "./scheduler.js";
import { loadSecretKey, SecretBox } from "./secrets.js";
import { InstallSettings } from "./settings.js";

export interface ServiceOptions {
  /** The settings read at start. */
  config: Config;
  /** Where config.yml is. */
  configPath: string;
  /** Reads config.yml again (loadConfig). */
  load: () => Config;
  /** data/: the key file and config.yml's backup go here. */
  dataDir: string;
  db: Database;
  store: CaptureStore;
  webRoot: string | null;
  version: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** For tests: what reading mail does, and the scheduler's timers. */
  readMail?: () => Promise<void>;
  timers?: Timers;
}

export interface Service {
  app: Hono<AppEnv>;
  mailboxes: Mailboxes;
  settings: InstallSettings;
  scheduler: MailScheduler;
  secretKey: "env" | "file";
}

export function createService(options: ServiceOptions): Service {
  const now = options.now ?? (() => new Date());
  const { key, source } = loadSecretKey(options.dataDir, options.env);
  const mailboxes = new Mailboxes(options.db, new SecretBox(key), options.store, now);

  // Reading mail: every mailbox, then the invoices behind new emails' links.
  const readMail =
    options.readMail ??
    (async () => {
      await mailboxes.readAll();
      const { tried, saved } = await invoicePass({ store: options.store, db: options.db, mailboxes });
      if (tried > 0) log.info(`Invoices: ${tried} link(s) opened, ${saved} invoice(s) saved`);
    });
  const scheduler = new MailScheduler(readMail, options.config.capture.everyMinutes, now, options.timers);

  const settings = new InstallSettings(options.config, {
    path: options.configPath,
    backupPath: join(options.dataDir, "config.yml.bak"),
    load: options.load,
    apply: (config) => {
      setLogLevel(config.logLevel);
      scheduler.setEvery(config.capture.everyMinutes);
    },
  });

  // config.yml's mailboxes, copied into the database once (after first-time setup when there is no household yet).
  mailboxes.importFromConfig(options.config);

  const app = createApp({
    settings,
    db: options.db,
    store: options.store,
    mailboxes,
    checking: scheduler,
    secretKey: source,
    webRoot: options.webRoot,
    version: options.version,
    now: options.now,
  });
  return { app, mailboxes, settings, scheduler, secretKey: source };
}
