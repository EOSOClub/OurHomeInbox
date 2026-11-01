// The REST API's requests and responses. The web app is one client of this
// API; OurHome and AI assistants will be others. Types only, shared by the
// server (src/server) and the web app (web/).
//
// Every route is under /api. Errors come back as ApiError with a 4xx/5xx
// status, `error` written in plain language for the household.
//
//   GET    /api/health                       HealthResponse            no sign-in
//   GET    /api/session                      SessionResponse           no sign-in
//   POST   /api/session                      LoginRequest -> SessionResponse (sets the session cookie)
//   DELETE /api/session                      -> 204 (clears the cookie)
//   POST   /api/setup                        SetupRequest -> SessionResponse; only while no user exists
//   GET    /api/captures                     CaptureListResponse
//   GET    /api/captures/:mailbox/:uidValidity/:uid               CaptureDetailResponse
//   GET    /api/captures/:mailbox/:uidValidity/:uid/raw           the raw .eml, as a download
//   GET    /api/captures/:mailbox/:uidValidity/:uid/attachments/:index   one attachment (1-based), as a download
//   GET    /api/captures/:mailbox/:uidValidity/:uid/choices/:field       FieldChoicesResponse; 409 when no biller matches
//   GET    /api/captures/:mailbox/:uidValidity/:uid/invoice              the invoice its link gave (PDF), as a download
//   GET    /api/status                       StatusResponse
//   PUT    /api/account/password             PasswordChangeRequest -> 204 (signs out your other sessions)
//   GET    /api/settings                     SettingsResponse
//   PUT    /api/settings                     SettingsInput -> SettingsResponse (admin; written to config.yml)
//   POST   /api/settings/reload              -> SettingsResponse (admin; reads config.yml again)
//   GET    /api/mailboxes                    MailboxListResponse
//   POST   /api/mailboxes                    MailboxInput -> MailboxInfo (201; admin)
//   PUT    /api/mailboxes/:id                MailboxInput -> MailboxInfo (admin)
//   DELETE /api/mailboxes/:id                -> 204 (admin; its captured mail stays on disk, to restore)
//   POST   /api/mailboxes/:id/restore        MailboxInput -> MailboxInfo (admin; a removed one, with its mail)
//   POST   /api/mailboxes/test               MailboxTestRequest -> MailboxTestResponse (admin)
//   POST   /api/mailboxes/check              -> CheckingState (reads every mailbox now)
//   GET    /api/billers                      BillerListResponse
//   POST   /api/billers                      BillerInput -> Biller (201)
//   GET    /api/billers/:id                  Biller
//   PUT    /api/billers/:id                  BillerInput -> Biller
//   DELETE /api/billers/:id                  -> 204
//   GET    /api/billers/:id/rules            BillerRulesResponse
//   PUT    /api/billers/:id/rules/:field     BillerRuleInput -> 204
//   DELETE /api/billers/:id/rules/:field     -> 204
//   GET    /api/tags                         TagListResponse
//   POST   /api/tags                         TagInput -> Tag (201)
//   PUT    /api/tags/:id                     TagInput -> Tag (renames it)
//   DELETE /api/tags/:id                     -> 204 (taken off every email)
//   POST   /api/captures/tags                CaptureTagsRequest -> CaptureTagsResponse (tags or untags emails)
//
// :mailbox is the mailbox's slug (CaptureListItem.mailboxSlug). :field is one
// of FIELDS (shared/extraction.ts). Billers and their rules, and tags, belong
// to the signed-in person's household.

import type { BillerKind } from "./billers.js";
import type { Capture, CapturedAddress } from "./capture.js";
import type { BillerRule, Extraction, ExtractionSummary, FieldChoice, FieldName } from "./extraction.js";
import type { InvoiceInfo, InvoiceOutcome } from "./invoice.js";
import type { SenderCheck } from "./sender.js";
import type { LogLevel, Provider, Security } from "./settings.js";

export interface ApiError {
  error: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
}

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  /** Can manage the whole install (the first account is one). */
  isAdmin: boolean;
  household: { id: number; name: string };
}

