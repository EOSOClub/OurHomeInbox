// Entry point. For now it loads the settings and checks that each mailbox can
// be reached and its bills folder exists, then exits. Reading bills comes next.

import { ConfigError, loadConfig, loadDotEnv, type Config } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { checkMailbox } from "./mailbox.js";

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
  log.info(`Settings loaded: ${config.mailboxes.length} mailbox(es)`);

  let reachable = 0;
  for (const mailbox of config.mailboxes) {
    log.info(`Checking "${mailbox.name}": ${mailbox.username} at ${mailbox.host}:${mailbox.port}, folder ${mailbox.folder}`);
    try {
      const status = await checkMailbox(mailbox);
      log.info(`"${mailbox.name}": ${status.messages} message(s), ${status.unseen} unread`);
      reachable++;
    } catch (err) {
      log.error(`"${mailbox.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info(`Done: ${reachable} of ${config.mailboxes.length} mailbox(es) reachable`);
  return reachable === config.mailboxes.length ? 0 : 1;
}

process.exitCode = await main();
