// The hand-off's records (migration 10): each household's OurHome connection
// and token, and what was last offered to OurHome about each email.
//
// A token is shown once and kept only as its SHA-256, as sign-in sessions are
// (auth.ts), so a copied database cannot be used to read the feed. Offers get
// a number that rises with every offer; OurHome asks for everything after the
// last number it handled. An email that changes is offered again with a new
// number; one that stops qualifying after it was offered is offered once more
// as withdrawn. An email that is simply missing (its mailbox removed) is left
// as it was, so removing a mailbox never takes bills back from OurHome.

import { createHash, randomBytes } from "node:crypto";
import { TOKEN_PREFIX, type HandoffDocument, type HandoffEntry, type OurHomeConnection } from "../../shared/handoff.js";
import { hashToken } from "../auth.js";
import type { Database } from "../db.js";
import type { HandoffDecision } from "./rules.js";

interface ConnectionRow {
  household_id: number;
  token_hash: string | null;
  start_date: string;
  token_created_at: string | null;
  token_created_by: number | null;
  last_used_at: string | null;
  taken_up_to: number;
}

export interface OfferRow {
  capture_id: string;
  number: number;
  status: "ready" | "withdrawn";
  message_id: string;
  fingerprint: string;
  document: string | null;
  reason: string | null;
  offered_at: string;
}

/** The household's connection row, or undefined before its first token. */
export function connectionRow(db: Database, householdId: number): ConnectionRow | undefined {
  return db.get<ConnectionRow>("SELECT * FROM handoff_connections WHERE household_id = ?", householdId);
}

/** The household whose live token this is, or null. */
export function householdForToken(db: Database, token: string): number | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  return db.get<{ household_id: number }>("SELECT household_id FROM handoff_connections WHERE token_hash = ?", hashToken(token))?.household_id ?? null;
}

/** The start date that applies to offers: null when the household has no live token. */
export function liveStartDate(db: Database, householdId: number): string | null {
  const row = connectionRow(db, householdId);
  return row && row.token_hash !== null ? row.start_date : null;
}

export function newestNumber(db: Database, householdId: number): number {
  return db.get<{ n: number | null }>("SELECT max(number) AS n FROM handoff_offers WHERE household_id = ?", householdId)?.n ?? 0;
}