export interface SessionResponse {
  /** null when not signed in. */
  user: SessionUser | null;
  /** True while no account exists yet: the app shows first-time setup instead of sign-in. */
  setupNeeded: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** First-time setup: creates the household and its first (admin) account, and signs it in. */
export interface SetupRequest {
  householdName: string;
  name: string;
  email: string;
  /** At least MIN_PASSWORD_LENGTH characters. */
  password: string;
}

export const MIN_PASSWORD_LENGTH = 10;

export interface CaptureListItem {
  /** "<mailboxSlug>/<uidValidity>/<uid>", the path under /api/captures/. */
  id: string;
  mailbox: string;
  mailboxSlug: string;
  folder: string;
  uidValidity: string;
  uid: number;
  subject: string | null;
  from: CapturedAddress[];
  /** The email's own Date header (ISO), when it has a usable one. */
  date: string | null;
  /** When OurHomeInbox captured it (ISO). */
  capturedAt: string;
  attachmentCount: number;
  linkCount: number;
  hasText: boolean;
  hasHtml: boolean;
  /** The household's biller for this email's sender, or null when none matches. */
  biller: BillerMatch | null;
  /** True when the mail provider confirmed the email comes from the sender it shows (SenderCheck.verified). */
  senderVerified: boolean;
  /** What the reader picked out of it, in short. */
  picked: ExtractionSummary;
  /** The household's tags on it, by name. */
  tags: TagRef[];
}

/** Which biller an email was matched to, and on which of its senders. */
export interface BillerMatch {
  id: number;
  name: string;
  kind: BillerKind;
  /** The biller's sender the email's From address matched: an address, or a domain covering it. */
  matchedOn: string;
}

export interface CaptureListResponse {
  /** Newest first (by date, else capturedAt). */
  captures: CaptureListItem[];
}

export interface CaptureDetailResponse {
  id: string;
  mailboxSlug: string;
  capture: Capture;
  biller: BillerMatch | null;
  /** Whether it really comes from the sender it shows, as the mail provider checked it. */
  sender: SenderCheck;
  /** The invoice behind its "View Invoice" link, once that has been tried; null when it has not (or cannot be). */
  invoice: InvoiceInfo | null;
  /** What the reader picked out of it with its biller's rules, and where each value was found. */
  extraction: Extraction;
  /** The household's tags on it, by name. */
  tags: TagRef[];
}

/** What Fix offers for one value of one email. */
export interface FieldChoicesResponse {
  field: FieldName;
  biller: BillerMatch;
  /** The biller's rule for this field now, or null when the built-in reader decides. */
  rule: BillerRule | null;
  /** How many other captured emails come from this biller. */
  otherEmails: number;
  /** In the order they appear in the email. */
  choices: FieldChoice[];
}

/** One of the household's mailboxes. Never contains its password. */
export interface MailboxInfo {
  id: number;
  name: string;
  /** Its folder under data/mail, and its part of each email's address. Kept when renamed. */
  slug: string;
  provider: Provider;
  /** The folder in the mailbox that is read. */
  folder: string;
  imap: {
    host: string;
    port: number;
    security: Security;
    username: string;
    passwordSet: boolean;
    /** Why a saved password cannot be used (such as a changed secret key), or null. */
    passwordProblem: string | null;
  };
  /** False while paused: it is not read. */
  enabled: boolean;
  /** How the last read went, or null before the first. */
  lastCheck: { at: string; ok: boolean; message: string; captured: number } | null;
  /** When it was last read without a problem, or null when never. */
  lastOkAt: string | null;
  /** When it started failing every read (null while reads work). */
  failingSince: string | null;
  createdAt: string;
  updatedAt: string;
}

/** When mail is read. */
export interface CheckingState {
  everyMinutes: number;
  /** True while mailboxes are being read. */
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  /** When the next read starts, or null while one is running. */
  nextAt: string | null;
}

/** A removed mailbox, kept so it can be restored with its captured mail. Its password was not kept. */
export interface RemovedMailbox {
  id: number;
  name: string;
  slug: string;
  provider: Provider;
  folder: string;
  /** Its server and login, or null when they are not known (a mailbox removed before removed ones were kept, found on disk). */
  imap: { host: string; port: number; security: Security; username: string } | null;
  /** How many captured emails come back when it is restored. */
  emails: number;
  removedAt: string;
}

export interface MailboxListResponse {
  mailboxes: MailboxInfo[];
  /** Removed mailboxes that can be restored, with their mail. */
  removed: RemovedMailbox[];
  checking: CheckingState;
  /** True when the signed-in person may add and change mailboxes. */
  canEdit: boolean;
}

/** Adding or changing a mailbox. `password` left out (or empty) keeps the saved one. */
export interface MailboxInput {
  name: string;
  provider: Provider;
  host: string;
  port: number;
  security: Security;
  username: string;
  password?: string;
  folder: string;
  enabled?: boolean;
}

/** Trying a mailbox's settings before saving them. With `id` and no password, that mailbox's saved password is used. */
export interface MailboxTestRequest {
  id?: number;
  provider: Provider;
  host: string;
  port: number;
  security: Security;
  username: string;
  password?: string;
  folder: string;
}

export interface MailboxTestResponse {
  ok: boolean;
  /** What happened, in plain words. */
  message: string;
  /** Every folder in the mailbox, when it could sign in. */
  folders: string[];
  /** Messages in the chosen folder, when it exists. */
  messages: number | null;
}

/** The install's settings (config.yml). Never contains a secret. */
export interface SettingsResponse {
  /** Where config.yml is. */
  configPath: string;
  logLevel: LogLevel;
  captureEveryMinutes: number;
  web: { port: number };
  /** config.yml's docker section, read by docker/deploy.sh. */
  docker: { network: string | null; port: number | null; bind: string | null } | null;
  /** True when the signed-in person may change these (an admin). */
  canEdit: boolean;
  /** Settings in config.yml that differ from what is running and only take effect after docker/deploy.sh, in plain words. */
  needsRestart: string[];
  /** Mailboxes still listed in config.yml after they were copied into the database (they are not read). */
  ignoredMailboxes: number;
  /** Where the key that protects saved passwords comes from. */
  secretKey: "env" | "file";
}

/** Changing the install's settings; both are written to config.yml. */
export interface SettingsInput {
  logLevel: LogLevel;
  captureEveryMinutes: number;
}

/** One email's invoice link, as tried. */
export interface InvoiceActivity {
  /** The email, as CaptureListItem.id. */
  captureId: string;
  subject: string | null;
  /** Who sent it: the first From name, else its address. */
  sender: string;
  outcome: InvoiceOutcome;
  reason: string;
  triedAt: string;
  /** True while a passing failure will be tried again. */
  retrying: boolean;
}

/** A warning or error from the log. */
export interface StatusProblem {
  at: string;
  level: "warn" | "error";
  message: string;
}

/** Whether OurHomeInbox is working, for the Status page. */
export interface StatusResponse {
  version: string;
  /** When this run of OurHomeInbox started. */
  startedAt: string;
  checking: CheckingState;
  /** The household's mailboxes, with how each last read went. */
  mailboxes: MailboxInfo[];
  invoices: {
    /** The household's emails by what their invoice link gave. "failed" counts only links that will not be tried again. */
    counts: Record<InvoiceOutcome, number>;
    /** Links that failed for a passing reason and will be tried again. */
    retrying: number;
    /** The latest tries, newest first. */
    recent: InvoiceActivity[];
  };
  /** Recent warnings and errors since the start, newest first. Admins only (they can name any household's mailbox); null for others. */
  problems: StatusProblem[] | null;
  canEdit: boolean;
}

/** Changing your own sign-in password. Signs out your other sessions. */
export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
}

