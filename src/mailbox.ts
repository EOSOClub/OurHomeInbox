// Connects to a mailbox over IMAP and captures every message in its bills
// folder that is not captured yet. Read-only twice over: the folder is opened
// with EXAMINE, in which the server refuses any change, and messages are
// fetched with BODY.PEEK, which does not mark them read. Nothing is moved or
// deleted.

import { existsSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { buildCapture } from "./capture.js";
import type { Provider, Security } from "./config.js";
import { log } from "./log.js";
import type { CaptureStore } from "./store.js";

/** What reading a mailbox needs. */
export interface MailboxToRead {
  name: string;
  /** Its folder under data/mail. Stays the same when the mailbox is renamed, so its mail never moves. */
  slug: string;
  provider: Provider;
  /** The folder in the mailbox that is read, such as "Folders/Bills". */
  folder: string;
  imap: { host: string; port: number; security: Security; username: string; password: string };
}

type Connection = Pick<MailboxToRead, "provider" | "imap">;

/** Larger messages are skipped with a warning rather than read into memory. */
export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;

export interface CaptureSummary {
  /** Messages in the folder. */
  inFolder: number;
  /** Captured on an earlier run. */
  alreadyCaptured: number;
  /** Captured on this run. */
  captured: number;
  /** Could not be captured; tried again next run. */
  failed: number;
  /** Over MAX_MESSAGE_BYTES; skipped. */
  tooLarge: number;
}

/** A mailbox problem explained in plain words. */
export class MailboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MailboxError";
  }
}

/**
 * imapflow options for each security mode. Each mode does exactly what it says:
 * "none" never upgrades (even when the server offers STARTTLS), and "starttls"
 * fails rather than carrying on unencrypted when the upgrade is not possible.
 */
export const SECURITY_OPTIONS: Record<Security, { secure: boolean; doSTARTTLS: boolean | undefined }> = {
  none: { secure: false, doSTARTTLS: false },
  starttls: { secure: false, doSTARTTLS: true },
  tls: { secure: true, doSTARTTLS: undefined },
};

async function connect(mailbox: Connection): Promise<ImapFlow> {
  const { imap } = mailbox;
  if (imap.password === "") throw new MailboxError("No password is saved for this mailbox. Add it in Settings.");
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    ...SECURITY_OPTIONS[imap.security],
    auth: { user: imap.username, pass: imap.password },
    logger: false,
    connectionTimeout: 15_000,
  });
  try {
    await client.connect();
  } catch (err) {
    throw explainConnectError(mailbox, err);
  }
  return client;
}

/**
 * Captures every message in the mailbox's folder that `store` does not have
 * yet, one at a time, logging each. A message that fails is logged and left
 * for the next run; the others still get captured.
 */
