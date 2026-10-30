// Connects to a mailbox over IMAP and reports on its bills folder.
// Uses STATUS, which reads counts without opening the folder, so nothing is
// marked read, moved or deleted.

import { ImapFlow } from "imapflow";
import type { MailboxConfig } from "./config.js";

export interface MailboxStatus {
  messages: number;
  unseen: number;
}

/** A mailbox problem explained in plain words. */
export class MailboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MailboxError";
  }
}

export async function checkMailbox(mailbox: MailboxConfig): Promise<MailboxStatus> {
  const client = new ImapFlow({
    host: mailbox.host,
    port: mailbox.port,
    secure: mailbox.tls,
    // With TLS off, never try STARTTLS: the Bridge offers it with a certificate
    // that cannot match its Docker name, so the upgrade would always fail.
    doSTARTTLS: mailbox.tls ? undefined : false,
    auth: { user: mailbox.username, pass: mailbox.password },
    logger: false,
    connectionTimeout: 15_000,
  });

  try {
    await client.connect();
  } catch (err) {
    throw explainConnectError(mailbox, err);
  }

  try {
    const status = await client.status(mailbox.folder, { messages: true, unseen: true }).catch(() => false as const);
    if (status === false) {
      const folders = (await client.list()).map((folder) => folder.path).sort();
      throw new MailboxError(
        `There is no folder called "${mailbox.folder}". Folders in this mailbox: ${folders.join(", ")}`,
      );
    }
    return { messages: status.messages ?? 0, unseen: status.unseen ?? 0 };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function explainConnectError(mailbox: MailboxConfig, err: unknown): MailboxError {
  const where = `${mailbox.host}:${mailbox.port}`;
  const e = err as { code?: string; authenticationFailed?: boolean; message?: string };
  if (e.authenticationFailed) {
    const hint =
      mailbox.provider === "proton-bridge"
        ? " Use the username and password the Bridge's info command prints, not your Proton password."
        : "";
    return new MailboxError(`${where} did not accept the username or password.${hint}`, { cause: err });
  }
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") {
    return new MailboxError(
      `Could not find ${mailbox.host}. Is it running, and on the same Docker network as OurHomeInbox?`,
      { cause: err },
    );
  }
  if (e.code === "ECONNREFUSED") {
    return new MailboxError(`${where} refused the connection. Check the port.`, { cause: err });
  }
  return new MailboxError(`Could not connect to ${where}: ${e.message ?? String(err)}`, { cause: err });
}
