// Entry point. Loads the settings, then reads each mailbox's bills folder and
// captures every message not captured before (see store.ts for where), then
// exits. Watching the folder for new mail comes next.

import { join, resolve } from "node:path";
import { ConfigError, loadConfig, loadDotEnv, type Config } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { captureMailbox } from "./mailbox.js";
import { CaptureStore } from "./store.js";

/** Captured mail, relative to the folder OurHomeInbox runs in (/app/data in Docker). */
const MAIL_DIR = join("data", "mail");

async function main(): Promise<number> {
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
  return mailboxesRead === config.mailboxes.length && notCaptured === 0 ? 0 : 1;
}

process.exitCode = await main();