export function connectionInfo(db: Database, householdId: number): OurHomeConnection {
  const row = connectionRow(db, householdId);
  const createdBy = row?.token_created_by == null ? null : (db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", row.token_created_by)?.name ?? null);
  return {
    connected: row?.token_hash != null,
    startDate: row?.start_date ?? null,
    tokenCreatedAt: row?.token_hash != null ? row.token_created_at : null,
    tokenCreatedBy: row?.token_hash != null ? createdBy : null,
    lastUsedAt: row?.last_used_at ?? null,
    takenUpTo: row?.taken_up_to ?? 0,
    newest: newestNumber(db, householdId),
  };
}

/** Makes a new token for the household, replacing any old one, and returns it (the only time it is seen). */
export function createToken(db: Database, householdId: number, userId: number, startDate: string | undefined, now: Date): string {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const stamp = now.toISOString();
  db.transaction(() => {
    const row = connectionRow(db, householdId);
    if (row) {
      db.run(
        "UPDATE handoff_connections SET token_hash = ?, start_date = ?, token_created_at = ?, token_created_by = ? WHERE household_id = ?",
        hashToken(token),
        startDate ?? row.start_date,
        stamp,
        userId,
        householdId,
      );
    } else {
      db.run(
        "INSERT INTO handoff_connections (household_id, token_hash, start_date, token_created_at, token_created_by) VALUES (?, ?, ?, ?, ?)",
        householdId,
        hashToken(token),
        startDate ?? stamp.slice(0, 10),
        stamp,
        userId,
      );
    }
  });
  return token;
}

/** Stops the token working. The start date and what was offered are kept, for a later token. False when there was none. */
export function revokeToken(db: Database, householdId: number): boolean {
  return db.run("UPDATE handoff_connections SET token_hash = NULL WHERE household_id = ? AND token_hash IS NOT NULL", householdId).changes > 0;
}

/** False when the household has never had a token (there is no start date to change). */
export function setStartDate(db: Database, householdId: number, startDate: string): boolean {
  return db.run("UPDATE handoff_connections SET start_date = ? WHERE household_id = ?", startDate, householdId).changes > 0;
}

/** What was last offered about each of the household's emails, by capture id. */
export function householdOffers(db: Database, householdId: number): Map<string, OfferRow> {
  return new Map(db.all<OfferRow>("SELECT * FROM handoff_offers WHERE household_id = ?", householdId).map((row) => [row.capture_id, row]));
}

/** The same document always gives the same fingerprint (its fields are written in a fixed order). */
function fingerprint(document: HandoffDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

/** One email's decision, in the order offers should be numbered (oldest first). */
export interface DecidedEmail {
  captureId: string;
  decision: HandoffDecision;
}

/**
 * Brings the offers up to date with the emails' decisions: a new or changed
 * document gets a new number; one offered before that is now never to go
 * (Not a bill, a reminder, a statement, a credit, or dated before the start
 * date) is withdrawn once. One that merely waits for a person now (its
 * biller's Send automatically turned off, say) keeps its last offer: OurHome
 * keeps what it has, and waiting only holds back what is new (section 2).
 * Emails not given are left alone. Returns how many offers changed.
 */
export function applyDecisions(db: Database, householdId: number, emails: readonly DecidedEmail[], now: Date): number {
  const stamp = now.toISOString();
  return db.transaction(() => {
    const offers = householdOffers(db, householdId);
    let next = newestNumber(db, householdId) + 1;
    let changed = 0;
    for (const { captureId, decision } of emails) {
      const offer = offers.get(captureId);
      if (decision.state === "goes" && decision.document) {
        const print = fingerprint(decision.document);
        if (offer?.status === "ready" && offer.fingerprint === print) continue;
        db.run(
          `INSERT INTO handoff_offers (household_id, capture_id, number, status, message_id, fingerprint, document, reason, offered_at)
           VALUES (?, ?, ?, 'ready', ?, ?, ?, NULL, ?)
           ON CONFLICT (household_id, capture_id) DO UPDATE SET number = excluded.number, status = 'ready', message_id = excluded.message_id,
             fingerprint = excluded.fingerprint, document = excluded.document, reason = NULL, offered_at = excluded.offered_at`,
          householdId,
          captureId,
          next++,
          decision.document.messageId,
          print,
          JSON.stringify(decision.document),
          stamp,
        );
        changed++;
      } else if (decision.state === "never" && offer?.status === "ready") {
        db.run(
          // The last document is kept (offersAfter never sends it for a withdrawn email): a bill's reference stays the one it first went with.
          "UPDATE handoff_offers SET number = ?, status = 'withdrawn', reason = ?, offered_at = ? WHERE household_id = ? AND capture_id = ?",
          next++,
          decision.reason,
          stamp,
          householdId,
          captureId,
        );
        changed++;
      }
    }
    return changed;
  });
}

/** The page of an email in OurHomeInbox, for OurHome's links. */
export function emailLink(captureId: string): string {
  return `/mail/${captureId.split("/").map(encodeURIComponent).join("/")}`;
}

/** Offers after `after`, oldest first, at most `limit`, and whether more follow. */
export function offersAfter(db: Database, householdId: number, after: number, limit: number): { entries: HandoffEntry[]; more: boolean } {
  const rows = db.all<OfferRow>(
    "SELECT * FROM handoff_offers WHERE household_id = ? AND number > ? ORDER BY number LIMIT ?",
    householdId,
    after,
    limit + 1,
  );
  const entries = rows.slice(0, limit).map((row): HandoffEntry => {
    const base = { number: row.number, captureId: row.capture_id, link: emailLink(row.capture_id) };
    return row.status === "ready"
      ? { ...base, status: "ready", document: JSON.parse(row.document ?? "{}") as HandoffDocument }
      : { ...base, status: "withdrawn", messageId: row.message_id, reason: row.reason ?? "" };
  });
  return { entries, more: rows.length > limit };
}

/** OurHome asked: it has handled everything up to `after`, and used its token now. */
export function noteAsked(db: Database, householdId: number, after: number, now: Date): void {
  db.run(
    "UPDATE handoff_connections SET last_used_at = ?, taken_up_to = max(taken_up_to, ?) WHERE household_id = ?",
    now.toISOString(),
    after,
    householdId,
  );
}
