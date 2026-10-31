// Entry point.
//   node dist/index.js [serve]   the service: web UI and API, and every mailbox
//                                read every capture.every_minutes (first right away),
//                                each read followed by getting new emails' invoices
//   node dist/index.js capture   read every mailbox once, capture what is new, exit
// Captured mail is kept under data/mail (see store.ts), accounts in data/inbox.db.

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig, loadDotEnv, type Config } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { captureMailbox } from "./mailbox.js";
import { createApp } from "./server/app.js";
import { openDatabase } from "./server/db.js";
import { invoicePass } from "./server/invoices.js";
import { CaptureStore } from "./store.js";

/** Everything OurHomeInbox keeps, relative to the folder it runs in (/app/data in Docker). */
const DATA_DIR = "data";
const MAIL_DIR = join(DATA_DIR, "mail");
const DATABASE_FILE = join(DATA_DIR, "inbox.db");

/** The built web app sits next to the compiled server (dist/web); absent when run from source. */
const WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));

/** Reads every mailbox once. True when every mailbox was read and every new message captured. */
async function capturePass(config: Config, store: CaptureStore): Promise<boolean> {
  let mailboxesRead = 0;
  let captured = 0;
  let notCaptured = 0;
  for (const mailbox of config.mailboxes) {
    const { imap } = mailbox;
    log.info(
      `Reading "${mailbox.name}": IMAP ${imap.username} at ${imap.host}:${imap.port} (security ${imap.security}), folder ${mailbox.folder}`,
    );
    try {
      const summary = await captureMailbox(mailbox, store);
      mailboxesRead++;
      captured += summary.captured;
      notCaptured += summary.failed + summary.tooLarge;
      log.info(
        `"${mailbox.name}": ${summary.captured} captured now, ${summary.alreadyCaptured} captured before` +
          (summary.failed > 0 ? `, ${summary.failed} failed` : "") +
          (summary.tooLarge > 0 ? `, ${summary.tooLarge} too large` : ""),
      );
    } catch (err) {
      log.error(`"${mailbox.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log.info(
    `Done: ${mailboxesRead} of ${config.mailboxes.length} mailbox(es) read, ${captured} message(s) captured` +
      (notCaptured > 0 ? `, ${notCaptured} not captured` : ""),
  );
  return mailboxesRead === config.mailboxes.length && notCaptured === 0;
}

/** Serves the web UI and API, and reads the mailboxes on a schedule, until stopped. */
async function runService(config: Config, store: CaptureStore): Promise<number> {
  await mkdir(DATA_DIR, { recursive: true });
  const db = openDatabase(DATABASE_FILE);
  const webRoot = existsSync(join(WEB_ROOT, "index.html")) ? WEB_ROOT : null;
  const app = createApp({
    config,
    configPath: resolve(process.env.OURHOMEINBOX_CONFIG || DEFAULT_CONFIG_PATH),
    db,
    store,
    webRoot,
    version: packageVersion(),
  });

  // In Docker, listen on every interface: docker/deploy.sh decides who can
  // reach the published port. Outside Docker, only this computer.
  const hostname = existsSync("/.dockerenv") ? "0.0.0.0" : "127.0.0.1";
  const server = serve({ fetch: app.fetch, hostname, port: config.web.port });
  log.info(`Web page on http://${hostname}:${config.web.port}${webRoot === null ? " (API only: the web app is not built)" : ""}`);

  // One pass at a time: a slow mailbox never makes passes pile up.
  const everyMs = config.capture.everyMinutes * 60_000;
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  const scheduled = async (): Promise<void> => {
    await capturePass(config, store).catch((err) => log.error(`Reading the mailboxes failed: ${String(err)}`));
    // Then the invoices behind new emails' "View Invoice" links (see server/invoices.ts).
    await invoicePass({ config, store, db })
      .then(({ tried, saved }) => {
        if (tried > 0) log.info(`Invoices: ${tried} link(s) opened, ${saved} invoice(s) saved`);
      })
      .catch((err) => log.error(`Getting invoices failed: ${String(err)}`));
    if (!stopping) {
      log.info(`Next read in ${config.capture.everyMinutes} minute(s)`);
      timer = setTimeout(scheduled, everyMs);
    }
  };
  void scheduled();

  await new Promise<void>((done) => {
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      log.info(`${signal}: stopping`);
      clearTimeout(timer);
      server.close(() => done());
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });
  db.close();
  log.info("Stopped");
  return 0;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
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
  const store = new CaptureStore(MAIL_DIR);
  log.info(`Settings loaded: ${config.mailboxes.length} mailbox(es); captured mail goes in ${resolve(store.root)}`);

  if (command === "capture") return (await capturePass(config, store)) ? 0 : 1;
  return runService(config, store);
}

process.exitCode = await main();
