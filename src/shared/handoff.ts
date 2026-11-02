// The hand-off to OurHome: the contract both projects build to (the vault's
// "Hand-off" note, section 6), and what the web app shows about it. Types and
// limits only, so the web app can use them too; the work is in
// src/server/handoff/routes.ts and src/server/handoff/rules.ts.
//
// OurHome asks with its token:
//   GET  /api/handoff/hello                        HandoffHelloResponse
//   GET  /api/handoff/documents?after=<n>&limit=<m> HandoffDocumentsResponse
//   POST /api/handoff/changes                      HandoffChangesRequest -> HandoffChangesResponse (contract v2)

/** How many Checked emails in a row, with nothing fixed, before Send automatically is offered (owner, 2026-11-01). */
export const CHECKS_BEFORE_AUTO = 3;

/** Documents per reply: the default, and the most OurHome may ask for. */
export const HANDOFF_DEFAULT_LIMIT = 100;
export const HANDOFF_MAX_LIMIT = 200;

/** Every token starts with this, then 43 base64url characters. */
export const TOKEN_PREFIX = "ohi_";

/**
 * OurHome's own limits on each text field (`billIngestSchema` in OurHomeWeb's
 * src/lib/validation/billIngest.ts). A value longer than its limit is left
 * out, so OurHome never refuses the whole document over one field.
 */
export const OURHOME_LIMITS = {
  messageId: 998,
  biller: 200,
  billerEmail: 320,
  subject: 998,
  invoiceNo: 120,
  confirmationNo: 120,
  accountNo: 120,
  billerKey: 200,
  /** Contract v2: an invoice number (within its own limit) or "ohi:" and 24 hex characters. */
  reference: 120,
} as const;

/** Change reports per request (contract v2). */
export const HANDOFF_MAX_CHANGES = 100;

/** OurHome's limit on any amount. */
export const OURHOME_MAX_AMOUNT = 10_000_000;

/**
 * One email as OurHome's importer takes it (a subset of `billIngestSchema`).
 * A field OurHomeInbox does not know is left out, never null. OurHome adds
 * `sourceUrl` itself, from its public address for OurHomeInbox and `link`.
 */
export interface HandoffDocument {
  kind: "bill" | "receipt";
  messageId: string;
  biller?: string;
  billerKey?: string;
  billerEmail?: string;
  subject?: string;
  amount?: number;
  fee?: number;
  baseAmount?: number;
  /** A day, "2026-11-04". */
  dueDate?: string;
  /** A day, "2026-10-26". */
  paidDate?: string;
  /** The email's own date, a full ISO time. */
  emailDate?: string;
  invoiceNo?: string;
  confirmationNo?: string;
  accountNo?: string;
  /**
   * Contract v2. A bill's: its invoice number, else "ohi:" and the first 24
   * hex characters of the SHA-256 of its messageId. A paired receipt's: its
   * bill's. A receipt without one was marked Paid on its own.
   */
  reference?: string;
  /** Contract v2: on a paired receipt OurHomeInbox judged late; left out otherwise. */
  paidLate?: true;
}

/** Contract v2: what a person did to an email bill in OurHome. */
export interface HandoffChange {
  /** The bill's messageId as offered (OurHome's sourceMessageId). */
  messageId: string;
  /** paid: a payment recorded by hand left it fully paid. removed: a person deleted it (not a withdrawal). */
  change: "paid" | "removed";
  /** A full ISO time. */
  at: string;
}

export interface HandoffChangesRequest {
  /** 1 to HANDOFF_MAX_CHANGES. */
  changes: HandoffChange[];
}

export interface HandoffChangesResponse {
  accepted: number;
  /** messageIds this household never offered: dropped, not an error. */
  unknown: number;
}

interface EntryBase {
  /** Rises with every offer; an email offered again gets a new, higher one. */
  number: number;
  captureId: string;
  /** The email's page in OurHomeInbox, to put after its public address. */
  link: string;
}

export interface HandoffReadyEntry extends EntryBase {
  status: "ready";
  document: HandoffDocument;
}

/** An email offered as ready before that no longer qualifies. */
export interface HandoffWithdrawnEntry extends EntryBase {
  status: "withdrawn";
  messageId: string;
  /** For the household, in plain words. */
  reason: string;
}

export type HandoffEntry = HandoffReadyEntry | HandoffWithdrawnEntry;

export interface HandoffDocumentsResponse {
  documents: HandoffEntry[];
  /** Send as `after` next time; keep it only once every document is handled. */
  next: number;
  /** True when there are more after `next`: ask again straight away. */
  more: boolean;
}

export interface HandoffHelloResponse {
  household: string;
  /** The highest document number so far, 0 when none. */
  newest: number;
  /** Emails dated before this day are never offered. */
  startDate: string;
}

// ---------------------------------------------------------------------------
// What the web app shows

/**
 * - goes: it qualifies for OurHome now.
 * - waits: a person can make it qualify (mark it Checked, or Fix its amount).
 * - never: it is not for OurHome (a reminder, a statement, a credit, Not a bill, or from before the start date).
 */
export type HandoffState = "goes" | "waits" | "never";

/** An email's place in the hand-off, for its page, the list and Status. */
export interface HandoffInfo {
  state: HandoffState;
  /** Why, in plain words: "Checked by Sam.", "Waits for someone to mark it Checked: ...". */
  reason: string;
  /** Whether the household has an OurHome connection (a token) at all. */
  connected: boolean;
  /** What was last offered to OurHome about it, or null when nothing was. */
  offered: { status: "ready" | "withdrawn"; number: number; at: string; taken: boolean } | null;
}

/** The household's OurHome connection, for Settings. Never the token itself. */
export interface OurHomeConnection {
  /** True while a token exists. */
  connected: boolean;
  /** Emails dated before this day are never offered; null before the first token. */
  startDate: string | null;
  tokenCreatedAt: string | null;
  /** Who made the token, or null when that account is gone. */
  tokenCreatedBy: string | null;
  /** When OurHome last used the token. */
  lastUsedAt: string | null;
  /** The highest document number OurHome has said it handled. */
  takenUpTo: number;
  /** The highest document number offered so far. */
  newest: number;
}

/** Making a token: a new one replaces the old, which stops working at once. */
export interface OurHomeTokenRequest {
  /** "2026-11-01"; kept as it is when a start date is already set and this is left out. */
  startDate?: string;
}

/** The new token, shown once. */
export interface OurHomeTokenResponse {
  token: string;
  connection: OurHomeConnection;
}

export interface OurHomeConnectionUpdate {
  startDate: string;
}

/** Turning Send automatically on or off for a biller (also "Not now", which is off). */
export interface AutoSendRequest {
  autoSend: boolean;
}
