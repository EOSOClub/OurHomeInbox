// Entry point.
//   node dist/index.js [serve]   the service: web UI and API, and every mailbox
//                                read every capture.every_minutes (first right away),
//                                each read followed by getting new emails' invoices
//   node dist/index.js capture   read every mailbox once, capture what is new, exit
// Captured mail is kept under data/mail (see store.ts), accounts and mailboxes
// in data/inbox.db. Settings changed on the web page apply without a restart.

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { ConfigError, configPath, loadConfig, loadDotEnv, type Config } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { openDatabase, type Database } from "./server/db.js";
import { SecretKeyError } from "./server/secrets.js";
import { createService } from "./server/service.js";
import { CaptureStore } from "./store.js";

/** Everything OurHomeInbox keeps, relative to the folder it runs in (/app/data in Docker). */
const DATA_DIR = "data";
const MAIL_DIR = join(DATA_DIR, "mail");
const DATABASE_FILE = join(DATA_DIR, "inbox.db");

/** The built web app sits next to the compiled server (dist/web); absent when run from source. */
const WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The service for this install, or null (with the reason logged) when the key for saved passwords is unusable. */
function service(config: Config, db: Database, store: CaptureStore) {
  try {
    return createService({
      config,
      configPath: resolve(configPath()),
      load: () => loadConfig(),
      dataDir: DATA_DIR,
      db,
      store,
      webRoot: existsSync(join(WEB_ROOT, "index.html")) ? WEB_ROOT : null,
      version: packageVersion(),
    });
  } catch (err) {
    if (!(err instanceof SecretKeyError)) throw err;
    log.error(err.message);
    return null;
  }
}

/** Serves the web UI and API, and reads the mailboxes on a schedule, until stopped. */
async function runService(config: Config, db: Database, store: CaptureStore): Promise<number> {
  const running = service(config, db, store);
  if (!running) return 1;
  const { app, scheduler, secretKey } = running;
  if (secretKey === "file") log.info(`The key protecting saved passwords is in ${join(DATA_DIR, "secret.key")}`);

  // In Docker, listen on every interface: docker/deploy.sh decides who can
  // reach the published port. Outside Docker, only this computer.
  const hostname = existsSync("/.dockerenv") ? "0.0.0.0" : "127.0.0.1";
  const server = serve({ fetch: app.fetch, hostname, port: config.web.port });
  log.info(`Web page on http://${hostname}:${config.web.port}${existsSync(join(WEB_ROOT, "index.html")) ? "" : " (API only: the web app is not built)"}`);

  // One read at a time: a slow mailbox never makes reads pile up.
  scheduler.start();

  await new Promise<void>((done) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      log.info(`${signal}: stopping`);
      void scheduler.stop().then(() => server.close(() => done()));
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });
  log.info("Stopped");
  return 0;
}

/** Reads every mailbox once. True when every mailbox was read and every new message captured. */
async function captureOnce(config: Config, db: Database, store: CaptureStore): Promise<boolean> {
  const running = service(config, db, store);
  if (!running) return false;
  const { failed } = await running.mailboxes.readAll();
  return failed === 0;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? "serve";
  if (command !== "serve" && command !== "capture") {
    log.error(`Unknown command "${command}". Use "serve" (the default) or "capture".`);
    return 2;
  }

  log.info("OurHomeInbox starting: loading settings");
  loadDotEnv();

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const problem of err.problems) log.error(problem);
    log.error("Settings are not usable. Fix the lines above and start again.");
    return 1;
  }
  setLogLevel(config.logLevel);
  await mkdir(DATA_DIR, { recursive: true });
  const store = new CaptureStore(MAIL_DIR);
  const db = openDatabase(DATABASE_FILE);
  log.info(`Settings loaded; captured mail goes in ${resolve(store.root)}`);

  try {
    if (command === "capture") return (await captureOnce(config, db, store)) ? 0 : 1;
    return await runService(config, db, store);
  } finally {
    db.close();
  }
}

process.exitCode = await main();
