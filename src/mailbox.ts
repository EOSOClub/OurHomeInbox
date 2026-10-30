// Connects to a mailbox over IMAP and reports on its bills folder.
// Uses STATUS, which reads counts without opening the folder, so nothing is
// marked read, moved or deleted.

import { ImapFlow } from "imapflow";
import type { MailboxConfig, Security } from "./config.js";

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

export async function checkMailbox(mailbox: MailboxConfig): Promise<MailboxStatus> {
  const { imap } = mailbox;
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

/** Node's codes for a certificate it will not trust. */
const CERTIFICATE_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function explainConnectError(mailbox: MailboxConfig, err: unknown): MailboxError {
  const { imap } = mailbox;
  const where = `${imap.host}:${imap.port}`;
  const e = err as { code?: string; authenticationFailed?: boolean; tlsFailed?: boolean; message?: string };
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
  if (e.code !== undefined && CERTIFICATE_ERROR_CODES.has(e.code)) {
    return new MailboxError(
      `${where} has a certificate that cannot be trusted (${e.message ?? e.code}; security: ${imap.security}).` +
        (mailbox.provider === "proton-bridge"
          ? " Proton Mail Bridge's certificate is only valid for 127.0.0.1; reached by its Docker name, use security: none."
          : ""),
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