export async function captureMailbox(mailbox: MailboxToRead, store: CaptureStore): Promise<CaptureSummary> {
  const client = await connect(mailbox);
  try {
    let uidValidity: string;
    try {
      // readOnly: EXAMINE, so the server itself refuses any change.
      const opened = await client.mailboxOpen(mailbox.folder, { readOnly: true });
      uidValidity = opened.uidValidity.toString();
    } catch (err) {
      const folders = (await client.list()).map((folder) => folder.path);
      if (folders.includes(mailbox.folder)) throw err;
      throw new MailboxError(missingFolderMessage(mailbox.folder, folders), { cause: err });
    }

    const summary: CaptureSummary = { inFolder: 0, alreadyCaptured: 0, captured: 0, failed: 0, tooLarge: 0 };
    const listed = client.mailbox && client.mailbox.exists > 0 ? await client.fetchAll("1:*", { uid: true, size: true }) : [];
    summary.inFolder = listed.length;
    const pending = listed.filter((message) => !store.has(mailbox.slug, uidValidity, message.uid));
    summary.alreadyCaptured = listed.length - pending.length;
    log.info(`"${mailbox.name}": ${summary.inFolder} message(s) in the folder, ${pending.length} not captured yet`);

    for (const message of pending) {
      if ((message.size ?? 0) > MAX_MESSAGE_BYTES) {
        log.warn(`"${mailbox.name}": message ${message.uid} skipped: ${megabytes(message.size ?? 0)} is over the ${megabytes(MAX_MESSAGE_BYTES)} limit`);
        summary.tooLarge++;
        continue;
      }
      try {
        const fetched = await client.fetchOne(String(message.uid), { uid: true, source: true }, { uid: true });
        if (fetched === false || fetched.source === undefined) throw new Error("the server sent no content");
        const result = await buildCapture(fetched.source, {
          mailbox: mailbox.name,
          folder: mailbox.folder,
          uidValidity,
          uid: message.uid,
          capturedAt: new Date(),
        });
        await store.save(result, fetched.source, mailbox.slug);
        const { capture } = result;
        log.info(
          `"${mailbox.name}": captured message ${message.uid}: ${quote(capture.subject)}, ` +
            `${capture.attachments.length} attachment(s), ${capture.links.length} link(s)`,
        );
        summary.captured++;
      } catch (err) {
        log.error(`"${mailbox.name}": message ${message.uid} not captured, will try again next run: ${err instanceof Error ? err.message : String(err)}`);
        summary.failed++;
      }
    }
    return summary;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export interface MailboxTest {
  /** Every folder in the mailbox, for choosing one. */
  folders: string[];
  /** Messages in the chosen folder, or null when there is no such folder. */
  messages: number | null;
  /** Why the chosen folder could not be found, with the closest names; null when it was. */
  folderProblem: string | null;
}

/**
 * Signs in, lists the folders and opens the chosen one read-only, to show the
 * settings work before they are saved. Changes nothing. Throws a MailboxError
 * in plain words when it cannot sign in.
 */
export async function testMailbox(mailbox: Connection & { folder: string }): Promise<MailboxTest> {
  const client = await connect(mailbox);
  try {
    const folders = (await client.list()).map((folder) => folder.path).sort();
    if (!folders.includes(mailbox.folder)) return { folders, messages: null, folderProblem: missingFolderMessage(mailbox.folder, folders) };
    const opened = await client.mailboxOpen(mailbox.folder, { readOnly: true });
    return { folders, messages: opened.exists, folderProblem: null };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** A subject for the log: quoted and escaped (it is a stranger's text), and short. */
function quote(subject: string | null): string {
  if (subject === null) return "(no subject)";
  return JSON.stringify(subject.length > 80 ? `${subject.slice(0, 79)}…` : subject);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Names the folder the setting most likely meant (same name, any
 * capitalization, or the same path under a parent such as Proton's
 * "Folders/"). Only when nothing is close does it list every folder, since
 * that list can be long and personal.
 */
export function missingFolderMessage(folder: string, folders: string[]): string {
  const wanted = folder.toLowerCase();
  const close = folders.filter((path) => {
    const candidate = path.toLowerCase();
    return candidate === wanted || candidate.endsWith(`/${wanted}`);
  });
  if (close.length > 0) {
    return `There is no folder called "${folder}". Did you mean ${close.map((path) => `"${path}"`).join(" or ")}?`;
  }
  return `There is no folder called "${folder}". Folders in this mailbox: ${[...folders].sort().join(", ")}`;
}

/** Node's codes for a certificate it will not trust, in plain words (Node's own text suggests Node flags). */
const CERTIFICATE_PROBLEMS = new Map([
  ["CERT_HAS_EXPIRED", "it has expired"],
  ["CERT_NOT_YET_VALID", "it is not valid yet"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "it is self-signed"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "it is signed by an untrusted authority"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "it is signed by an untrusted authority"],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "it is signed by an untrusted authority"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "it is issued for a different name"],
]);

/** Addresses that mean "this container" when OurHomeInbox runs in Docker. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function explainConnectError(mailbox: Connection, err: unknown, inDocker = existsSync("/.dockerenv")): MailboxError {
  const { imap } = mailbox;
  const where = `${imap.host}:${imap.port}`;
  if (inDocker && LOOPBACK_HOSTS.has(imap.host)) {
    return new MailboxError(
      `${imap.host} inside Docker is the OurHomeInbox container itself, not your computer. ` +
        "For a mail server or Bridge app on the computer running Docker, use host: host.docker.internal; " +
        "for one in another container, use that container's name.",
      { cause: err },
    );
  }
  const e = err as { code?: string; authenticationFailed?: boolean; tlsFailed?: boolean; message?: string };
  // Before tlsFailed: imapflow marks a STARTTLS upgrade that failed on the
  // certificate as tlsFailed too, keeping the certificate's error code.
  const certificateProblem = e.code === undefined ? undefined : CERTIFICATE_PROBLEMS.get(e.code);
  if (certificateProblem !== undefined) {
    return new MailboxError(
      `${where} has a certificate that cannot be trusted: ${certificateProblem} (security: ${imap.security}).` +
        (mailbox.provider === "proton-bridge"
          ? " Proton Mail Bridge's certificate is only valid for 127.0.0.1; reached by its Docker name, use security: none."
          : ""),
      { cause: err },
    );
  }
  if (e.tlsFailed) {
    return new MailboxError(
      `${where} could not switch to an encrypted connection (security: starttls). Check which security the server expects.`,
      { cause: err },
    );
  }
  if (e.code === "ERR_SSL_WRONG_VERSION_NUMBER") {
    return new MailboxError(
      `${where} did not answer with encryption (security: tls). This port probably expects none or starttls; tls is usually port 993.`,
      { cause: err },
    );
  }
  if (e.authenticationFailed) {
    const hint =
      mailbox.provider === "proton-bridge"
        ? " Use the username and password the Bridge's info command prints, not your Proton password."
        : "";
    return new MailboxError(`${where} did not accept the username or password.${hint}`, { cause: err });
  }
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") {
    return new MailboxError(
      `Could not find ${imap.host}. Is it running, and on the same Docker network as OurHomeInbox?`,
      { cause: err },
    );
  }
  if (e.code === "ECONNREFUSED") {
    return new MailboxError(`${where} refused the connection. Check the port.`, { cause: err });
  }
  return new MailboxError(`Could not connect to ${where}: ${e.message ?? String(err)}`, { cause: err });
}
