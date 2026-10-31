// What the mailbox pages share: the add/change form and its checks (the same
// rules the server applies), the choices offered, and how a mailbox's last
// read and the reading schedule are put in words.

import type { CheckingState, MailboxInfo, MailboxInput, MailboxTestRequest, RemovedMailbox } from "../../src/shared/api";
import {
  MAX_MAILBOX_FOLDER,
  MAX_MAILBOX_HOST,
  MAX_MAILBOX_NAME,
  MAX_MAILBOX_PASSWORD,
  MAX_MAILBOX_USERNAME,
  type LogLevel,
  type Provider,
  type Security,
} from "../../src/shared/settings";
import type { Choice } from "./components/ui";
import { formatDateTime } from "./format";

export const PROVIDER_LABELS: Record<Provider, string> = { "proton-bridge": "Proton Mail Bridge" };

export const SECURITY_CHOICES: ReadonlyArray<Choice<Security>> = [
  { value: "none", label: "None", description: "No encryption. Only for a Bridge on this computer or the same Docker network." },
  { value: "starttls", label: "STARTTLS", description: "Connects, then switches to encryption." },
  { value: "tls", label: "TLS", description: "Encrypted from the start (also called SSL/TLS), usually port 993." },
];

export const LOG_LEVEL_CHOICES: ReadonlyArray<Choice<LogLevel>> = [
  { value: "debug", label: "Everything", description: "For finding a problem: the log says a lot." },
  { value: "info", label: "Normal", description: "What OurHomeInbox does, and any problems." },
  { value: "warn", label: "Warnings", description: "Only warnings and errors." },
  { value: "error", label: "Errors", description: "Only errors." },
];

export interface MailboxForm {
  name: string;
  provider: Provider;
  host: string;
  /** As typed. */
  port: string;
  security: Security | null;
  username: string;
  /** Empty when changing a mailbox means "keep the saved one". */
  password: string;
  folder: string;
  enabled: boolean;
}

export type MailboxFormErrors = Partial<Record<keyof MailboxForm, string>>;

export const EMPTY_MAILBOX_FORM: MailboxForm = {
  name: "",
  provider: "proton-bridge",
  host: "",
  port: "",
  security: null,
  username: "",
  password: "",
  folder: "",
  enabled: true,
};

/** The form for changing a saved mailbox: its settings, with the password left empty (kept unless typed). */
export function formFromMailbox(mailbox: MailboxInfo): MailboxForm {
  return {
    name: mailbox.name,
    provider: mailbox.provider,
    host: mailbox.imap.host,
    port: String(mailbox.imap.port),
    security: mailbox.imap.security,
    username: mailbox.imap.username,
    password: "",
    folder: mailbox.folder,
    enabled: mailbox.enabled,
  };
}

/** The form for restoring a removed mailbox: what was kept of it. Its password was not kept, and a mailbox found on disk has no server yet. */
export function formFromRemoved(mailbox: RemovedMailbox): MailboxForm {
  return {
    ...EMPTY_MAILBOX_FORM,
    name: mailbox.name,
    provider: mailbox.provider,
    folder: mailbox.folder,
    ...(mailbox.imap
      ? { host: mailbox.imap.host, port: String(mailbox.imap.port), security: mailbox.imap.security, username: mailbox.imap.username }
      : {}),
  };
}

/** "36 emails", for a removed mailbox's captured mail. */
export function emailCount(count: number): string {
  return count === 1 ? "1 email" : `${count} emails`;
}

const HOST = /^[A-Za-z0-9._:[\]-]+$/;

/** True when the form names the server and login the mailbox's password was saved for (as the server checks). */
export function sameServer(form: MailboxForm, saved: MailboxInfo): boolean {
  return (
    form.provider === saved.provider &&
    form.host.trim().toLowerCase() === saved.imap.host.toLowerCase() &&
    Number(form.port.trim()) === saved.imap.port &&
    form.security === saved.imap.security &&
    form.username.trim() === saved.imap.username
  );
}

