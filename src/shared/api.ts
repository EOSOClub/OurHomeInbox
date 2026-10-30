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
//   GET    /api/settings                     SettingsResponse
//   GET    /api/billers                      BillerListResponse
//   POST   /api/billers                      BillerInput -> Biller (201)
//   GET    /api/billers/:id                  Biller
//   PUT    /api/billers/:id                  BillerInput -> Biller
//   DELETE /api/billers/:id                  -> 204
//
// :mailbox is the mailbox's slug (CaptureListItem.mailboxSlug). Billers
// belong to the signed-in person's household.

import type { BillerKind } from "./billers.js";
import type { Capture, CapturedAddress } from "./capture.js";
import type { Extraction, ExtractionSummary } from "./extraction.js";

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
  /** What the reader picked out of it, in short. */
  picked: ExtractionSummary;
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
  /** What the reader picked out of it, and where each value was found. */
  extraction: Extraction;
}

export interface SettingsMailbox {
  name: string;
  slug: string;
  provider: string;
  folder: string;
  imap: {
    host: string;
    port: number;
    security: string;
    username: string;
    /** The .env line holding the password. The password itself is never sent. */
    passwordEnv: string;
    passwordSet: boolean;
  };
}

/** The settings in use, read-only for now. Never contains a secret. */
export interface SettingsResponse {
  /** Where config.yml was read from. */
  configPath: string;
  logLevel: string;
  web: { port: number };
  capture: { everyMinutes: number };
  mailboxes: SettingsMailbox[];
}

export interface Biller {
  id: number;
  name: string;
  kind: BillerKind;
  /** Addresses and domains its emails come from, as stored (see shared/billers.ts). */
  senders: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** Adding or changing a biller. Senders are normalized and repeats dropped; see shared/billers.ts for the rules. */
export interface BillerInput {
  name: string;
  kind: BillerKind;
  senders: string[];
  notes?: string;
}

export interface BillerListResponse {
  /** By name. */
  billers: Biller[];
}