export interface Biller {
  id: number;
  name: string;
  kind: BillerKind;
  /** Addresses and domains its emails come from, as stored (see shared/billers.ts). */
  senders: string[];
  notes: string;
  /** Get the invoice behind its emails' "View Invoice" links (see invoices.ts). */
  fetchInvoices: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Adding or changing a biller. Senders are normalized and repeats dropped; see shared/billers.ts for the rules. */
export interface BillerInput {
  name: string;
  kind: BillerKind;
  senders: string[];
  notes?: string;
  /** On when left out. */
  fetchInvoices?: boolean;
}

export interface BillerListResponse {
  /** By name. */
  billers: Biller[];
}

export interface BillerRuleItem extends BillerRule {
  createdAt: string;
  /** How many of the biller's emails this rule picked a value in. */
  usedOn: number;
}

export interface BillerRulesResponse {
  /** In the order fields are shown. */
  rules: BillerRuleItem[];
  /** How many captured emails come from this biller. */
  emails: number;
}

/** Saving a rule: the words the value comes after, as chosen in Fix. */
export interface BillerRuleInput {
  label: string;
}

/** A tag as an email carries it. */
export interface TagRef {
  id: number;
  name: string;
}

/** One of the household's tags. */
export interface Tag extends TagRef {
  /** How many of the household's emails carry it (in mailboxes that are set up). */
  emails: number;
  createdAt: string;
  updatedAt: string;
}

export interface TagListResponse {
  /** By name. */
  tags: Tag[];
}

/** Adding or renaming a tag. The name is tidied (see shared/tags.ts); one the household already has, ignoring case, is refused. */
export interface TagInput {
  name: string;
}

/**
 * Tagging or untagging emails, all or nothing. `add` names tags (one the
 * household does not have yet is made); `remove` gives tag ids. At least one
 * of the two, and at most MAX_TAGGED_AT_ONCE emails (shared/tags.ts).
 */
export interface CaptureTagsRequest {
  /** As CaptureListItem.id. */
  captureIds: string[];
  add?: string[];
  remove?: number[];
}

export interface CaptureTagsResponse {
  /** Each email asked about, with its tags now. */
  captures: Array<{ id: string; tags: TagRef[] }>;
  /** Tags made by this change (named in `add` but new to the household). */
  created: TagRef[];
}