/** Whether the saved password can stand in for an empty password box: only for the server it was saved for. */
function savedPasswordUsable(form: MailboxForm, saved: MailboxInfo | null): boolean {
  return saved !== null && saved.imap.passwordSet && sameServer(form, saved);
}

/**
 * The connection's problems (everything but the name), or the settings to try.
 * `saved`: the mailbox being changed, whose saved password is used when none
 * is typed, as long as the server and login are the same.
 */
export function checkConnection(form: MailboxForm, saved: MailboxInfo | null): { errors: MailboxFormErrors; connection: Omit<MailboxTestRequest, "id"> | null } {
  const passwordSaved = savedPasswordUsable(form, saved);
  const errors: MailboxFormErrors = {};
  const host = form.host.trim();
  if (!host) errors.host = "Enter the IMAP server's address.";
  else if (host.length > MAX_MAILBOX_HOST) errors.host = "That server address is too long.";
  else if (!HOST.test(host)) errors.host = "Enter just the server's name or address, like 127.0.0.1 or protonmail-bridge, with no spaces or slashes.";
  const portText = form.port.trim();
  const port = Number(portText);
  if (!portText) errors.port = "Enter the IMAP port, like 1143.";
  else if (!/^\d+$/.test(portText) || port < 1 || port > 65535) errors.port = "The port must be a whole number between 1 and 65535.";
  if (form.security === null) errors.security = "Choose how the connection is protected.";
  const username = form.username.trim();
  if (!username) errors.username = "Enter the IMAP username.";
  else if (username.length > MAX_MAILBOX_USERNAME) errors.username = "That username is too long.";
  if (!form.password && !passwordSaved) {
    errors.password =
      saved?.imap.passwordSet && !sameServer(form, saved)
        ? "Enter the password again: the server, port, security or username changed, and a saved password is only sent to the server it was saved for."
        : "Enter the IMAP password.";
  }
  else if (form.password.length > MAX_MAILBOX_PASSWORD) errors.password = "That password is too long.";
  const folder = form.folder.trim();
  if (!folder) errors.folder = "Enter the folder to read, like INBOX or Folders/Bills.";
  else if (folder.length > MAX_MAILBOX_FOLDER) errors.folder = "That folder name is too long.";

  if (Object.keys(errors).length > 0 || form.security === null) return { errors, connection: null };
  return {
    errors,
    connection: {
      provider: form.provider,
      host,
      port,
      security: form.security,
      username,
      ...(form.password ? { password: form.password } : {}),
      folder,
    },
  };
}

/** The whole form's problems, or the request to send. `saved`: the mailbox being changed, or null when adding one. */
export function checkMailboxForm(form: MailboxForm, saved: MailboxInfo | null): { errors: MailboxFormErrors; input: MailboxInput | null } {
  const { errors, connection } = checkConnection(form, saved);
  const name = form.name.trim();
  if (!name) errors.name = "Enter a name for the mailbox.";
  else if (name.length > MAX_MAILBOX_NAME) errors.name = `Keep the name under ${MAX_MAILBOX_NAME} characters.`;
  else if (!/[\p{L}\p{N}]/u.test(name)) errors.name = "The name needs at least one letter or number.";
  if (Object.keys(errors).length > 0 || connection === null) return { errors, input: null };
  return { errors, input: { name, ...connection, enabled: form.enabled } };
}

/** How the mailbox's last read went, in a few words. */
export function lastCheckLine(mailbox: MailboxInfo): string {
  if (!mailbox.enabled) return "Paused: not read until it is turned back on.";
  const last = mailbox.lastCheck;
  if (!last) return "Not read yet.";
  return `${last.ok ? "Read" : "Problem"} ${formatDateTime(last.at)}: ${last.message}`;
}

/** When mail is read, in a sentence. */
export function checkingLine(state: CheckingState): string {
  const every = state.everyMinutes === 1 ? "every minute" : `every ${state.everyMinutes} minutes`;
  if (state.running) return `Reading mail now. Mail is read ${every}.`;
  const next = state.nextAt ? ` Next read: ${formatDateTime(state.nextAt)}.` : "";
  return `Mail is read ${every}.${next}`;
}
